# Render benchmark (`?bench=1`)

Frame time and render counters of fixed, deterministic race scenarios, measured in the browser. Open the game with a
`bench` URL parameter, press the button (or add `autorun=1`), read the panel.

```
http://127.0.0.1:5173/?bench=1                                   all four tiers, four scenarios, the display's pixel ratio
http://127.0.0.1:5173/?bench=1&quality=low&dpr=1,2&autorun=1     only low, at pixel ratio 1 and 2, starts by itself
```

## Parameters

| name | default | meaning |
| --- | --- | --- |
| `bench` | | `1` turns the mode on |
| `quality` | `low,medium,high,ultra` | tiers to run, in this order |
| `scenario` | the four below | `grid-monza` (20 cars on the standing grid, day), `pack-spa` (mid-pack after 28 s, day), `rain-spa` (the same in heavy rain), `night-singapore` (street circuit, night). `stop-spa` is only run when named: dry tyres in heavy rain, so the whole field pits after lap 1 and every pit crew works next to the camera (the timed window starts at 189 s, as the player passes the pit lane; `runup=` moves it) |
| `dpr` | `device` | pixel ratios to run, e.g. `1,2`; `device` is the display's own. The tier's `maxPixelRatio` still caps it |
| `size` | `1280x720` | canvas CSS size, fixed whatever the window is |
| `scale` | `1` | the resolution-scale setting (0.5 to 1) |
| `frames`, `warmup` | `300`, `45` | timed frames and discarded frames per scenario |
| `runs` | `1` | repeat the whole matrix |
| `aa` | tier's own | `0` or `1` forces the canvas MSAA. By default the first tier in `quality` decides (`canvasMsaa` in `src/render/core/quality.ts`). It is fixed when the WebGL context is created, so one page measures one canvas MSAA setting: use one tier per page to compare tiers |
| `tune` | | `field:value,...` overrides fields of the quality table (`src/render/core/quality.ts`) for a tuned variant, e.g. `tune=ibl:0,maxPixelRatio:2` |
| `ab` | `0` | with `tune`, alternate the shipped table and the tuned one on every run (rows of the tuned variant carry `variant=tuned`) |
| `runup` | scenario's own | seconds of play before the first timed frame of the running scenarios (the grid keeps 0). `scenario=stop-spa&hold=1` stops on the pit lane |
| `hold` | `0` | load the first scenario, run its warm-up, then stop on the frame (for screenshots) |
| `autorun` | `0` | start without pressing the button |

Adaptive resolution is locked at 100 %, the player's saved quality is never read or written, and the 20-car session,
seed, grid slot and autopilot are the same on every machine.

## What a frame is

One frame = `advanceTime(1000 / 60)` of the real session (two 120 Hz simulation steps, the HUD, the scene, the post
chain) followed by a 1 x 1 `readPixels`, which cannot return before the GPU has finished. The loop yields to the event
loop between frames but never waits for the display, so the figure is milliseconds per frame on any monitor, GPU time
included. It is not a frame rate the display can show: a 60 Hz screen shows at most 60.

## Reading the panel

- The summary lists, per tier / scenario / pixel ratio, the median, p95 and p99 of the frame time, the frame rate the
  median implies, draw calls and thousands of triangles. A `*` after the tier marks the tuned variant.
- The raw rows (one line each) carry everything else: `cpuMedianMs` is the part up to the end of the JS call (sim, HUD,
  command submission), `gpuWaitMedianMs` the part spent waiting for the GPU. A large wait means the GPU is the limiter.
- Counters: `canvasPixels`, `canvasSamples` (the canvas's own MSAA), `sceneSamples` (the target the scene is drawn
  into), `fullscreenPasses` and `postFillMpx` (post passes after the scene and the million pixels they write per frame),
  `shadowRenders`, `lights`, `ibl`.
- `phaseEnd` should be `pre` or `lights` for the standing grid and `running` for the others. `errors` should be 0.
- The result is also `window.__benchResult`, the "複製結果" button copies it as JSON, and the window title carries
  `quality.scenario.dpr.run=median/p95/p99`.

Send a report with: the copied JSON (or the raw rows), the browser and the GPU line of the panel, the display's
resolution and scaling, and whether the machine was on battery.

## Collecting runs

The page does all the measuring, so any way of opening the URL works: a person, a browser's own command line or a driver
that can read a page value. A collector needs three things: open the URL, wait until `window.__benchResult.done` is
`true` (the panel then says `完成`), and read `window.__benchResult` (or press `複製結果` and paste into a file).

```sh
bun run tools/bench/perf/bench-table.ts A=a1.json,a2.json B=b1.json,b2.json   # medians, spread and the change B vs A
python3 -I tools/bench/perf/imgdiff.py a.png b.png [diff.png]                  # pixel difference of two screenshots
```

`bench-table.ts` takes the copied JSON (`.json`) or the panel's raw rows saved as a text file (`.tsv`), one file per page
load. Alternate the two sides (A, B, A, B, ...) and use one tier per page when comparing tiers, so every page has its own
canvas MSAA setting.

A software-rasterised run (the second proxy) is a browser started with its GPU turned off, for example Chrome with
`--use-angle=swiftshader --enable-unsafe-swiftshader`. For a screenshot of one frame add `hold=1&scenario=<id>` to the URL:
the bench loads the scenario, runs its warm-up and stops on the frame, with the panel hidden.

An Apple-silicon GPU is tile-based: opaque overdraw and MSAA cost far less there than on an Intel integrated GPU, so a
null result on it says little about those. The software rasteriser is the second proxy: it is bound by fill and vertex
work, like a weak GPU, but its absolute numbers mean nothing for any real machine.

## Headless counters (no browser)

```sh
bun run tools/bench/perf/frame-budget.ts low [lod=27,60] [tune=crewDrawDistance:60]   # what a bench frame submits, split into scenery / cars / pit crews
bun run tools/bench/perf/cull-probe.ts monza,spa low 100 600   # scenery only: what splitting merged meshes into 600 m cells would leave
bun run tools/bench/perf/scene-breakdown.ts monza low      # triangles of the static scenery per mesh name
```

`frame-budget.ts` rebuilds the scenery, the 20-car sim, the car models and the pit crews under bun and lets three's own
frustum decide what is submitted from the bench's chase camera. For the low tier it prints the measured bench row next to it
(`tools/bench/baseline/perf-frame-budget.txt` has the check and the reading). It says what a cut does to the counters, not what
it does to a frame time: confirm a counter cut with the page (`tune=`, `ab=1`) before shipping it. `tune=` overrides tier-table fields
like the page's own `tune=`.

