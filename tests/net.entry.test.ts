/**
 * Online entries (src/meta/onlineEntry.ts + the lobby): players race as their career / My Team driver in a roster seat
 * or as their whole My Team in a roster team's place — saves → entries, untrusted entries sanitized, the lobby's seat
 * rules (a My Team takes its whole team), and the session the host builds (ids, garage, livery, rating, part gains,
 * a career driver's team development). Online car setups: their own book, the guests' latest ones in every session.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { DEFAULT_ASSISTS, DEFAULT_RULES, DEFAULT_SETUP } from '../src/core/defaults';
import type { DriverDef } from '../src/core/types';
import { getLayout, LAYOUTS } from '../src/data/tracks/index';
import { createCarSpec } from '../src/physics/index';
import { createWorld } from '../src/race/index';
import { createCareer, type CareerSave } from '../src/meta/career';
import { developmentFromRd, teamGains } from '../src/meta/development';
import { createMyTeam, myTeamDef, type MyTeamSave } from '../src/meta/myTeam';
import { applyOnlineEntries, onlineEntryOptions, sanitizeOnlineEntry, type OnlineEntry } from '../src/meta/onlineEntry';
import { builtinRoster, MY_TEAM_ID, rosterDrivers } from '../src/meta/roster';
import { loadOnlineSetup, loadSetup, saveOnlineSetup, saveSetup } from '../src/meta/save';
import { DEFAULT_SEASON_SETTINGS } from '../src/meta/season';
import { buildSessionConfig, validateSessionConfig, type SessionRequest } from '../src/meta/sessionBuilder';
import { GuestLobby, HostLobby, listedEntry, sameListing } from '../src/net/lobby';
import { LoopbackNetwork } from '../src/net/loopback';
import { decodeMessage, encodeMessage } from '../src/net/protocol';
import { useFictionalRoster } from './rosterFixture';

beforeAll(() => useFictionalRoster());

const IDENTITY = {
  firstName: 'Yuu',
  lastName: 'Hanaoka',
  abbr: 'HAN',
  number: 7,
  nationality: 'TWN',
  helmet: { primary: '#ff0000', secondary: '#00ff00', accent: '#0000ff' },
};

function myTeamSave(): MyTeamSave {
  const save = createMyTeam(
    {
      name: 'Nova Works',
      shortName: 'NVW',
      livery: { primary: '#ff5a1f', secondary: '#111111', accent: '#ffffff', pattern: 'stripe' },
      powerUnit: 'Helion',
      identity: IDENTITY,
      teammateId: 'ishikawa',
      settings: DEFAULT_SEASON_SETTINGS,
    },
    5,
    LAYOUTS,
  );
  save.development.teams[MY_TEAM_ID] = developmentFromRd({ aero: 3, power: 2, chassis: 1, reliability: 4 });
  return save;
}

function teamEntry(): Extract<OnlineEntry, { kind: 'team' }> {
  const e = onlineEntryOptions(null, myTeamSave()).find((o) => o.source === 'myTeam')!.entry;
  if (e.kind !== 'team') throw new Error('expected a team entry');
  return e;
}

function driverEntry(over: Partial<DriverDef> = {}): OnlineEntry {
  const career = createCareer({ ...IDENTITY, firstName: 'Mika', abbr: 'MIK', number: 12 }, 'vanta', DEFAULT_SEASON_SETTINGS, 3, LAYOUTS);
  return { kind: 'driver', source: 'career', driver: { ...career.driver, ...over }, gains: {} };
}

/** A career on `teamId` whose own team has this R&D. */
function developedCareer(teamId: string, rd: { aero: number; power: number; chassis: number; reliability: number }, number: number): CareerSave {
  const career = createCareer({ ...IDENTITY, number }, teamId, DEFAULT_SEASON_SETTINGS, 4, LAYOUTS);
  career.development.teams[teamId] = developmentFromRd(rd);
  return career;
}

function careerEntry(career: CareerSave): OnlineEntry {
  return onlineEntryOptions(career, null).find((o) => o.source === 'career')!.entry;
}

function request(roster: SessionRequest['roster'], players: SessionRequest['players'], development?: SessionRequest['development']): SessionRequest {
  return {
    mode: 'splitScreen',
    kind: 'race',
    layoutId: 'monza',
    raceLaps: 5,
    weather: 'clear',
    timeOfDay: 'auto',
    regulation: '2025',
    aiDifficulty: 80,
    qualifying: 'oneShot',
    rules: { ...DEFAULT_RULES },
    seed: 11,
    players,
    roster,
    aiCount: 18,
    gridOrder: null,
    playerStartPosition: null,
    ghost: null,
    objective: null,
    ...(development ? { development } : {}),
  };
}

describe('online entries from saves', () => {
  test('the roster always; the career driver; the My Team driver and the whole My Team (rating, livery, part gains, teammate)', () => {
    const save = myTeamSave();
    const career = createCareer(IDENTITY, 'corvid', DEFAULT_SEASON_SETTINGS, 8, LAYOUTS);
    expect(onlineEntryOptions(null, null).map((o) => o.source)).toEqual(['roster']);
    const options = onlineEntryOptions(career, save);
    expect(options.map((o) => o.source)).toEqual(['roster', 'career', 'myTeamDriver', 'myTeam']);
    expect(options[1]!.label).toContain('Yuu Hanaoka');
    expect(options[3]!.label).toContain('Nova Works');
    const e = teamEntry();
    expect(e.team.name).toBe('Nova Works');
    expect(e.team.livery.primary).toBe('#ff5a1f');
    expect(e.team.rating).toEqual(myTeamDef(save).rating);
    expect(e.gains).toEqual(teamGains(save.development.teams[MY_TEAM_ID]));
    expect(Object.keys(e.gains).length).toBeGreaterThan(0);
    expect(e.driver.abbr).toBe('HAN');
    expect(e.mate?.id).toBe('ishikawa');
    // the career driver brings their own team's development; the My Team driver alone brings none
    const developed = developedCareer('corvid', { aero: 4, power: 1, chassis: 2, reliability: 0 }, 8);
    const c = careerEntry(developed);
    expect(c.kind === 'driver' ? c.gains : null).toEqual(teamGains(developed.development.teams.corvid));
    expect(Object.keys(c.kind === 'driver' ? c.gains : {}).length).toBeGreaterThan(0);
    const md = options.find((o) => o.source === 'myTeamDriver')!.entry;
    expect(md.kind === 'driver' ? md.gains : null).toEqual({});
  });
});

describe('untrusted entries', () => {
  test('malformed → the roster; values clamped, unknown parts dropped, bad colours and codes fall back', () => {
    expect(sanitizeOnlineEntry(null).kind).toBe('roster');
    expect(sanitizeOnlineEntry({ kind: 'team', team: {} }).kind).toBe('roster');
    expect(sanitizeOnlineEntry({ kind: 'driver', driver: 'x' }).kind).toBe('roster');
    const raw = JSON.parse(JSON.stringify(teamEntry()));
    raw.team.rating = { aero: 5, power: -1, chassis: 'x', reliability: 0.9 };
    raw.team.name = 'N'.repeat(80);
    raw.team.shortName = 'nvw';
    raw.team.livery.primary = 'red';
    raw.gains = { floor: 99, warpDrive: 3, brakes: -2, ers: 1.5 };
    raw.driver.number = 500;
    raw.mate = 'nobody';
    const e = sanitizeOnlineEntry(raw);
    if (e.kind !== 'team') throw new Error('expected a team entry');
    expect(e.team.rating).toEqual({ aero: 1, power: 0, chassis: 0.86, reliability: 0.9 });
    expect(e.team.name).toHaveLength(24);
    expect(e.team.shortName).toBe('MYT');
    expect(e.team.livery.primary).toMatch(/^#[0-9a-f]{6}$/);
    expect(e.gains).toEqual({ floor: 5, ers: 1.5 });
    expect(e.driver.number).toBe(99);
    expect(e.mate).toBeNull();
    // a career driver's gains are clamped; a My Team driver never carries any
    const career = sanitizeOnlineEntry({ kind: 'driver', source: 'career', driver: {}, gains: { floor: 9, warpDrive: 1 } });
    expect(career.kind === 'driver' ? career.gains : null).toEqual({ floor: 5 });
    const md = sanitizeOnlineEntry({ kind: 'driver', source: 'myTeamDriver', driver: {}, gains: { floor: 3 } });
    expect(md.kind === 'driver' ? md.gains : null).toEqual({});
  });
});

describe('session roster with entries', () => {
  test('a My Team takes its team’s place (garage, both seats); a driver takes its seat; the base roster is untouched', () => {
    const base = builtinRoster();
    const before = JSON.stringify(base);
    const corvidIndex = base.teams.findIndex((t) => t.id === 'corvid');
    const corvid = base.teams[corvidIndex]!;
    const vanta = base.teams.find((t) => t.id === 'vanta')!;
    const team = teamEntry();
    const field = applyOnlineEntries(base, [
      { playerIndex: 0, teamId: 'corvid', driverId: corvid.driverIds[0], entry: team },
      { playerIndex: 1, teamId: 'vanta', driverId: vanta.driverIds[1], entry: driverEntry() },
      { playerIndex: 2, teamId: 'kestrel', driverId: base.teams.find((t) => t.id === 'kestrel')!.driverIds[0], entry: { kind: 'roster' } },
    ]);
    expect(JSON.stringify(base)).toBe(before);
    expect(field.roster.teams).toHaveLength(base.teams.length);
    const mine = field.roster.teams[corvidIndex]!;
    expect(mine.id).toBe('online-team-p1');
    expect(mine.name).toBe('Nova Works');
    expect(mine.driverIds).toEqual(['online-p1', 'online-p1-mate']);
    expect(field.roster.drivers.some((d) => corvid.driverIds.includes(d.id))).toBe(false);
    expect(field.roster.drivers.find((d) => d.id === 'online-p1-mate')!.lastName).toBe(rosterDrivers().find((d) => d.id === 'ishikawa')!.lastName);
    expect(field.roster.teams.find((t) => t.id === 'vanta')!.driverIds).toEqual([vanta.driverIds[0], 'online-p2']);
    expect(field.development).toEqual({ 'online-team-p1': team.gains });
    expect(field.seats).toEqual([
      { playerIndex: 0, teamId: 'online-team-p1', driverId: 'online-p1' },
      { playerIndex: 1, teamId: 'vanta', driverId: 'online-p2' },
      { playerIndex: 2, teamId: 'kestrel', driverId: base.teams.find((t) => t.id === 'kestrel')!.driverIds[0] },
    ]);

    // the host's session: everyone builds the same world from the config — the player's own name, number, livery and car
    const players = field.seats.map((s) => ({ ...s, setup: { ...DEFAULT_SETUP }, assists: { ...DEFAULT_ASSISTS }, startCompound: null }));
    const config = buildSessionConfig(request(field.roster, players, field.development));
    expect(validateSessionConfig(config)).toEqual([]);
    expect(config.teams.findIndex((t) => t.id === 'online-team-p1')).toBe(corvidIndex);
    expect(config.development).toEqual(field.development);
    const world = createWorld(JSON.parse(JSON.stringify(config)), getLayout('monza'));
    const p1 = world.cars.find((c) => c.playerIndex === 0)!;
    expect(p1.displayName).toBe('Yuu Hanaoka');
    expect(p1.abbr).toBe('HAN');
    expect(p1.number).toBe(7);
    expect(p1.livery.primary).toBe('#ff5a1f');
    expect(p1.spec).toEqual(createCarSpec(config.teams[corvidIndex]!, DEFAULT_SETUP, config.regulation, team.gains));
    const p2 = world.cars.find((c) => c.playerIndex === 1)!;
    expect(p2.displayName).toBe('Mika Hanaoka');
    expect(p2.teamId).toBe('vanta');
    expect(p2.livery.primary).toBe(vanta.livery.primary);
  });

  test('a career driver’s team development goes to both cars of the team they sit in (two in one team: the higher per part)', () => {
    const base = builtinRoster();
    const vanta = base.teams.find((t) => t.id === 'vanta')!;
    const a = developedCareer('corvid', { aero: 4, power: 0, chassis: 1, reliability: 0 }, 8);
    const b = developedCareer('kestrel', { aero: 1, power: 3, chassis: 0, reliability: 2 }, 9);
    const ga = teamGains(a.development.teams.corvid);
    const gb = teamGains(b.development.teams.kestrel);
    const field = applyOnlineEntries(base, [
      { playerIndex: 0, teamId: 'vanta', driverId: vanta.driverIds[0], entry: careerEntry(a) },
      { playerIndex: 1, teamId: 'vanta', driverId: vanta.driverIds[1], entry: careerEntry(b) },
    ]);
    const parts = new Set([...Object.keys(ga), ...Object.keys(gb)]) as Set<keyof typeof ga>;
    const expected = Object.fromEntries([...parts].map((p) => [p, Math.max(ga[p] ?? 0, gb[p] ?? 0)]));
    expect(field.development).toEqual({ vanta: expected });
    const players = field.seats.map((s) => ({ ...s, setup: { ...DEFAULT_SETUP }, assists: { ...DEFAULT_ASSISTS }, startCompound: null }));
    const config = buildSessionConfig(request(field.roster, players, field.development));
    expect(validateSessionConfig(config)).toEqual([]);
    const world = createWorld(JSON.parse(JSON.stringify(config)), getLayout('monza'));
    const team = config.teams.find((t) => t.id === 'vanta')!;
    const cars = world.cars.filter((c) => c.teamId === 'vanta');
    expect(cars).toHaveLength(2);
    for (const car of cars) expect(car.spec).toEqual(createCarSpec(team, DEFAULT_SETUP, config.regulation, expected));
    // the same seats as roster drivers: no development
    const plain = applyOnlineEntries(base, [{ playerIndex: 0, teamId: 'vanta', driverId: vanta.driverIds[0], entry: driverEntry() }]);
    expect(plain.development).toEqual({});
  });

  test('without a teammate the team’s first roster driver stays on; players keep their numbers', () => {
    const base = builtinRoster();
    const corvid = base.teams.find((t) => t.id === 'corvid')!;
    const taken = base.drivers.find((d) => d.teamId === 'kestrel')!.number;
    const field = applyOnlineEntries(base, [
      { playerIndex: 0, teamId: 'corvid', driverId: corvid.driverIds[1], entry: { ...teamEntry(), mate: null } },
      { playerIndex: 1, teamId: 'vanta', driverId: base.teams.find((t) => t.id === 'vanta')!.driverIds[0], entry: driverEntry({ number: taken }) },
    ]);
    expect(field.roster.teams.find((t) => t.id === 'online-team-p1')!.driverIds).toEqual(['online-p1', corvid.driverIds[0]]);
    expect(field.roster.drivers.find((d) => d.id === corvid.driverIds[0])!.teamId).toBe('online-team-p1');
    const players = field.seats.map((s) => ({ ...s, setup: { ...DEFAULT_SETUP }, assists: { ...DEFAULT_ASSISTS }, startCompound: null }));
    const config = buildSessionConfig(request(field.roster, players));
    expect(validateSessionConfig(config)).toEqual([]);
    expect(config.drivers.find((d) => d.id === 'online-p2')!.number).toBe(taken);
  });
});

describe('lobby seats with entries', () => {
  const settings = {
    layoutId: 'monza',
    laps: 5,
    weather: 'clear',
    aiCount: 8,
    aiDifficulty: 80,
    regulation: '2025',
    format: 'raceOnly',
    rules: { safetyCar: 'standard', redFlags: true, formationLap: false, aeroWake: true },
  } as const;

  function setup(guests: number) {
    const net = new LoopbackNetwork({ delayMs: 20 });
    const host = new HostLobby({ code: 'K7MPQ2', name: 'Host', roster: builtinRoster(), settings, now: () => net.now });
    const lobbies = Array.from({ length: guests }, (_, i) => {
      const [h, g] = net.pair();
      host.addGuest(h);
      return new GuestLobby(g, `G${i + 1}`);
    });
    net.advance(200);
    return { net, host, lobbies };
  }

  test('a My Team takes the whole team: its seats are closed to the others, everyone sees the entry', () => {
    const { net, host, lobbies } = setup(2);
    const drivers = host.state.roster.drivers;
    // guest 1 takes over a team nobody sits in
    const team = host.state.roster.teams.find((t) => !host.state.players.some((p) => p.teamId === t.id))!;
    const [d1, d2] = drivers.filter((d) => d.teamId === team.id);
    lobbies[0]!.pick(team.id, d1!.id, undefined, undefined, teamEntry());
    net.advance(100);
    const p1 = host.state.players[1]!;
    expect(p1.teamId).toBe(team.id);
    expect(p1.entry).toEqual({ kind: 'team', driver: 'Yuu Hanaoka', team: 'Nova Works', color: '#ff5a1f' });
    expect(lobbies[1]!.state!.players[1]!.entry?.team).toBe('Nova Works');
    expect(host.entryOf(1).kind).toBe('team');
    // nobody else gets a seat of that team
    lobbies[1]!.pick(team.id, d2!.id);
    net.advance(100);
    expect(host.state.players[2]!.driverId).not.toBe(d2!.id);
    expect(host.setHostPick(team.id, d2!.id)).toBe(false);
    // a pick without an entry keeps it; a malformed one is the roster
    lobbies[0]!.pick(team.id, d1!.id);
    net.advance(100);
    expect(host.entryOf(1).kind).toBe('team');
    // a late guest's free seat is outside the taken team
    const [h3, g3] = net.pair();
    host.addGuest(h3);
    new GuestLobby(g3, 'G3');
    net.advance(200);
    expect(host.state.players[3]!.teamId).not.toBe(team.id);
    lobbies[0]!.pick(team.id, d1!.id, undefined, undefined, { kind: 'bogus' } as unknown as OnlineEntry);
    net.advance(100);
    expect(host.entryOf(1).kind).toBe('roster');
    expect(host.state.players[1]!.entry).toBeUndefined();
  });

  test('a team with another player in it cannot be taken over; the refused pick keeps the old entry', () => {
    const { net, host, lobbies } = setup(1);
    const hostTeam = host.host.teamId;
    const other = host.state.roster.drivers.find((d) => d.teamId === hostTeam && d.id !== host.host.driverId)!;
    lobbies[0]!.pick(hostTeam, other.id, undefined, undefined, driverEntry());
    net.advance(100);
    expect(host.state.players[1]!.driverId).toBe(other.id);
    expect(host.state.players[1]!.entry).toEqual({ kind: 'driver', source: 'career', driver: 'Mika Hanaoka' });
    lobbies[0]!.pick(hostTeam, other.id, undefined, undefined, teamEntry());
    net.advance(100);
    expect(host.entryOf(1).kind).toBe('driver');
    // the host's own My Team: refused where the guest sits, taken where nobody does
    expect(host.setHostPick(hostTeam, host.host.driverId, teamEntry())).toBe(false);
    const free = host.state.roster.teams.find((t) => !host.state.players.some((p) => p.teamId === t.id))!;
    const seat = host.state.roster.drivers.find((d) => d.teamId === free.id)!;
    expect(host.setHostPick(free.id, seat.id, teamEntry())).toBe(true);
    expect(host.host.entry?.kind).toBe('team');
    expect(host.entryOf(0).kind).toBe('team');
  });

  test('two guests going for one team at once: the refused one sees its pick handled but not taken, and chooses again', () => {
    const { net, host, lobbies } = setup(2);
    const [g1, g2] = lobbies as [GuestLobby, GuestLobby];
    const free = () => host.state.roster.teams.filter((t) => !host.state.players.some((p) => p.teamId === t.id));
    const target = free()[0]!;
    const seat = host.state.roster.drivers.find((d) => d.teamId === target.id)!;
    // both in flight: the host handles guest 2's driver pick first
    g2.pick(target.id, seat.id);
    g1.pick(target.id, seat.id, undefined, undefined, teamEntry());
    expect(g1.picksSettled()).toBe(false);
    net.advance(100);
    expect(host.state.players[2]!.teamId).toBe(target.id);
    expect(host.entryOf(1).kind).toBe('roster');
    expect(g1.picksSettled()).toBe(true);
    expect(g1.me!.entry).toBeUndefined();
    // chosen again from the lobby as it is now
    const next = free().find((t) => t.id !== target.id)!;
    g1.pick(next.id, host.state.roster.drivers.find((d) => d.teamId === next.id)!.id, undefined, undefined, teamEntry());
    net.advance(100);
    expect(g1.picksSettled()).toBe(true);
    expect(g1.me!.entry?.kind).toBe('team');
    expect(host.state.players[1]!.teamId).toBe(next.id);
  });

  test('a guest tells from the listing which of two driver entries the host took (and the host’s own is checked alike)', () => {
    const { net, host, lobbies } = setup(1);
    const g1 = lobbies[0]!;
    const career = driverEntry();
    const myTeamDriver = onlineEntryOptions(null, myTeamSave()).find((o) => o.source === 'myTeamDriver')!.entry;
    const me = host.state.players[1]!;
    g1.pick(me.teamId, me.driverId, undefined, undefined, career);
    net.advance(100);
    expect(g1.picksSettled()).toBe(true);
    expect(sameListing(listedEntry(career), g1.me!.entry)).toBe(true);
    expect(sameListing(listedEntry(myTeamDriver), g1.me!.entry)).toBe(false);
    // the same person in both saves is still told apart
    if (myTeamDriver.kind !== 'driver' || career.kind !== 'driver') throw new Error('expected driver entries');
    expect(sameListing(listedEntry({ ...myTeamDriver, driver: { ...career.driver } }), g1.me!.entry)).toBe(false);
    expect(sameListing(listedEntry({ kind: 'roster' }), undefined)).toBe(true);
    // the host's own entry goes through the same check: what it is listed as is what a guest would compute
    const loud = teamEntry();
    loud.team.livery.primary = '#FF5A1F';
    const free = host.state.roster.teams.find((t) => !host.state.players.some((p) => p.teamId === t.id))!;
    expect(host.setHostPick(free.id, host.state.roster.drivers.find((d) => d.teamId === free.id)!.id, loud)).toBe(true);
    expect(host.host.entry?.color).toBe('#ff5a1f');
    expect(sameListing(listedEntry(loud), host.host.entry)).toBe(true);
  });

  test('every session takes each guest’s latest setup and assists (changed between the weekend’s sessions)', () => {
    const { net, host, lobbies } = setup(2);
    const g1 = lobbies[0]!;
    const me = host.state.players[1]!;
    g1.pick(me.teamId, me.driverId, { ...DEFAULT_SETUP, suspension: 3 }, { ...DEFAULT_ASSISTS, abs: false });
    net.advance(100);
    const hostSetup = { ...DEFAULT_SETUP, frontWing: 40 };
    const slots = [0, 1].map((pi) => ({ playerIndex: pi as 0 | 1, driverId: 'x', teamId: 'y', setup: pi === 0 ? { ...hostSetup } : { ...DEFAULT_SETUP }, assists: { ...DEFAULT_ASSISTS } }));
    const config = { players: slots } as unknown as Parameters<HostLobby['applyGuestCars']>[0];
    host.startSession(1, { layoutId: 'monza', grid: [] } as unknown as Parameters<HostLobby['startSession']>[1], false);
    host.attach(false);
    // between sessions the guest sets the car up again
    g1.pick(me.teamId, me.driverId, { ...DEFAULT_SETUP, suspension: 9, rearWing: 12 }, { ...DEFAULT_ASSISTS, abs: true });
    net.advance(100);
    host.applyGuestCars(config);
    expect(config.players[1]!.setup.suspension).toBe(9);
    expect(config.players[1]!.setup.rearWing).toBe(12);
    expect(config.players[1]!.assists.abs).toBe(true);
    // the host's own slot keeps the setup from its briefing
    expect(config.players[0]!.setup).toEqual(hostSetup);
  });

  test('the host always has the guest’s car for its track: a track change sends it, a seat pick on its way is not undone', () => {
    const { net, host, lobbies } = setup(1);
    const g1 = lobbies[0]!;
    const books: Record<string, typeof DEFAULT_SETUP> = { monza: { ...DEFAULT_SETUP, suspension: 2 }, 'koyo-hills': { ...DEFAULT_SETUP, suspension: 10 } };
    g1.carFor = (layoutId) => ({ setup: books[layoutId] ?? { ...DEFAULT_SETUP }, assists: { ...DEFAULT_ASSISTS, abs: false } });
    g1.syncCar();
    net.advance(100);
    expect(host.guestCar(1)!.setup.suspension).toBe(2);
    expect(host.guestCar(1)!.assists.abs).toBe(false);
    // the guest picks another seat; before the host handles it, the host changes the track
    const seat = host.state.roster.drivers.find((d) => !host.state.players.some((p) => p.teamId === d.teamId))!;
    g1.pick(seat.teamId, seat.id);
    host.setSettings({ layoutId: 'koyo-hills' });
    net.advance(200);
    expect(host.guestCar(1)!.setup.suspension).toBe(10);
    expect(host.state.players[1]!.driverId).toBe(seat.id);
    expect(g1.picksSettled()).toBe(true);
    // a new setup or assists: forced, the seat and the entry stay
    books['koyo-hills'] = { ...DEFAULT_SETUP, suspension: 6 };
    g1.syncCar();
    net.advance(100);
    expect(host.guestCar(1)!.setup.suspension).toBe(10);
    g1.syncCar(true);
    net.advance(100);
    expect(host.guestCar(1)!.setup.suspension).toBe(6);
    expect(host.state.players[1]!.driverId).toBe(seat.id);
    expect(host.entryOf(1).kind).toBe('roster');
  });

  test('a car sent while the host was in a session is sent again when the guest’s lobby takes the link back', () => {
    const { net, host, lobbies } = setup(1);
    const g1 = lobbies[0]!;
    let suspension = 3;
    g1.carFor = () => ({ setup: { ...DEFAULT_SETUP, suspension }, assists: { ...DEFAULT_ASSISTS } });
    g1.syncCar();
    net.advance(100);
    expect(host.guestCar(1)!.setup.suspension).toBe(3);
    // the host starts a session (its lobby takes no picks); the guest's change on its way is dropped
    host.startSession(1, { layoutId: 'monza', grid: [] } as unknown as Parameters<HostLobby['startSession']>[1], false);
    suspension = 9;
    g1.syncCar(true);
    net.advance(100);
    expect(host.guestCar(1)!.setup.suspension).toBe(3);
    // the session is over: both lobbies take their links back, the host gets the guest's latest car
    host.attach(false);
    g1.attach();
    net.advance(100);
    expect(host.guestCar(1)!.setup.suspension).toBe(9);
    expect(g1.picksSettled()).toBe(true);
  });

  test('the lobby message keeps a valid entry and refuses a bad colour', () => {
    const { host } = setup(0);
    host.setHostPick(host.host.teamId, host.host.driverId, teamEntry());
    const ok = decodeMessage(encodeMessage({ t: 'lobby', lobby: host.state }));
    expect(ok && ok.t === 'lobby' ? ok.lobby.players[0]!.entry?.color : null).toBe('#ff5a1f');
    const bad = JSON.parse(encodeMessage({ t: 'lobby', lobby: host.state }));
    bad.lobby.players[0].entry.color = 'url(x)';
    expect(decodeMessage(JSON.stringify(bad))).toBeNull();
  });
});

describe('online car setups', () => {
  test('their own book: a layout not set up online starts from the single-player setup; saving online never changes it', () => {
    const solo = { ...DEFAULT_SETUP, frontWing: 31, suspension: 4 };
    saveSetup('koyo-hills', solo);
    expect(loadOnlineSetup('koyo-hills')).toEqual(solo);
    const online = { ...solo, suspension: 10, tyrePressure: 2 };
    saveOnlineSetup('koyo-hills', online);
    expect(loadOnlineSetup('koyo-hills')).toEqual(online);
    expect(loadSetup('koyo-hills')).toEqual(solo);
    // later single-player changes no longer reach the online one
    saveSetup('koyo-hills', { ...solo, frontWing: 12 });
    expect(loadOnlineSetup('koyo-hills')).toEqual(online);
  });
});
