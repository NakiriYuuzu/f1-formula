/**
 * Original, fictional teams and drivers (owned by the architect). Any resemblance to real
 * teams/drivers must be avoided — do not rename these to real-world entities.
 */
import type { DriverDef, TeamDef } from '../core/types';

export const TEAMS: TeamDef[] = [
  {
    id: 'vanta',
    name: 'Vanta Motorsport',
    shortName: 'VAN',
    livery: { primary: '#111214', secondary: '#d4a017', accent: '#f4f1e8' },
    base: '霍爾姆港',
    powerUnit: 'Kairos',
    rating: { aero: 1.0, power: 0.99, chassis: 0.99, reliability: 0.96 },
    driverIds: ['varga', 'morioka'],
  },
  {
    id: 'aurora',
    name: 'Aurora Racing',
    shortName: 'AUR',
    livery: { primary: '#12b5a6', secondary: '#f2f5f7', accent: '#0b2b33' },
    base: '北湖',
    powerUnit: 'Helion',
    rating: { aero: 0.98, power: 1.0, chassis: 0.97, reliability: 0.97 },
    driverIds: ['lindqvist', 'ferraz'],
  },
  {
    id: 'kestrel',
    name: 'Kestrel Grand Prix',
    shortName: 'KES',
    livery: { primary: '#c8102e', secondary: '#ffffff', accent: '#1a1a1a' },
    base: '紅崖',
    powerUnit: 'Kestrel',
    rating: { aero: 0.97, power: 0.98, chassis: 0.97, reliability: 0.94 },
    driverIds: ['bellandi', 'okafor'],
  },
  {
    id: 'nordlys',
    name: 'Nordlys Racing',
    shortName: 'NRD',
    livery: { primary: '#7fd3ff', secondary: '#0a1f44', accent: '#ffffff' },
    base: '冰峽灣',
    powerUnit: 'Kairos',
    rating: { aero: 0.96, power: 0.97, chassis: 0.96, reliability: 0.95 },
    driverIds: ['dahl', 'hsu'],
  },
  {
    id: 'helix',
    name: 'Helix Dynamics',
    shortName: 'HLX',
    livery: { primary: '#5b2a86', secondary: '#ff7a1a', accent: '#ffffff' },
    base: '螺旋谷',
    powerUnit: 'Helion',
    rating: { aero: 0.94, power: 0.95, chassis: 0.94, reliability: 0.93 },
    driverIds: ['marchand', 'reyes'],
  },
  {
    id: 'meridian',
    name: 'Meridian Autosport',
    shortName: 'MER',
    livery: { primary: '#ffd400', secondary: '#1e3fae', accent: '#111111' },
    base: '子午城',
    powerUnit: 'Helion',
    rating: { aero: 0.92, power: 0.95, chassis: 0.92, reliability: 0.94 },
    driverIds: ['sharma', 'price'],
  },
  {
    id: 'tempest',
    name: 'Tempest F-Team',
    shortName: 'TMP',
    livery: { primary: '#e0218a', secondary: '#c0c6cc', accent: '#1b1b1b' },
    base: '風暴角',
    powerUnit: 'Orion',
    rating: { aero: 0.91, power: 0.92, chassis: 0.91, reliability: 0.92 },
    driverIds: ['kruger', 'costa'],
  },
  {
    id: 'solace',
    name: 'Solace Engineering',
    shortName: 'SOL',
    livery: { primary: '#a6e22e', secondary: '#2b2d31', accent: '#ffffff' },
    base: '晴原',
    powerUnit: 'Volta',
    rating: { aero: 0.9, power: 0.9, chassis: 0.9, reliability: 0.93 },
    driverIds: ['virtanen', 'brandt'],
  },
  {
    id: 'ironbark',
    name: 'Ironbark Racing',
    shortName: 'IRB',
    livery: { primary: '#1f5e3b', secondary: '#b0763b', accent: '#f1e6d0' },
    base: '鐵木鎮',
    powerUnit: 'Orion',
    rating: { aero: 0.89, power: 0.9, chassis: 0.89, reliability: 0.91 },
    driverIds: ['dufort', 'ibarra'],
  },
  {
    id: 'corvid',
    name: 'Corvid Racing Team',
    shortName: 'CRV',
    livery: { primary: '#3a3f47', secondary: '#00e5ff', accent: '#e6e6e6' },
    base: '鴉嶺',
    powerUnit: 'Volta',
    rating: { aero: 0.87, power: 0.88, chassis: 0.87, reliability: 0.9 },
    driverIds: ['takeda', 'caldwell'],
  },
];

const d = (
  id: string,
  firstName: string,
  lastName: string,
  abbr: string,
  number: number,
  nationality: string,
  teamId: string,
  skill: [number, number, number, number, number],
  helmet: [string, string, string],
): DriverDef => ({
  id,
  firstName,
  lastName,
  abbr,
  number,
  nationality,
  teamId,
  skill: { pace: skill[0], racecraft: skill[1], awareness: skill[2], wet: skill[3], consistency: skill[4] },
  helmet: { primary: helmet[0], secondary: helmet[1], accent: helmet[2] },
});

export const DRIVERS: DriverDef[] = [
  d('varga', 'Elias', 'Varga', 'VAR', 8, 'HUN', 'vanta', [0.97, 0.95, 0.93, 0.92, 0.95], ['#f4f1e8', '#d4a017', '#111214']),
  d('morioka', 'Kenji', 'Morioka', 'MOR', 21, 'JPN', 'vanta', [0.92, 0.9, 0.92, 0.88, 0.93], ['#ffffff', '#d7263d', '#111214']),
  d('lindqvist', 'Sofia', 'Lindqvist', 'LIN', 13, 'SWE', 'aurora', [0.96, 0.93, 0.94, 0.95, 0.94], ['#ffd400', '#005baa', '#ffffff']),
  d('ferraz', 'Mateo', 'Ferraz', 'FRZ', 19, 'BRA', 'aurora', [0.93, 0.94, 0.88, 0.94, 0.89], ['#00a859', '#ffd400', '#0b2b33']),
  d('bellandi', 'Luca', 'Bellandi', 'BEL', 26, 'ITA', 'kestrel', [0.95, 0.92, 0.9, 0.9, 0.91], ['#c8102e', '#ffffff', '#1a1a1a']),
  d('okafor', 'Amara', 'Okafor', 'OKA', 9, 'NGA', 'kestrel', [0.92, 0.93, 0.91, 0.89, 0.92], ['#008751', '#ffffff', '#c8102e']),
  d('dahl', 'Henrik', 'Dahl', 'DAH', 15, 'NOR', 'nordlys', [0.93, 0.9, 0.93, 0.93, 0.94], ['#ba0c2f', '#00205b', '#ffffff']),
  d('hsu', 'Wei-Lun', 'Hsu', 'HSU', 17, 'TWN', 'nordlys', [0.92, 0.91, 0.92, 0.9, 0.92], ['#fe0000', '#000095', '#ffffff']),
  d('marchand', 'Théo', 'Marchand', 'MAR', 36, 'FRA', 'helix', [0.91, 0.9, 0.89, 0.88, 0.9], ['#0055a4', '#ef4135', '#ffffff']),
  d('reyes', 'Diego', 'Reyes', 'REY', 28, 'MEX', 'helix', [0.9, 0.92, 0.87, 0.89, 0.88], ['#006847', '#ce1126', '#ffffff']),
  d('sharma', 'Anika', 'Sharma', 'SHA', 42, 'IND', 'meridian', [0.9, 0.88, 0.91, 0.87, 0.91], ['#ff9933', '#138808', '#ffffff']),
  d('price', 'Callum', 'Price', 'PRI', 29, 'GBR', 'meridian', [0.89, 0.9, 0.88, 0.91, 0.89], ['#012169', '#c8102e', '#ffffff']),
  d('kruger', 'Jonas', 'Krüger', 'KRU', 34, 'DEU', 'tempest', [0.89, 0.88, 0.9, 0.86, 0.9], ['#000000', '#dd0000', '#ffce00']),
  d('costa', 'Rafael', 'Costa', 'COS', 47, 'PRT', 'tempest', [0.88, 0.89, 0.86, 0.88, 0.87], ['#006600', '#ff0000', '#ffcc00']),
  d('virtanen', 'Aleksi', 'Virtanen', 'VIR', 52, 'FIN', 'solace', [0.88, 0.86, 0.9, 0.9, 0.9], ['#ffffff', '#002f6c', '#a6e22e']),
  d('brandt', 'Noah', 'Brandt', 'BRN', 6, 'CHE', 'solace', [0.87, 0.87, 0.88, 0.85, 0.88], ['#d52b1e', '#ffffff', '#2b2d31']),
  d('dufort', 'Camille', 'Dufort', 'DUF', 61, 'FRA', 'ironbark', [0.87, 0.86, 0.87, 0.86, 0.87], ['#b0763b', '#1f5e3b', '#f1e6d0']),
  d('ibarra', 'Tomás', 'Ibarra', 'IBA', 58, 'ARG', 'ironbark', [0.86, 0.88, 0.85, 0.85, 0.86], ['#74acdf', '#ffffff', '#f6b40e']),
  d('takeda', 'Ryo', 'Takeda', 'TAK', 64, 'JPN', 'corvid', [0.86, 0.85, 0.88, 0.87, 0.87], ['#ffffff', '#bc002d', '#3a3f47']),
  d('caldwell', 'Ethan', 'Caldwell', 'CAL', 39, 'AUS', 'corvid', [0.85, 0.86, 0.85, 0.84, 0.85], ['#00843d', '#ffcd00', '#012169']),
  // Reserves / free agents (career & My Team driver market)
  d('kowalska', 'Marta', 'Kowalska', 'KOW', 70, 'POL', '', [0.84, 0.85, 0.86, 0.83, 0.86], ['#ffffff', '#dc143c', '#222222']),
  d('adeyemi', 'Samuel', 'Adeyemi', 'ADE', 74, 'GBR', '', [0.85, 0.84, 0.84, 0.85, 0.84], ['#12b5a6', '#111111', '#ffffff']),
  d('ishikawa', 'Hana', 'Ishikawa', 'ISH', 83, 'JPN', '', [0.86, 0.83, 0.87, 0.84, 0.87], ['#ffb7c5', '#ffffff', '#bc002d']),
  d('serrano', 'Pablo', 'Serrano', 'SER', 57, 'ESP', '', [0.84, 0.87, 0.83, 0.86, 0.83], ['#aa151b', '#f1bf00', '#ffffff']),
  d('holm', 'Erik', 'Holm', 'HOL', 91, 'DNK', '', [0.83, 0.84, 0.86, 0.85, 0.85], ['#c60c30', '#ffffff', '#111111']),
  d('benali', 'Yasmin', 'Benali', 'BEN', 96, 'MAR', '', [0.85, 0.85, 0.85, 0.84, 0.84], ['#c1272d', '#006233', '#ffffff']),
];

export function getTeam(id: string, teams: TeamDef[] = TEAMS): TeamDef {
  const t = teams.find((x) => x.id === id);
  if (!t) throw new Error(`Unknown team: ${id}`);
  return t;
}

export function getDriver(id: string, drivers: DriverDef[] = DRIVERS): DriverDef {
  const dr = drivers.find((x) => x.id === id);
  if (!dr) throw new Error(`Unknown driver: ${id}`);
  return dr;
}

/** Drivers currently racing for a team (2 entries). */
export function teamDrivers(teamId: string, drivers: DriverDef[] = DRIVERS): DriverDef[] {
  return drivers.filter((x) => x.teamId === teamId);
}
