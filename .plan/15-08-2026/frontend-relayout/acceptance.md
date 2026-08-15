# Frontend Relayout — Acceptance

Final gate for the desktop frontend relayout (`.plan/15-08-2026/frontend-relayout/`).
All changes are visual/layout-only inside `vendor/pi-gui/apps/desktop`; the ONLY
behavioral addition is the new-thread two-state composer's CSS-class toggle (T3).

## 0. Build gate (re-runnable, verbatim)

```bash
cd /Users/tszkinlai/uniterra/cardo
pnpm --filter @pi-gui/desktop build
pnpm --filter @pi-gui/desktop typecheck
```

- Both commands exit 0 with **0 errors** after ALL of T1–T4 land.
- PBT suites (`test:pbt`) need not rerun: no contract-layer files touched
  (AGENTS.md rule; only styles + one view component changed).
- Also run after **each** task individually (per-task verification in tasks.md).

## 1. Scope guards (AC-7)

```bash
git status --porcelain
```

Must show **only**:

```
vendor/pi-gui/apps/desktop/src/styles/sidebar.css
vendor/pi-gui/apps/desktop/src/sidebar.tsx
vendor/pi-gui/apps/desktop/src/styles/timeline.css
vendor/pi-gui/apps/desktop/src/styles/new-thread.css
vendor/pi-gui/apps/desktop/src/new-thread-view.tsx
vendor/pi-gui/apps/desktop/src/styles/main.css
vendor/pi-gui/apps/desktop/src/styles/jovaltus.css
```

plus the two planning docs in `.plan/`. Forbidden paths must be untouched:
`packages/*`, `design-demo/`, `docs/`, root tooling, `vendor/pi-gui` anything
outside `apps/desktop/src` (e.g. no `electron/`, no `packages/`). **No commits.**

Behavior-guard greps (all must hold):

```bash
# Only allowed JSX churn: new-thread-view.tsx (toggle) and sidebar.tsx (count span)
git diff --stat vendor/pi-gui/apps/desktop/src/new-thread-view.tsx   # ≤ ~10 lines
git diff --stat vendor/pi-gui/apps/desktop/src/sidebar.tsx           # ≤ ~3 lines
# No pill shapes outside true circles (allowed: --radius-pill on dots/avatars only)
grep -rn "999px" vendor/pi-gui/apps/desktop/src/styles/*.css         # expect only --radius-pill: 999px in tokens.css
# Undefined demo-only token removed
grep -rn "surface-2" vendor/pi-gui/apps/desktop/src/styles/          # expect 0 hits
# Wrapped-state rules are scoped (never leak to the thread composer)
grep -n "composer__editor-row" vendor/pi-gui/apps/desktop/src/styles/new-thread.css   # every hit inside a .new-thread__composer--wrapped rule
```

## 2. Per-page visual checklist (AC-8) — window 1480×980, light + dark

Run the dev app, screenshot each page, eyeball against `design-demo/index.html`:

**Threads (chat)**

- [ ] Sidebar: "Pinned" group header with count; per-workspace thread lists; "Archived" toggle + count; active row = 2px accent left border + surface bg + shadow (not a filled block); New-thread button = dashed border, accent hover.
- [ ] Topbar: `workspace / env-picker / session` breadcrumb; terminal/changes/files/prompt-rail icon buttons with kbd shortcut hints (hover tooltip).
- [ ] User message: right-aligned bubble, ≤62% width, surface bg + 1px border + shadow.
- [ ] Thinking block: collapsed chip "Thought for Ns" (mono 11px, dashed border, sharp 2px) → click expands to a 120px scroll window (mono 11px, muted-soft, NO surface box); streaming "Thinking…" chip while running.
- [ ] "Used N tools" group: card shell (border + surface + 4px radius), header strip with chevron + glyph chip + mono label + status; per-tool rows = icon chip + mono name + detail + status dot; auto-expanded while running, collapses when done; individual tool rows expand to their body.
- [ ] Composer: flat single row `[+] textarea [model] [send]`, 1px line-strong border + shadow shell; jovaltus plan-mode button + execute panel (spinner → green light → 3s auto-fade).
- [ ] No visual regression: diff panel, files panel, terminal (warm dark), summary cards, inline diff.

**New thread**

- [ ] Hero: "Let's build" serif 44px, eyebrow, workspace pill (sharp, shadow), composer 860px wide.
- [ ] Two-state composer (see §3).

**Settings / Skills / Extensions**

- [ ] Secondary shell: left rail (Back + serif 22px title + nav items; active item = 2px accent left border + surface bg + shadow), scrollable content.
- [ ] View headers serif (28px); settings rendered as cards on a ≤780px column; skills = single-column card list + sticky detail panel (serif detail title); extensions = card list + detail with tokens/diagnostics; search fields sharp.

## 3. Two-state new-thread composer behavior (AC-2) — manual + auto-wrap

| Interaction                                                                       | Expected                                                                                                                                         |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Type a long prompt until it auto-wraps past one line                              | Composer flips to wrapped: textarea fills the full first row; `[+]` (attach) + env/model/send wrap to a bottom row, attach left, controls right. |
| Press Shift+Enter (newline — the app's "manual Enter"; plain Enter still submits) | Wrapped state engages (flag also checks `prompt` contains `\n`).                                                                                 |
| Clear the prompt back to a single line                                            | Returns to the single-row layout (attach + textarea + controls on one center line).                                                              |
| Press Enter with content                                                          | Thread starts (existing submit logic, untouched); on return the composer is reset to single row.                                                 |
| Thread (non-new-thread) composer                                                  | Always single row — wrapped rules are scoped under `.new-thread__composer--wrapped` and never apply.                                             |

## 4. Interaction acceptance (AC-3, AC-4, AC-5)

- [ ] **User bubble right-aligned** (AC-3): send a message, verify bubble sits right with surface bg + shadow + ≤62% width in both themes.
- [ ] **Thinking pill expands** (AC-3): click "Thought for Ns" chip → 120px scroll body appears; click again → collapses.
- [ ] **Tool group collapses** (AC-3): "Used N tools" header toggles the group body; while any tool runs it stays open.
- [ ] **Jovaltus graph opens** (AC-4): in plan mode, run `/planmode`, execute → panel shows spinner → green; click panel → right-side graph popup with batches (parallel nodes, done/running/pending + legend); Escape or backdrop click closes; panel auto-fades ~3s after done.
- [ ] **No feature regression** (AC-5): submit composer (Enter + send button), switch sessions, pin/unpin/archive, open settings (each section), toggle terminal/changes/files, toggle plan mode (shift+tab + mode button), slash `/` menu, mention `@` menu, drag-drop attachments, thread rename, workspace menu.

## 5. Bounded live self-verification recipe (AC-6) — run ONCE after all tasks, ~4 interactions

```bash
cd /Users/tszkinlai/uniterra/cardo
pnpm --filter @pi-gui/desktop dev   # dev app; uses the pi-dev user-data dir (AGENTS.md)
```

1. **Threads view** — open an existing session. Assert (screenshot):
   a. last user message is a right-aligned bubble (surface bg, shadow, ≤62% width);
   b. a "Used N tools" group is rendered as a card; click collapses/expands it;
   c. a "Thought for Ns" chip is present; click opens the 120px thinking window.
2. **New-thread view** — click New thread. Type a long prompt (paste a 2–3 line paragraph) →
   assert the composer wrapped (textarea full first row, controls on the bottom row, attach left).
   Press Shift+Enter → still wrapped. Clear the text → assert single row returns.
3. **Settings** — open Settings → Appearance. Assert serif title + card layout with the
   theme-preset grid; toggle a theme preset and confirm the palette flips without layout break.
4. **Gate** — close dev app, then:
   `pnpm --filter @pi-gui/desktop build && pnpm --filter @pi-gui/desktop typecheck` → 0 errors.

Total: ~4 interactions + 1 build, no full e2e run needed.

## 6. Pinned decisions carried over from tasks.md (do not relitigate)

- Demo "manual Enter" = real-app **Shift+Enter**; plain Enter submit is untouched (T3).
- **No Today/Earlier time-bucket labels** (grouping-logic change = out of scope); Pinned/Archived/section labels carry the demo style (T1).
- **No sidebar footer nav move** and **no assistant avatar** (DOM/structure changes = out of scope).
- **No pill shapes** except true circles: chips use `var(--radius-sm)` (2px) even where the demo uses 999px (03b token contract wins; T1/T2/T3).
- `.jovaltus-graph__batch` background fixed from the undefined `--surface-2` to `var(--surface-muted)` (T4).
- Canonical class names per the contract table in tasks.md §Pinned API/class contract — workers must not introduce demo class names.
