/**
 * Standings (live timing tower rows) and the final SessionResult: race classification with unserved time penalties
 * applied (finishers by laps then total time, then unfinished cars by distance, then retirements, then disqualified
 * cars), zh-TW gap texts,
 * POINTS_TABLE points for classified finishers of races, fastest lap flag and story objective evaluation.
 */
import type { CarEntry, ResultRow, SessionResult, StandingRow, StoryObjective, WorldState } from '../core/types';
import { POINTS_TABLE, SPRINT_POINTS } from '../core/defaults';
import { formatGap, formatLapTime } from '../core/math';
import { compareFinishers, raceTotal, unservedPenalty } from './classification';
import { fin } from './events';

/** 3723.4 → "1:02:03.400"; under an hour like formatLapTime. */
export function formatRaceTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '--:--.---';
  if (sec < 3600) return formatLapTime(sec);
  const totalMs = Math.round(sec * 1000);
  const h = Math.floor(totalMs / 3_600_000);
  const m = Math.floor((totalMs % 3_600_000) / 60_000);
  const rest = formatLapTime((totalMs % 60_000) / 1000);
  return `${h}:${String(m).padStart(2, '0')}:${rest.slice(rest.indexOf(':') + 1)}`;
}

function orderedCars(world: WorldState): CarEntry[] {
  const seen = new Set<number>();
  const out: CarEntry[] = [];
  for (const id of world.race.order) {
    const c = world.cars[id];
    if (c && !seen.has(id)) {
      seen.add(id);
      out.push(c);
    }
  }
  for (const c of world.cars) if (!seen.has(c.id)) out.push(c);
  return out;
}

/** Live classification for the HUD timing tower. */
export function standings(world: WorldState): StandingRow[] {
  return orderedCars(world).map((c, i) => ({
    carId: c.id,
    position: c.timing.position > 0 ? c.timing.position : i + 1,
    abbr: c.abbr,
    displayName: c.displayName,
    teamId: c.teamId,
    livery: { ...c.livery },
    lap: c.timing.lap,
    gapToLeader: fin(c.timing.gapToLeader),
    interval: fin(c.timing.interval),
    lapsDown: c.timing.lapsDown,
    lastLap: c.timing.lastLap,
    bestLap: c.timing.bestLap,
    compound: c.phys.tire.compound,
    tyreWear: fin(c.phys.tire.wear),
    inPit: c.pit.phase !== 'none',
    status: c.status,
    isPlayer: c.playerIndex !== -1,
    penaltySec: unservedPenalty(c),
  }));
}

function raceClassification(world: WorldState): CarEntry[] {
  const cars = world.cars;
  const dq = (c: CarEntry): boolean => c.penalties.disqualified === true;
  const byProgress = (a: CarEntry, b: CarEntry): number => b.timing.progress - a.timing.progress || a.id - b.id;
  const finished = cars.filter((c) => c.status === 'finished' && c.timing.finishTime !== null && !dq(c));
  finished.sort((a, b) => compareFinishers(world, a, b));
  const running = cars.filter((c) => c.status !== 'retired' && !finished.includes(c) && !dq(c)).sort(byProgress);
  const retired = cars.filter((c) => c.status === 'retired' && !dq(c)).sort(byProgress);
  return [...finished, ...running, ...retired, ...cars.filter(dq).sort(byProgress)];
}

function timedClassification(world: WorldState): CarEntry[] {
  return [...world.cars].sort((a, b) => {
    const ba = a.timing.bestLap ?? Infinity;
    const bb = b.timing.bestLap ?? Infinity;
    if (ba !== bb) return ba - bb;
    return a.timing.gridPosition - b.timing.gridPosition || a.id - b.id;
  });
}

/** Story objective for player 0 (same semantics as the menus' evaluator). */
export function evaluateObjective(objective: StoryObjective, rows: ResultRow[], kind: string): boolean {
  const row = rows.find((r) => r.playerIndex === 0);
  if (!row) return false;
  const finished = row.status !== 'retired' && row.disqualified !== true && row.position >= 1;
  switch (objective.kind) {
    case 'finishAtOrAbove':
      return finished && row.position <= objective.value;
    case 'gainPositions':
      return finished && row.gridPosition > 0 && row.gridPosition - row.position >= objective.value;
    case 'beatDriver': {
      if (!finished) return false;
      const other = rows.find((r) => r.driverId === objective.driverId);
      return !other || other.status === 'retired' || row.position < other.position;
    }
    case 'lapUnder': {
      const best = row.bestLap ?? (kind !== 'race' ? row.time : null);
      return best !== null && Number.isFinite(best) && best > 0 && best <= objective.value;
    }
    case 'noPenalties':
      return finished && row.penaltySec <= 0;
  }
}

/** Final classification (call when isSessionOver; also safe mid-session). */
export function sessionResult(world: WorldState): SessionResult {
  const race = world.session.kind === 'race';
  const ordered = race ? raceClassification(world) : timedClassification(world);
  const fastestId = world.session.fastestLap?.carId ?? -1;
  const winner = ordered[0] ?? null;
  const winnerTotal = winner ? raceTotal(world, winner) : null;
  const leaderBest = winner ? winner.timing.bestLap : null;
  const length = world.race.cpCount * world.race.cpSpacing;

  const rows: ResultRow[] = ordered.map((car, i) => {
    const position = i + 1;
    const t = car.timing;
    let time: number | null;
    let gapText: string;
    const dq = car.penalties.disqualified === true;
    if (race) {
      time = raceTotal(world, car);
      if (dq) gapText = '取消資格';
      else if (car.status === 'retired') gapText = '退賽';
      else if (i === 0) gapText = time !== null ? formatRaceTime(time) : `${t.lapsCompleted} 圈`;
      else if (winner && time !== null && winnerTotal !== null && t.lapsCompleted === winner.timing.lapsCompleted) {
        gapText = formatGap(time - winnerTotal);
      } else {
        const down = winner
          ? time !== null
            ? winner.timing.lapsCompleted - t.lapsCompleted
            : Math.floor(Math.max(0, winner.timing.progress - t.progress) / Math.max(1, length))
          : 0;
        gapText = down >= 1 ? `+${down} 圈` : '未完賽';
      }
    } else {
      time = t.bestLap;
      if (time === null) gapText = '無成績';
      else if (i === 0 || leaderBest === null) gapText = formatLapTime(time);
      else gapText = formatGap(time - leaderBest);
    }
    return {
      carId: car.id,
      driverId: car.driverId,
      teamId: car.teamId,
      playerIndex: car.playerIndex,
      position,
      gridPosition: t.gridPosition,
      lapsCompleted: t.lapsCompleted,
      time,
      gapText,
      bestLap: t.bestLap,
      pitStops: car.pit.stops,
      penaltySec: car.penalties.timeSec,
      penaltyServedSec: Math.max(0, fin(car.penalties.servedSec)),
      disqualified: dq,
      points: race && car.status === 'finished' && !dq ? ((world.config.sprint === true ? SPRINT_POINTS : POINTS_TABLE)[i] ?? 0) : 0,
      fastestLap: car.id === fastestId,
      status: car.status,
    };
  });

  const objective = world.config.objective;
  return {
    kind: world.session.kind,
    mode: world.config.mode,
    layoutId: world.config.layoutId,
    rows,
    fastestLap: world.session.fastestLap ? { ...world.session.fastestLap } : null,
    weather: world.weather.kind,
    objectiveMet: objective ? evaluateObjective(objective, rows, world.session.kind) : null,
    sprint: world.config.kind === 'race' && world.config.sprint === true,
  };
}
