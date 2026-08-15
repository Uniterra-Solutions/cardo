# Design System — 03b Warm Paper Sharp

The desktop app (`vendor/pi-gui/apps/desktop`) uses a token-driven design
system: all visual decisions live in CSS custom properties, so restyling is a
token change, not a per-component sweep.

## Design Language

**Warm paper + sharp corners.** Warm paper neutrals (no cold greys) with a
burnt-terracotta accent; radii collapsed to a 0–4px scale. Sharpness reads as
precision and pairs with the serif page-title type. This replaces the original
Codex-style purple-on-grey look (2026-08-14, cardo restyle).

- **Sharp corners** — nothing pill-shaped except true circular status dots.
- **Warm palette** — background family `#f7f4ee` (light) / `#232019` (dark);
  accent burnt terracotta `#b4552d` (light) / `#cf6a3d` (dark).
- **Serif page titles** — `var(--font-serif)` on page-level titles only
  (chat header, session header, empty panel, new-thread hero, view headers).
  Body, buttons, and forms stay sans-serif (`var(--font-ui)`).
- **Active rows** — a selected thread/workspace row gets a `2px` accent left
  border, not a full filled block.

## Token Files

| File                              | Holds                                                                                     |
| --------------------------------- | ----------------------------------------------------------------------------------------- |
| `src/styles/tokens.css`           | Radius scale, spacing, motion, borders, status tints, code/diff colors, terminal colors   |
| `src/styles/base.css`             | Palette (`:root` + `:root.dark`), fonts, button primitives, focus ring                    |
| `src/styles/syntax-highlight.css` | Highlight.js token colors (warm-toned)                                                    |
| `src/theme-presets.ts`            | 8 user-selectable color presets (Catppuccin, Nord, …) that override **color tokens only** |

## Key Tokens

### Radii (sharp scale)

| Token                                         | Value   | Used for                                               |
| --------------------------------------------- | ------- | ------------------------------------------------------ |
| `--radius-2xs` / `--radius-xs`                | `0px`   | flat panels                                            |
| `--radius-sm` / `--radius-md` / `--radius-lg` | `2px`   | buttons, inputs, chips, tool calls, code blocks        |
| `--radius-xl` … `--radius-4xl`                | `4px`   | composer shell, larger surfaces                        |
| `--radius-pill`                               | `999px` | **only** true circular elements (status dots, avatars) |

Rule: never use `--radius-pill` on a non-circular element.

### Palette (light)

| Token                                 | Value                             |
| ------------------------------------- | --------------------------------- |
| `--main` / `--sidebar`                | `#f7f4ee` / `#f7f4ed`             |
| `--surface`                           | `#fffdf7`                         |
| `--surface-muted`                     | `#efeae0`                         |
| `--line` / `--line-strong`            | `#e7e0d3` / `#d8cfbe`             |
| `--text` / `--text-strong`            | `#4a443a` / `#26221b`             |
| `--muted` / `--muted-soft`            | `#8c8373` / `#a9a08e`             |
| `--accent`                            | `#b4552d` (burnt terracotta)      |
| `--success` / `--error` / `--warning` | `#3d7a4e` / `#b3403a` / `#b7791f` |

Dark variants are the same family inverted (`--main #232019`, `--accent #cf6a3d`,
text `#f2eee6`, lines `#3a352c` / `#4a4438`).

### Fonts

| Token          | Value                                                              |
| -------------- | ------------------------------------------------------------------ |
| `--font-ui`    | `ui-sans-serif, -apple-system, "SF Pro Text", …`                   |
| `--font-serif` | `"Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif` |
| `--font-mono`  | `ui-monospace, "SF Mono", "Cascadia Code", Consolas, monospace`    |

### Terminal

The integrated terminal is fixed dark with warm tinting — dedicated tokens so
it does not flip with the app theme:

`--terminal-bg #221f1a`, `--terminal-border #3a352c`, `--terminal-text #d7d0c4`,
`--terminal-muted #a99f8d`, `--terminal-input #f2eee6`.

The xterm instance in `terminal-panel.tsx` mirrors these values in its theme
object (it cannot read CSS variables).

## Surface Conventions

### Sidebar (2026-08-16 relayout)

The sidebar follows the approved demo ("Warm Workbench"):

- **Titlebar strip (0–48px)** — the sidebar toggle sits flush at the window's
  top-left corner (`.sidebar-toggle` at `12px 11px`, 30×30); the macOS traffic
  lights are positioned right of it (`trafficLightPosition {x:56, y:18}`, so
  they span ≈56–110px) and never cover it in windowed mode. In collapsed
  sidebar mode the main column clears both (`--traffic-light-right: 110px`).
  The strip is a drag region.
- **Top (below the strip)** — only the "New thread" button (`--radius-lg`,
  dashed border that turns terracotta on hover), starting at y 48 so it is
  clear of the traffic lights and the corner toggle in every window mode.
- **Middle** — thread list bucketed into **Today / Earlier** group labels
  (`.thread-group__label`: 10.5px uppercase bold, `--muted-subtle`, sharp
  0px radius) by `session.updatedAt` (display-only; sort order preserved).
  Pinned threads (`.pinned-thread-group__head` + count) sit above, Archived
  (`--toggle` + count) below.
- **Bottom** — `sidebar__footer` nav: a 4-column icon+label grid
  (Threads / Skills / Extensions / Settings), 10.5px labels, active item =
  `--surface` bg + `--shadow-sm` + accent ink. The active thread row uses a
  2px accent left border + surface bg + shadow (not a filled block).

## Surface Conventions

Global elements that repeat on every page are styled once in `base.css`, not
per surface.

### Scrollbars (all pages)

Scrollbars are deliberately unobtrusive — a faint warm thumb over a transparent
track, visible only while scrolling:

| Property    | Value                                                            |
| ----------- | ---------------------------------------------------------------- |
| Width       | `7px` (vertical and horizontal)                                  |
| Track       | fully transparent                                                |
| Thumb       | `color-mix(in srgb, var(--muted) 26%, transparent)` — ~26% muted |
| Thumb hover | ~45% muted (`var(--muted)`), sharp `--radius-sm` (2px)           |
| Firefox     | `scrollbar-width: thin` + `scrollbar-color: … transparent`       |

Rules: never give scrollbars a filled track, a pill thumb, or a fixed colour
outside the `--muted` family (preset-aware). The xterm terminal renders its own
scrollbar (`.xterm .scrollbar`) and is exempt.

### Reasoning block (timeline)

Streaming reasoning is **not** a surface box — no background, border, or
shadow. The text sits directly on the timeline in a fixed-height window
(`height: 120px`, `overflow-y: auto`) so the block never grows with its
content. Reasoning text is `--font-mono` 11px in `--muted-soft`, lighter and
smaller than assistant text to keep it visually subordinate. While the model is
still thinking the window is pinned to the newest content (past text scrolls
up and out of view); finalized thinking collapses to a "Thought for Ns" row
that expands on click.

The collapsed chip (`.timeline-thinking__header`) is **borderless** (review
feedback, 2026-08-16): mono 11px `--muted-strong`, no dashed border, sharp
`--radius-sm`, glyph in a small `--surface-muted` chip. The parent
`.timeline-thinking` uses `justify-items: start` so the chip stays at content
width instead of stretching to the full timeline row.

### Composer (input box)

Chat and new-thread composers share one **single-row layout** — every control
lives on the same line as the textarea inside the input box
(`.composer__editor-row`), left to right:

1. **leading** — attach button (`.composer__attach`, `aria-label="Attach files"`)
2. **middle** — the textarea, growing (`flex: 1`), vertically centered
3. **trailing** — selectors flush against the send button: environment as a
   native `<select>` with chevron (new-thread only), model and thinking badges
   with a `ChevronDownIcon` caret
4. **far right** — primary action button (send arrow / stop)

There is no second footer row. Controls are flat and borderless (transparent
background, hover tint only) so they read as part of the single input box, not
a second layer of boxes. Text centering is explicit: the textarea defaults to
`rows="2"` (two intrinsic lines, text top-aligned), so the single-row textarea
gets an explicit `height: 36px` + `padding: 7px 0 6px` to sit on the same
center line as the 36px controls; multi-line input grows via the JS
auto-height effect. Selector badges set `white-space: nowrap` so label +
chevron never wrap to two lines when the row is narrow.

The surface shell is **borderless** with a soft shadow (review feedback,
2026-08-16): `border: 0`, `box-shadow: var(--shadow-md)`, `--radius-4xl`
(4px). There is **no** `0 0 0 1px` focus-ring layer, and the composer
textarea suppresses the global accent `:focus-visible` ring
(`.composer textarea { box-shadow: none }`) — the shell's shadow already
marks the focus surface. All selectors are dropdowns (native `<select>` or
badge menus) — no segmented button groups inside the composer (the fork
modal keeps its segmented radio group).

### Composer two-state (wrapped) behavior

Both chat and new-thread composers share a **two-state layout** driven by
`ComposerSurface` (a single `composer__surface--wrapped` class toggle, no
per-view logic):

| State                                | Layout                                                                                                                                                                                |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Single line** (draft fits)         | `[+] [textarea] [model] [thinking] [send]` on one center line                                                                                                                         |
| **Wrapped** (draft exceeds one line) | textarea takes the full first row; attach (first child) + trailing controls (model/thinking/send, `:nth-child(3)` and later) wrap to a bottom row — attach left, controls flush right |

Trigger: the auto-grow effect measures `scrollHeight > 36px` **or** an
explicit newline in the draft (Shift+Enter in chat; the new-thread composer
maps plain Enter to submit and Shift+Enter to a newline). Clearing the draft
returns to single line. Height grows up to 260px, then internal scroll.

Important: only the **first** trailing control gets `margin-left: auto`
(`:nth-child(3)`) — a second auto margin on the plan-mode button
(`:nth-child(4)`) would split the free space and shift the controls off the
right edge. The wrapped rules are scoped under
`.composer__surface--wrapped` in `new-thread.css` so the thread composer's
base `.composer__editor-row` in `main.css` stays untouched.

### New-thread mode picker (Jovaltus plan vs standard)

The new-thread hero (below the workspace picker, **outside** the composer)
carries a small segmented control `.new-thread__mode` for the Jovaltus
thread mode — `standard | plan` buttons with a status dot, active option on
`--accent-tint-bg` with accent ink (same dot-language as the composer's
plan-mode button in `jovaltus.css`). Default is `standard`; the selection
resets with the rest of the new-thread surface. Choosing `plan` starts the
conversation already in plan mode (see `docs/modules/plan-mode.md`).

## Theme Presets

`theme-presets.ts` exposes 8 user-selectable presets. Presets override
**color tokens only** — radii, fonts, and layout are structural and identical
across presets. The `default` preset uses empty tokens (falls back to
`base.css`). Adding a preset = adding a `light`/`dark` token map + a
`ThemePreset` entry; no structural CSS changes needed.

## Changing the Look

1. Prefer a token change in `tokens.css` / `base.css` over a per-component edit.
2. Keep radii ≤4px and warm; never reintroduce cold greys or pill shapes.
3. After any desktop style change, run:
   ```bash
   pnpm --filter @pi-gui/desktop build
   pnpm --filter @pi-gui/desktop typecheck
   ```
4. Visual verification (hermetic): launch the app via
   `electron.launch()` with `PI_APP_TEST_MODE=background` + a temp
   user-data-dir/agent-dir, read computed styles against the token contract
   (see `docs/testing.md` → Desktop app gates).
