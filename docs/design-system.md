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
