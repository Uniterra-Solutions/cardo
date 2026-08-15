# Frontend Relayout — Requirements

Goal: apply the design language from `design-demo/index.html` ("Warm Workbench")
to the real desktop app (`vendor/pi-gui/apps/desktop`) **without changing any
feature behavior**. All functionality stays; only layout/visuals change.

## Demo as the spec

The approved demo is `design-demo/index.html` (open in Safari to compare).
Its visual language:

- **Sidebar**: threads grouped as Pinned / Today / Earlier / Archived with
  visible group labels + counts; active thread row = 2px accent left border +
  surface bg + shadow (not a full filled block). Bottom nav: Skills /
  Extensions / Settings with icons.
- **Topbar**: breadcrumb `workspace / environment / session`, right actions
  (terminal / changes / files / prompt rail) as icon buttons with shortcut
  hints.
- **Chat**: user message = right-aligned bubble (max-width 62%, surface bg,
  border, shadow); assistant = avatar + text block; thinking = collapsed
  pill "Thought for Ns" that expands to a 120px fixed-height scroll window
  (mono 11px, muted-soft, NO surface box); tool calls of one agent turn =
  collapsible "Used N tools" group with per-tool rows (icon + name + detail +
  status), auto-expanded while running.
- **Composer (chat)**: single row, flat controls (attach / model / thinking
  badges + send), 1px border + shadow shell. Jovaltus plan-mode: execute
  panel above input (spinner → green light → auto-fade), click opens
  right-side execution graph popup (batches of parallel subagent nodes,
  done/running/pending states + legend).
- **New thread**: serif hero "Let's build" + workspace pill; composer fixed
  width (860px) with TWO states: single line `[+] [textarea] [env] [model]
[send]` when content fits; when content exceeds one line (manual Enter or
  auto-wrap) → textarea takes full first row, `[+] [env] [model] [send]`
  wrap to a bottom row (attach left, controls right).
- **Settings / Skills / Extensions**: unified secondary-surface shell —
  left sidebar (Back + serif title + nav items) + scrollable content; view
  headers serif; settings as cards; skills as card list + sticky detail
  panel; extensions as list cards.

## Existing app already has (VERIFY before touching)

The source already implements many structures the demo visualizes; do NOT
duplicate them, only restyle where the demo differs:

- `timeline-item.tsx`: TimelineThinkingItem (collapsible "Thought for Ns",
  120px body), TimelineToolGroupItem ("Used N tools" collapsible group),
  TimelineMessage (user bubble vs assistant).
- `jovaltus-ui.tsx`: JovaltusExecutePanel + JovaltusGraphPopup (batches →
  agent nodes) fully implemented.
- `sidebar.tsx` + `thread-groups.ts`: pinned groups, session rows, footer nav.
- `secondary-surface.tsx`: unified shell for settings/skills/extensions.
- `composer-surface.tsx` / `composer-panel.tsx`: single-row composer.

## Expected diffs (demo vs current app)

Read each file and identify what is actually different. Candidate areas:

1. `src/styles/sidebar.css` — group labels/counts visibility, active row
   treatment (2px accent left border + surface bg vs current), footer nav
   icon style.
2. `src/styles/timeline.css` — user bubble right-aligned treatment vs
   current; assistant block spacing; thinking collapsed pill styling;
   tool-group item row styling (icon/name/detail/status).
3. `src/styles/composer.css` (if exists) or in timeline.css — composer
   shell, flat control styling, execute panel spacing.
4. `src/styles/new-thread.css` — TWO-STATE composer (single line ↔ wrapped
   full-width textarea + bottom controls row). Current composer is single
   row only; the wrap-below behavior needs CSS + small JS (class toggle on
   Enter/width overflow) without changing the submit logic.
5. `src/styles/topbar.css` — breadcrumb + icon button with shortcut hints.
6. `src/styles/jovaltus.css` — execute panel + graph popup already styled;
   verify matches demo.
7. `secondary-surface` / settings / skills / extensions CSS — verify against
   demo (serif view headers, settings cards, skill card list + detail).

## Constraints (AGENTS.md)

- All changes are visual/layout only inside `vendor/pi-gui/apps/desktop`.
  Vendored code edits are allowed as restyle patches (existing `// Cardo:`
  pattern) but NEVER touch behavior logic unless it is the new-thread
  two-state composer's tiny CSS-class toggle.
- After any desktop style change: `pnpm --filter @pi-gui/desktop build` +
  `pnpm --filter @pi-gui/desktop typecheck`. If pure CSS changed and no
  contract-layer files touched, PBT suites need not rerun, but build+typecheck
  MUST pass.
- Do NOT modify `packages/*`, `design-demo/`, docs, or root tooling.
- Token system: radii ≤4px, warm palette, serif page titles, no pill shapes
  except true circles (per docs/design-system.md 03b Warm Paper Sharp).
- CSS class names must match existing component class names (the demo uses
  simplified names; the real app uses its own).

## Acceptance (overall)

- App renders every page (threads / new-thread / settings / skills /
  extensions) with the demo's visual language at 1480×980.
- New-thread composer: single line ↔ wrapped two-state behavior works with
  real typing (manual Enter and long-text auto-wrap).
- User bubble right-aligned; thinking pill expands; "Used N tools" group
  collapses/expands; Jovaltus execute panel opens the graph popup.
- `pnpm --filter @pi-gui/desktop build` and `typecheck` pass with 0 errors.
- No feature regression: submit composer, switch sessions, open settings,
  toggle terminal/changes/files, plan-mode toggle all still work.

## Bounded live self-verification recipe (~4 interactions)

1. Launch dev app (`pnpm --filter @pi-gui/desktop dev`), screenshot threads
   view: user bubble right, tool group visible, thinking pill present.
2. Open new-thread view, type a long prompt + press Enter → composer wraps
   (textarea full first row, controls bottom row). Clear → single row.
3. Open settings → Appearance; verify serif title + card layout.
4. Run `pnpm --filter @pi-gui/desktop build && typecheck` — 0 errors.
