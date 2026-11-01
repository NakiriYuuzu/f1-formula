# Game UI — "festival" look for menus and HUD (2026-11)

The user rejected the flat true-black redesign (`ui-redesign-2026-11.md`) as too app-like and asked for a game UI
"like Horizon 6": the open-world festival racing look. This plan replaces the visual rules of that document
(its §1–§3). Its §4 (navigation: back button, key-cap hints, Q/E and LB/RB tabs, quick race, Esc semantics) still
applies unchanged. Everything here is our own design in that genre; no logos, icons or assets of any real game.

Tokens live in `src/ui/tokens.css`. Rules below name them.

## 1. Principles

1. **Colour fields, not grey boxes.** Main surfaces are big saturated fields: the main-menu tiles are solid festival
   colours (`--nv-c-*`), the active tab and the focused row are hot pink (`--nv-accent`). Panels behind data are
   dark glass (`--nv-panel`, translucent, with `--nv-glass` blur in menus) so the 3D world shows through.
2. **Focus is unmistakable from across the room.** Rows, buttons, cyclers, tabs: pink fill (`--nv-focus-bg`) with
   white text (`--nv-focus-ink`). Picture tiles and cards (track maps, team cards, main-menu tiles): a white ring
   (`--nv-ring`), lifted with `--nv-lift` (scale ≈ 1.04 with the `--nv-spring` ease) and the floating shadow.
   Keyboard, gamepad and mouse hover look the same (hover moves focus).
3. **Bold type.** Headings and labels are heavy (700–800) in `--nv-font`. Figures, positions, lap counts, speeds,
   gears and English words in titles use `--nv-font-display` (Barlow Condensed 800 italic), usually uppercase.
   Body copy stays sentence case at 400–500. Figures are tabular.
4. **One racing gesture: the slant.** Small accent shapes (active tab, primary button, title tags, HUD headers,
   banners) lean with `skewX(var(--nv-skew))`, their text counter-skewed upright. Big surfaces (tiles, panels, rows)
   stay rectangular with the small radius (`--nv-radius` / `--nv-radius-lg`).
5. **Colour still carries meaning in data.** Team identity colours, tyre compounds, timing purple/green/yellow,
   flags, DRS/ERS states and damage keep their tokens. Pink is the selection colour, never a data colour.
6. **Motion is part of the feel.** Screens slide in (≈ 40px, `--nv-med`), main-menu tiles rise in staggered
   (`--i` index × 35ms), the focused tile springs up. Banners slide in. `prefers-reduced-motion: reduce` removes
   travel and stagger (fades only).
7. **Button prompts look like a game.** Keyboard: light key caps with dark text. Gamepad: round face-button glyphs in
   their colours (`--nv-pad-a/b/x/y`), shoulder buttons as dark pills. Prompts sit bottom-right on a dark fade.
8. **Readable.** Text ≥ 11px at the smallest root. White text on pink holds 4.5:1 (`#e6106a`). Dark text
   (`--nv-ink`) on yellow/orange fields.

## 2. Menus (`src/ui/menus/*`)

- **Backgrounds.** Showroom layout: transparent over the 3D car, with a dark vignette from the left and the bottom
  so the tiles and prompts read. Panel layout: deep indigo-to-black field with a soft pink glow corner and a faint
  diagonal speed-line texture (CSS only).
- **Top bar.** Pink slanted "N" mark + wordmark; crumb and back button on the right.
- **Main menu = tabs + tile mosaic.** Tabs 比賽 / 生涯 / 多人 / 個人 (Q/E, LB/RB, click). Each tab shows a grid of
  tiles: one large hero tile (2×2) and medium tiles, each a colour field with a big drawn picture of what it opens
  (the quick-race track's real outline, a chequered flag, a stopwatch, a helmet, two split screens…), the title in
  heavy type at the bottom-left, a one-line sub. The profile (wins, podiums, poles, achievements) is a compact card
  top-right. The showroom car stays visible on the right.
- **Headings.** Screen titles are big and heavy, with a slanted pink tag before them.
- **Rows, cyclers, sliders.** Dark glass rows; focus = pink fill, white text, white slider fill/knob, white arrows.
- **Tabs elsewhere.** Same component as the main menu tabs: slanted pink fill for the active tab, LB/RB caps at
  the ends.
- **Cards** (tracks, teams, drivers, story chapters): dark glass, focus = white ring + lift; chosen = pink edge.
- **Primary button**: slanted pink with white text; focused = white fill with pink text (so it still reads as the
  focus inside a pink-less screen).
- **Dialogs and toasts**: dark glass with a pink top edge; toasts slide in from the right.
- **Loading card**: big wordmark, pink indeterminate bar, the tip below.

## 3. HUD (`src/ui/hud/*`)

- **Glass blocks** (`--nv-scrim`, no blur in the HUD for frame time) with `--nv-radius`. Headers of blocks are
  small slanted tags.
- **Speedometer (bottom-right).** A round gauge: rpm arc (white, the last stretch pink/red), shift LEDs as dots
  along the arc or above it, the speed in big display figures in the centre, the unit under it, the gear in a pink
  disc. Throttle (green) and brake (red) are thin arcs or bars beside it. ERS as a yellow arc or bar under the gear.
  DRS / overtake / limiter / wake as pills under the gauge. Tyre, damage silhouette and fuel stay in a compact card
  next to it; each part (front wing, floor, suspension, rear wing) has a "—o" callout (a ring on the part, a hairline to the card edge, the damage %
  above it and the part's name below).
- **Position and lap (top-right).** Huge display-face position (`P2` with `/22` small), lap `1/3`, lap timer, sector
  colours, gaps.
- **Timing tower (top-left).** Dark glass rows, a team-colour bar per row, positions in display figures, the player's
  row pink.
- **Minimap (bottom-left).** Rounded glass square, the player as a pink marker.
- **Race control, flags and notices.** Wide slanted banners that slide in, coloured by meaning (yellow flag yellow,
  safety car orange, penalties red, personal/overall best green/purple).
- **Pause menu.** Dark scrim with blur (the race is paused, the cost is fine), a big "已暫停" title, the items as big
  rows: focus = pink fill, white text, spring lift. Confirm dialog in the same style.
- **Start lights.** Red lamps that glow when lit.
- **No overlap** at 800×620, 1280×720, 1440×900, 1920×1080, and in split screen.
