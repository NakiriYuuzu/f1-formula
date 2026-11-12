# Bench probes

Headless probes that put a number on behaviour the unit tests do not gate. Run them with bun from the repo root. Each one imports the game from this checkout. Set `BENCH_ROOT=/path/to/other/checkout` to measure another revision with the same probe, which is how a before/after comparison stays on one harness.

`baseline/` holds the output at commit 4c4c523, before the 2026-11 overhaul.

## Net: what the guest sees

```sh
bun run tools/bench/net/probe.ts full      # 130 ms mean RTT, 30 ms jitter, 3% loss, three seeds
bun run tools/bench/net/probe.ts spike     # the same link with a 100-300 ms stall every 2-5 s
bun run tools/bench/net/probe.ts pit       # the guest pits on the same link
bun run tools/bench/net/probe.ts pitzero   # the guest pits on a near-zero link
```

Other conditions: `zero`, `flat130`, `ctl50`, `jit`, `loss`, `wander`, `full5`, `ram`, `pitflat`. `PITASSIST=1` turns the pit assist on.

The link is a host and one guest on `LoopbackNetwork` with a manual clock, so results do not depend on machine load. The lines to read:

- `remote |dP|-v*dt guest` is the per-frame jump of other cars on the guest's screen, in metres, sampled at 60 fps. The `host` line under it is the floor.
- `own drawn jump while not predicting/in pit` is the guest's own car while the host drives it.
- `remote pos err vs host @shown time` is how far a drawn car is from where the host had it.

## AI: do faster cars get through

```sh
bun run tools/bench/ai/probe.ts <repoRoot> <monza|suzuka|...> <laps> <seed> <normal|reverse> <difficulty> <out.json>
bun run tools/bench/ai/analyze.ts <outDir> <file-prefix>...
```

`reverse` puts the five fastest cars at the back on equal tyres. Name the files `<prefix>_<layout>_<mode>_s<seed>.json`. `analyze.ts` groups by prefix and prints on-track passes per race, re-passes within 20 s, where the back five finish, and how long a faster car sits within 1 s before it gets by. One 12-lap race takes about 21 s. Run races one at a time.

## Pit: loss, handover, lane traffic

```sh
bun run tools/bench/pit/probe.ts monza monaco silverstone suzuka   # pit loss against a no-stop control, phase marks, jumps
bun run tools/bench/pit/handover.ts                                # speed step when the box autopilot takes over
bun run tools/bench/pit/field.ts                                   # every car pits on the same lap, counts overlaps in the lane
```

## Perf: what does not need a GPU

```sh
bun run tools/bench/perf/sim-bench.ts monza,monaco 30 20   # ms of CPU per simulated second, 20 cars
bun run tools/bench/perf/scene-stats.ts                    # draw calls and triangles of the static scenery per quality tier
```

Frame time on a real GPU is measured in the browser, not here: `?bench=1`, see `perf/README.md`. Its baseline is `baseline/perf-render-gpu.txt`.
