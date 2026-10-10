/**
 * Team radio: original zh-TW race-engineer messages for human cars (lap / position updates, gaps, pit and tyre
 * reminders, damage, penalties, finish) plus session-wide weather warnings. Rate-limited per car; important
 * messages (penalties, finish, final lap) bypass the cooldown.
 */
import type { CarEntry, WorldState } from '../core/types';
import { formatLapTime } from '../core/math';
import { emit, fin, isHuman } from './events';

/** Minimum seconds between two routine messages to the same car. */
const RADIO_COOLDOWN = 7;

function say(world: WorldState, car: CarEntry, text: string, force = false): void {
  if (!isHuman(car)) return;
  if (!force && car.race.radioCooldown > 0) return;
  car.race.radioCooldown = RADIO_COOLDOWN;
  emit(world, { type: 'radio', carId: car.id, text });
}

function gapText(sec: number): string {
  return Math.max(0, fin(sec)).toFixed(1);
}

function carAhead(world: WorldState, car: CarEntry): CarEntry | null {
  const order = world.race.order;
  const i = order.indexOf(car.id);
  return i > 0 ? (world.cars[order[i - 1]] ?? null) : null;
}

function carBehind(world: WorldState, car: CarEntry): CarEntry | null {
  const order = world.race.order;
  const i = order.indexOf(car.id);
  return i >= 0 && i + 1 < order.length ? (world.cars[order[i + 1]] ?? null) : null;
}

/** Lap completed by a human car. */
export function radioLap(world: WorldState, car: CarEntry, lapTime: number, valid: boolean, overallBest: boolean): void {
  if (!isHuman(car)) return;
  const t = car.timing;
  if (world.config.kind !== 'race') {
    if (!valid) say(world, car, `這圈 ${formatLapTime(lapTime)} 因超出賽道界線不予計算。`, true);
    else if (overallBest) say(world, car, `${formatLapTime(lapTime)}！目前最快，保持節奏。`, true);
    else say(world, car, `單圈 ${formatLapTime(lapTime)}，離最佳還有空間。`);
    return;
  }
  if (overallBest && valid) {
    say(world, car, `全場最快圈 ${formatLapTime(lapTime)}！就是這個節奏。`, true);
    return;
  }
  const parts = [`第 ${t.lapsCompleted} 圈完成，目前第 ${t.position} 名。`];
  const ahead = carAhead(world, car);
  const behind = carBehind(world, car);
  if (ahead && t.interval > 0 && t.interval < 15) parts.push(`距離前方 ${ahead.abbr} ${gapText(t.interval)} 秒。`);
  else if (behind && behind.timing.interval > 0 && behind.timing.interval < 15)
    parts.push(`後方 ${behind.abbr} 落後 ${gapText(behind.timing.interval)} 秒。`);
  say(world, car, parts.join(''));
}

/** The final lap has started (human cars). */
export function radioFinalLap(world: WorldState): void {
  for (const car of world.cars) {
    if (isHuman(car) && car.status === 'running') say(world, car, '最後一圈！專注每個彎，把車平安帶回來。', true);
  }
}

export function radioFinish(world: WorldState, car: CarEntry): void {
  if (!isHuman(car)) return;
  if (world.config.kind !== 'race') {
    const best = car.timing.bestLap;
    say(world, car, best !== null ? `節次結束，你的最快圈是 ${formatLapTime(best)}。` : '節次結束，這次沒有有效圈速。', true);
    return;
  }
  const pos = car.timing.position;
  let text: string;
  if (pos === 1) text = '冠軍！你贏了！整個車庫都在為你歡呼！';
  else if (pos <= 3) text = `第 ${pos} 名完賽，站上頒獎台，太漂亮了！`;
  else if (pos <= 10) text = `第 ${pos} 名完賽，拿下積分，表現很穩。`;
  else text = `第 ${pos} 名完賽。辛苦了，回去我們一起看數據。`;
  say(world, car, text, true);
}

/** Race-control message to every human car (bypasses the cooldown). */
export function radioAll(world: WorldState, text: string): void {
  for (const car of world.cars) {
    if (car.status !== 'retired') say(world, car, text, true);
  }
}

export function radioPenalty(world: WorldState, car: CarEntry, seconds: number, reason: string): void {
  say(world, car, `收到 ${Math.round(seconds)} 秒罰時：${reason}。`, true);
}

export function radioTrackLimits(world: WorldState, car: CarEntry, warnings: number): void {
  if (warnings === 3) say(world, car, '已經第三次超出賽道界線了，再犯就會被罰秒。', true);
  else if (warnings < 3) say(world, car, '注意賽道界線，四輪不要全部越過白線。');
}

/** Pit-lane speeding outside a race (no time penalty: in real F1 it is a fine). */
export function radioPitSpeeding(world: WorldState, car: CarEntry): void {
  say(world, car, '維修道超速！記得在限速線前開啟限速器，正賽會被罰 5 秒。', true);
}

/**
 * Team order to an AI car: let its team-mate by on the next straight (a human team-mate is told it is coming). Orders
 * only ever go to AI drivers — a human is never asked to give a place up. AI-only lines carry the AI car's id (no HUD
 * view shows them).
 */
export function radioTeamYield(world: WorldState, car: CarEntry, mate: CarEntry | undefined): void {
  if (!mate || isHuman(car)) return;
  emit(world, { type: 'radio', carId: car.id, text: `車隊指令：讓隊友 ${mate.abbr} 通過，下一段直線讓出路線。` });
  say(world, mate, `車隊指令：${car.abbr} 會在下一段直線讓你通過。`, true);
}

/** Team order to an AI car: hold position, no racing its (AI) team-mate. */
export function radioTeamHold(world: WorldState, car: CarEntry, mate: CarEntry | undefined): void {
  if (!mate || isHuman(car)) return;
  emit(world, { type: 'radio', carId: car.id, text: `車隊指令：維持現有名次，不要和 ${mate.abbr} 互相攻擊。` });
}

export function radioPitExit(world: WorldState, car: CarEntry): void {
  say(world, car, '出站完成，注意出口白線與後方來車。', true);
}

export function radioOvertake(world: WorldState, car: CarEntry, passed: CarEntry): void {
  say(world, car, `漂亮！成功超越 ${passed.abbr}，繼續推進。`);
}

export function radioDrsEnabled(world: WorldState): void {
  const text = world.config.regulation === '2026' ? '直線模式已開放，直道上記得啟用主動空力。' : 'DRS 已開放，偵測點落後前車一秒內就能使用。';
  for (const car of world.cars) if (isHuman(car) && car.status === 'running') say(world, car, text);
}

/** Periodic checks: cooldowns, tyre wear, damage, weather forecast and crossover, gaps, mandatory stop. */
export function stepRadio(world: WorldState, dt: number, mandatoryOpen: (car: CarEntry) => boolean): void {
  const s = world.session;
  forecastWarning(world);
  for (const car of world.cars) {
    if (!isHuman(car)) continue;
    const r = car.race;
    if (r.radioCooldown > 0) r.radioCooldown = Math.max(0, r.radioCooldown - dt);
    if (r.radioGapTimer > 0) r.radioGapTimer = Math.max(0, r.radioGapTimer - dt);
    if (car.status !== 'running' || (s.phase !== 'running' && s.phase !== 'chequered')) continue;
    const p = car.phys;
    const race = s.kind === 'race';
    const lapsLeft = race ? s.totalLaps - car.timing.lapsCompleted : 99;

    if (!r.radioDamageWarned && p.damage.frontWing > 0.3) {
      r.radioDamageWarned = true;
      say(world, car, '前翼受損，下壓力明顯流失，建議進站更換鼻翼。', true);
      continue;
    }
    if (!r.radioWearWarned && p.tire.wear > 0.66 && lapsLeft > 1 && !car.pit.requested) {
      r.radioWearWarned = true;
      say(world, car, `輪胎磨耗已達 ${Math.round(p.tire.wear * 100)}%，抓地力快到極限，建議進站。`);
      continue;
    }
    if (!r.radioMandatoryWarned && race && lapsLeft <= 3 && lapsLeft > 1 && mandatoryOpen(car)) {
      r.radioMandatoryWarned = true;
      say(world, car, '提醒：本場必須換上另一種乾地配方，記得安排進站。');
      continue;
    }
    const wet = world.weather.wetness;
    const c = p.tire.compound;
    const slick = c === 'soft' || c === 'medium' || c === 'hard';
    if (!r.radioWeatherWarned) {
      let text: string | null = null;
      if (slick && wet > 0.35) text = wet > 0.7 ? '雨很大，光頭胎撐不住了，考慮直接換全雨胎。' : '賽道越來越濕，是換半雨胎的時候了。';
      else if (!slick && wet < 0.2) text = '路面正在轉乾，可以換回光頭胎。';
      if (text) {
        r.radioWeatherWarned = true;
        say(world, car, text);
        continue;
      }
    } else if ((slick && wet < 0.25) || (!slick && wet > 0.3)) {
      r.radioWeatherWarned = false;
    }
    if (race && r.radioGapTimer <= 0 && s.phase === 'running') {
      const behind = carBehind(world, car);
      const ahead = carAhead(world, car);
      if (behind && behind.status === 'running' && behind.timing.interval > 0 && behind.timing.interval < 1) {
        r.radioGapTimer = 30;
        say(world, car, `後方 ${behind.abbr} 已進入一秒內，守住防線。`);
      } else if (ahead && s.drsEnabled && car.timing.interval > 0 && car.timing.interval < 1) {
        r.radioGapTimer = 30;
        say(world, car, `前方 ${ahead.abbr} 就在一秒內，全力進攻！`);
      }
    }
  }
}

/** Session-wide warning ~60 s before a forecast weather change. */
function forecastWarning(world: WorldState): void {
  const f = world.weather.forecast;
  if (f.length === 0) return;
  const next = f[0];
  const idx = Math.round(next.time);
  if (world.race.forecastWarned === idx || next.time - world.time > 60) return;
  world.race.forecastWarned = idx;
  const wetNow = world.weather.kind === 'lightRain' || world.weather.kind === 'heavyRain';
  const wetNext = next.kind === 'lightRain' || next.kind === 'heavyRain';
  let text: string;
  if (wetNext && !wetNow) text = '雷達顯示雨雲接近，大約一分鐘後會開始下雨。';
  else if (next.kind === 'heavyRain') text = '雨勢預計在一分鐘內轉大，留意積水。';
  else if (!wetNext && wetNow) text = '雨勢預計一分鐘內減弱，賽道會慢慢轉乾。';
  else text = '天氣即將轉變，留意賽道狀況。';
  emit(world, { type: 'radio', carId: null, text });
}
