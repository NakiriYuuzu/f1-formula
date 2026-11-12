/** The session a benchmark scenario plays: a 5-lap race of 20 cars, fixed seed, no incidents, player on the scenario's grid slot. */
import type { SessionConfig } from '../../core/types';
import type { SessionContext } from '../../meta/context';
import { buildQuickStart, buildSessionConfig } from '../../meta/sessionBuilder';
import { BENCH_SEED, type BenchScenario } from './benchSpec';

export function buildBenchSession(sc: BenchScenario): { config: SessionConfig; ctx: SessionContext } {
  const { ctx } = buildQuickStart({
    kind: 'race',
    layoutId: sc.layoutId,
    laps: 5,
    weather: sc.weather,
    seed: BENCH_SEED,
    aiDifficulty: 85,
    safetyCar: 'off',
    redFlags: false,
    formationLap: false,
  });
  const plan = ctx.plan;
  if (!plan) throw new Error('bench: quick start produced no plan');
  const config = buildSessionConfig({ ...plan.request, timeOfDay: sc.timeOfDay, playerStartPosition: sc.startPosition });
  return { config, ctx };
}
