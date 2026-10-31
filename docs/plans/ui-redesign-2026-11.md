# UI/UX redesign — menus and HUD (2026-11)

The user asked for a redesign that makes the whole game easier to operate, and chose: faster race start with
consistent controls, a new menu visual system, a new HUD, and reworked settings and pause menus. The brand orange
stays only on each screen's one primary action. Rendering quality is a separate piece of work in `src/render`.

Direction: the design skill's app style **true-black-flat** (seed 402652158), adapted for a game that is played with
keyboard or gamepad on a laptop or a TV. Tokens live in `src/ui/tokens.css`; every rule below refers to them by name.

## 1. Principles

1. **Elevation is lightness alone.** Ground `--nv-bg` → panel `--nv-panel` → nested `--nv-panel-hi`. Nothing at rest
   has a border, a shadow or a gradient. A 1px `--nv-line` rule is allowed only inside tables. HUD blocks over the 3D
   view use `--nv-scrim`, the only translucent surface. It is a flat neutral with no blur.
2. **Focus is inversion.** The focused control is `--nv-focus-bg` (white) with `--nv-focus-ink` text and
   `--nv-focus-sub` for its secondary line. It is the same on every screen, for keyboard, gamepad and mouse hover
   (hover moves focus). The exception is a card whose content is a canvas drawn in white, such as a track map. It
   takes `--nv-active` with a 2px white `outline` at `outline-offset: 2px` instead.
3. **Colour is data.** Team identity colours, tyre compounds, timing purple/green/yellow, flags, DRS/ERS states,
   damage and status are the only hues. `--nv-accent` (orange) is used twice only: the screen's single primary
   button at rest, and the brand mark.
4. **One face.** `--nv-font` (Inter + CJK system fallback) everywhere. Figures use
   `font-variant-numeric: tabular-nums`. `--nv-font-display` (Barlow Condensed italic 800) is for the wordmark
   "FORMULA NOVA 25" only. There is no monospace (`--nv-font-mono` is aliased to the text face).
5. **A small type scale.** Menus scale from the root `font-size: var(--nv-ui-scale)`, which is 14px on a laptop,
   about 17px at 1080p and 20px at most. Sizes in em: `--nv-fs-small` 0.857, `--nv-fs-body` 1, `--nv-fs-section`
   1.143, `--nv-fs-figure` 1.714, `--nv-fs-title` 2. Weights are 400, 500 and 600. 700 is used once, for the wordmark.
   Nothing renders under 11px.
6. **Shape.** `--nv-radius` (4px) for controls and chips, `--nv-radius-lg` (8px) for panels and cards. There are no
   `clip-path` cut corners, no `skewX`, and no italic other than the wordmark.
7. **Banned everywhere:** `backdrop-filter`, `linear-gradient`/`radial-gradient` on surfaces, buttons, text or data
   bars (bars are one flat fill, and a state change is a different flat fill), `text-shadow`, coloured or glowing
   `box-shadow`, `letter-spacing` ≥ 0.05em, `text-transform: uppercase`, decorative pseudo-elements (stripes, corner
   ticks, accent bars before titles), index numbering such as 01/02, and eyebrow labels above titles. A real shadow
   is allowed only on what floats: the confirm dialog and toasts (`0 12px 32px rgba(0,0,0,.5)`).
8. **Text contrast ≥ 4.5:1.** `--nv-text-3` is the faintest text and holds 4.58:1 on `--nv-active`. Do not put text
   on the accent other than `--nv-accent-ink`.
9. **Motion is feedback.** Screen enter/leave is a 200ms fade with at most 12px travel. Focus changes are instant or
   120ms on colour only. Nothing loops except a loading indicator. `prefers-reduced-motion: reduce` removes travel.
10. **Hit targets.** Every focusable row is at least `--nv-row-h` (48px at 14px). Cycler arrows are at least 2.75em
    square.

## 2. Menus (`src/ui/menus/menus.css`, keep every class name the TS emits)

- **Root and background.** `.nvm-root` sets `font: var(--nv-fs-body)/1.5 var(--nv-font)`, `font-size:
  var(--nv-ui-scale)` and `color: var(--nv-text)`. `.nvm-bg` is flat `--nv-bg` on the `panel` layout. On the
  `showroom` layout it is transparent, so the 3D car shows on the right, and the left column sits on opaque panels.
  Delete the stripe `::before`/`::after` and the drift animation.
- **Top bar** `.nvm-top`: 3.43em tall with `--nv-pad` sides. On the left, `.nvm-brand__mark` is a 1.6em orange
  square with an upright "N" in `--nv-accent-ink`, `.nvm-brand__name` is the wordmark face in white, and
  `.nvm-brand__zh` is `--nv-text-3`. On the right, `.nvm-top__back` (a new button, see §4) comes first, then
  `.nvm-top__crumb` in `--nv-text-2`. No rule under the bar.
- **Footer hints** `.nvm-foot .nvm-hint` contain `<kbd>` key caps followed by a label. `kbd`: `--nv-panel-hi`
  fill, `--nv-text`, radius 4px, padding .1em .45em, `--nv-fs-small`, min-width 1.6em, centred. Labels use
  `--nv-text-2`. The hints are separated by 1.5em of space and no dividers.
- **Heading** `.nvm-heading`: `display: flex; flex-direction: column-reverse; gap: .25em`, which turns the kicker
  into a subline under the title. `.nvm-heading__title` is `--nv-fs-title`/600, upright, letter-spacing −0.01em.
  `.nvm-heading__kicker` is `--nv-fs-small` `--nv-text-2`, sentence case, with no tracking and no accent colour.
- **Panels** `.nvm-panel`: `--nv-panel` fill, `--nv-radius-lg`, padding 1.25em, no border, no decoration.
  `.nvm-panel__title` is `--nv-fs-section`/600 `--nv-text`, with no bar before it.
- **Buttons** `.nvm-btn`: min-height `--nv-row-h`, padding 0 1.15em, `--nv-radius`, fill `--nv-panel-hi`, label
  500 `--nv-text`, sub `--nv-fs-small` `--nv-text-2`.
  - `:focus` inverts; the sub becomes `--nv-focus-sub`.
  - `--primary`: `--nv-accent` fill, `--nv-accent-ink` label at 600. On focus it inverts like the others.
  - `--danger`: label `--nv-danger`. On focus, a white fill and `#c4242a` label.
  - `--ghost`: transparent with `--nv-text-2`.
  - `:disabled`: `--nv-panel` fill, `--nv-text-3` label, no opacity tricks.
  - `.nvm-btn__badge`: a neutral pill (`--nv-panel` fill on a hi button, `--nv-text-2`, small).
- **Main-menu tiles** `.nvm-tile`: a row of min-height 4em, padding 0 1.25em, `--nv-panel` fill. Label
  `--nv-fs-section`/600, sub `--nv-fs-small` `--nv-text-2`, and the chevron `.nvm-tile__arrow` in `--nv-text-3`.
  `:focus` inverts. There is no index number; the TS no longer emits one. `.nvm-tile--primary` is the quick-race
  tile: `--nv-accent` fill and `--nv-accent-ink` text at rest, inverting on focus. The tile list must fit 900px of
  height without scrolling. Use a gap of 0.375em; groups are separated by an extra 1em, set by a
  `.nvm-tiles__gap` spacer element.
- **Value rows** `.nvm-row`: `--nv-panel` fill, `--nv-radius`, padding .65em 1em, and a grid with the label on the
  left and the control on the right. The description below uses `--nv-fs-small` `--nv-text-3`.
  - `:focus-within` inverts the whole row: label `--nv-focus-ink`, description `--nv-focus-sub`, cycler value and
    arrows ink, slider track `#d5d7da` with ink fill and knob, pips ink.
  - `.is-disabled`: label `--nv-text-3`.
- **Cycler** `.nvm-cycler`: arrows are 2.75em square hit areas in `--nv-text-2`, and the value is centred at 500.
  `.nvm-cycler__dots i` are 0.5em × 0.2em bars in `--nv-panel-hi`; `.is-on` uses `--nv-text`.
- **Slider**: track 0.375em `--nv-panel-hi`, fill and knob `--nv-text`, and a tabular value on the right.
- **Inputs** `.nvm-input`: `--nv-bg` fill, 1px `--nv-line-strong`, `--nv-radius`. On focus, `outline: 2px solid
  #fff`.
- **Tabs** `.nvm-tabs`: underline tabs sitting on a full-width 1px `--nv-line` rule. Each tab is `--nv-text-2` with
  padding .7em 1.1em. `.is-active` is `--nv-text` with a 2px white bar under the label. `:focus` inverts. Two new
  spans, `.nvm-tabs__key` (the Q / E and LB / RB caps), sit at the ends and are styled like `kbd`.
- **Stats, info, chips.** `.nvm-stat__bar` is a track in `--nv-panel-hi` with a flat `--nv-text-2` fill and a
  tabular value. `.nvm-info` has the key in `--nv-text-2` on the left and the value in `--nv-text` on the right,
  tabular. `.nvm-chip` is a 0.375em × 1.1em bar in `--chip`, the team colour.
- **Track browser.** `.nvm-track` cards use `--nv-panel`. `:focus` and `.is-selected` follow the canvas exception in
  §1.2. `.nvm-real-tag` is a neutral pill.
- **Team and driver picks** `.nvm-pick`: rows that invert on focus. `.is-selected` uses `--nv-active`.
- **Tables** `.nvm-table`: `th` is `--nv-fs-small` `--nv-text-3`, 400, sentence case, with no band. Rows have a 1px
  `--nv-line` rule, no zebra striping, and tabular numbers that are right-aligned. `tr.is-me td` uses
  `--nv-active`. `td.is-fastest` uses `--nv-time-overall`.
- **Confirm dialog** `.nvm-confirm__box`: `--nv-panel` with radius 8px, the floating shadow, and a backdrop of
  `rgba(0,0,0,.6)`.
- **Loading card**: centred on `--nv-bg`. The bar is a 0.25em `--nv-panel-hi` track with a white indeterminate
  segment, the only looping motion.
- **Toasts**: `--nv-panel-hi` with the floating shadow and a 0.5em status dot.
- **Title screen** (a splash, so a large wordmark is right here): the wordmark sits in the left 45% and never
  overlaps the car. The "press any key" prompt is the primary button. No tracked English kicker, no text shadow.

## 3. HUD (`src/ui/hud/*`)

- **Blocks** use `--nv-scrim` with `--nv-radius-lg`, and no border, shadow, gradient or glow. Text follows the
  tiers in §1.8, in Inter with tabular figures. There is no Barlow and no mono.
- **Root scale** is `clamp(12px, min(1.5vh, 1.05vw), 18px)`. Every text element must be at least 11px at the
  smallest root (so ≥ 0.917em).
- **Colour on data only**: team strips (`identColor`), compounds, sector colours, flags, DRS available/open, ERS
  modes, damage, warnings. The rev LEDs are flat fills, off = `--nv-panel-hi`. Bars are flat fills.
- **No overlap** at 800×620, 1280×720, 1440×900 and 1920×1080, nor in split screen: the timing tower must not run
  under the minimap, and the split-screen FPS/ping block must not sit on the divider.
- **Pause menu**: every item is a focusable button that inverts on focus. ↑/↓ moves; Enter/A activates; Esc, B and
  Backspace resume. 重新開始, 退賽 and 離開至選單 open a confirm dialog with the consequence in words. There is no
  second-press arming.

## 4. Navigation (menus TS)

- A visible **back button** `.nvm-top__back` ("返回", with its key cap) whenever the stack can go back. It calls the
  same back logic as Esc. Track select and team select also get a visible 返回 action.
- **Hints** render key caps: `<kbd>Enter</kbd> 確認`. The gamepad glyphs (A/B/LB/RB) replace the keyboard caps after
  the last input came from a pad.
- **Tabs** are `role="tab"` with `aria-selected`. **Q / E** on the keyboard and **LB / RB** on a gamepad switch the
  visible tab set from anywhere on the screen.
- **Quick race** is the first main-menu tile. One press starts a race-only weekend with the last Grand Prix track,
  team, driver and options (defaults the first time), straight to the loading card.
- **Esc semantics**: back pops one level everywhere. The title screen and the main menu do nothing on Esc. Results
  keep their explicit buttons.
