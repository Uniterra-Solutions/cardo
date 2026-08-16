# Real-time streaming delivery — non-quadratic refactor · acceptance.md

Date: 2026-08-16 · Target: `vendor/pi-gui/apps/desktop` + `test/pbt/*` (PBT-compiled via
`tsconfig.pbt.json`). Companion: `tasks.md` (3-task serial DAG T1→T2→T3, FIXED API contract,
ownership map).

The refactor is ACCEPTED when every gate below passes. Gates are re-runnable verbatim from the
repo root unless a working directory is given. "Byte-compatible" = the renderer's final state
content (JSON) is identical whether it arrives via full snapshots or via full + deltas.

---

## §0 Baseline (verified by the planning subagent on 2026-08-16, BEFORE any change)

Run: `pnpm --filter @pi-gui/desktop test:pbt`

```
# tests 105
# pass 103
# fail 2
```

The ONLY red tests are the K′ pair — the refactor target, not regressions:

```
not ok 47 - K′: the full fold path must not rebuild the whole transcript array per event
            Property failed after 1 tests · Counterexample: [300] · Shrunk 1 time(s)
not ok 48 - K′ (deterministic): 3000 events must fold with linear rebuild work
            TypeError: Method Map.prototype.get called on incompatible receiver #<Map>
            (store-liveness.test.mts proxyRebuildWork — the harness Proxy's `get` trap is not
            intercepted; see tasks.md "Repo facts")
```

Green and load-bearing (must STAY green through the whole refactor): K / K (deterministic) /
unit (store-liveness), J (store-liveness), A–D (streaming-sync), E–J (transcript-delta), and the
persistence / workspace-records / state-transitions / integrated-flow / app-store-diff lanes.

**Known unrelated pre-existing flake** (documented, NOT in scope, do not fix): `json-file-store:
write → read roundtrip preserves arbitrary JSON payloads and keys` (persistence.test.mts:427)
failed 1 of 3 isolated runs (fast-check seed 1080680249, counterexample `["",[-0]]` — a `-0`
JSON roundtrip seed). Baseline full-suite run #1 was clean 103/2. If it appears during the final
×3 gate, re-run the suite; the gate counts a run as stable when only this known seed flake
failed.

---

## §1 PBT gate — the whole refactor

Command (repo root):

```
pnpm --filter @pi-gui/desktop test:pbt
```

Run **3 consecutive times**; every run must end `# fail 0` and `# pass` ≥ 105 + new tests
(T1: `test/pbt/transcript-store.test.mts`; T2: `test/pbt/state-delta.test.mts` — record the
exact `# tests`/`# pass` numbers from the final run in the PR).

Required deltas vs baseline:

- K′ property + K′ deterministic: RED → GREEN (the acceptance of task A).
- K / K (deterministic) / unit / J: stay GREEN.
- A–D (streaming-sync), E–J (transcript-delta): stay GREEN.
- New: transcript-store tests (entry append/replaceById/removeById/findById O(1)/chunk
  rolling/toArray order/identity/parts finalize/K′-style budget) and state-delta tests
  (CONV/ID/DEC/ORCH/REV per tasks.md §T2) — all GREEN.

Revert-verifies (locked by these tests):

- Stash the T1 timeline refactor (keep the harness `get` fix) → K′ pair RED; restore → GREEN.
- Re-introduce `structuredClone(state)` at app-store.ts:312 → state-delta CONV RED; remove →
  GREEN.

## §2 Typecheck + lint

```
pnpm --filter @pi-gui/desktop typecheck
pnpm run lint
```

Both exit 0 (lint: strictTypeChecked, max-warnings 0). Typecheck covers the renderer program
(`src/state-delta.ts`, `src/app/desktop-app-state.ts`, `src/ipc.ts`) and the electron program
(`electron/main.ts`, `electron/preload.ts`, `electron/app-store*.ts`, `electron/session-state-map.ts`).

## §3 Store benchmark gate (per-event fold cost must not grow with transcript length)

Precondition: `pnpm --filter @pi-gui/desktop test:pbt` has run once (compiles `out-pbt/`).
Run from `vendor/pi-gui/apps/desktop`:

```bash
node --input-type=module <<'EOF'
import { appendAssistantDelta, appendThinkingDelta, applyTimelineEvent, finalizeActiveThinking } from "./out-pbt/desktop/electron/app-store-timeline.js";
import { applySessionEventState } from "./out-pbt/desktop/electron/app-store-session-state.js";
import { createEmptyDesktopAppState } from "./out-pbt/desktop/src/desktop-state.js";
import { sessionKey } from "@pi-gui/pi-sdk-driver";
const REF = { workspaceId: "bench-ws", sessionId: "bench-session" };
const KEY = sessionKey(REF);
function freshCaches() {
  return {
    transcriptCache: new Map(),
    runningSinceBySession: new Map(), lastViewedAtBySession: new Map(),
    activeAssistantMessageBySession: new Map(), activeWorkingActivityBySession: new Map(),
    activeThinkingBySession: new Map(), runMetricsBySession: new Map(),
  };
}
function initialState() {
  const s = createEmptyDesktopAppState();
  return { ...s, selectedWorkspaceId: "bench-ws", selectedSessionId: "bench-session",
    workspaces: [{ id: "bench-ws", name: "bench", path: "/tmp/bench", lastOpenedAt: "2026-06-01T00:00:00.000Z", kind: "primary", sessions: [{ id: "bench-session", title: "bench", updatedAt: "2026-06-01T00:00:00.000Z", preview: "", status: "idle", hasUnseenUpdate: false }] }] };
}
function buildEvents(n) {
  const events = []; const baseTs = Date.parse("2026-06-01T00:00:00.000Z"); let toolIndex = 0;
  events.push({ type: "sessionOpened", sessionRef: REF, timestamp: new Date(baseTs).toISOString(),
    snapshot: { ref: REF, workspace: { workspaceId: "bench-ws", path: "/tmp/bench" }, title: "bench", status: "running", updatedAt: new Date(baseTs).toISOString(), queuedMessages: [] } });
  for (let i = 1; i < n; i += 1) {
    const ts = new Date(baseTs + i * 10).toISOString();
    if (i % 10 === 0) { toolIndex += 1; const callId = `call-${toolIndex}`;
      events.push({ type: "toolStarted", sessionRef: REF, timestamp: ts, toolName: "read", callId, input: { path: `/tmp/bench/f-${toolIndex}.ts` } });
      events.push({ type: "toolFinished", sessionRef: REF, timestamp: ts, callId, success: true, output: `export const v = "${"x".repeat(2000)}";` }); continue; }
    if (i % 7 === 0) { events.push({ type: "assistantThinkingDelta", sessionRef: REF, timestamp: ts, text: `reasoning step ${i} ` }); continue; }
    events.push({ type: "assistantDelta", sessionRef: REF, timestamp: ts, text: `delta ${i} ` });
  }
  return events;
}
function fold(n) {
  const c = freshCaches(); let state = initialState();
  for (const ev of buildEvents(n)) {
    if (ev.type === "assistantDelta") { finalizeActiveThinking(c.transcriptCache, c.activeThinkingBySession, ev.sessionRef); appendAssistantDelta(c.transcriptCache, c.activeAssistantMessageBySession, ev.sessionRef, ev.text); }
    else if (ev.type === "assistantThinkingDelta") appendThinkingDelta(c.transcriptCache, c.activeThinkingBySession, ev.sessionRef, ev.text);
    applyTimelineEvent(c.transcriptCache, ev, { runMetricsBySession: c.runMetricsBySession, runningSinceBySession: c.runningSinceBySession, activeAssistantMessageBySession: c.activeAssistantMessageBySession, activeWorkingActivityBySession: c.activeWorkingActivityBySession, activeThinkingBySession: c.activeThinkingBySession });
    state = applySessionEventState(state, ev, c.transcriptCache, c.runningSinceBySession, c.lastViewedAtBySession);
  }
}
fold(500); // warm-up
const t0 = process.hrtime.bigint(); fold(3000); const t1 = process.hrtime.bigint();
const us = Number(t1 - t0) / 3000 / 1000;
console.log(`3000 events: ${us.toFixed(2)} µs/event`);
if (us >= 4) { console.error("FAIL: store fold ≥ 4 µs/event"); process.exit(1); }
EOF
```

Gate: prints `3000 events: < 4.00 µs/event` and exits 0. (Optional growth check: run the same
fold at n=500 and n=3000 — per-event cost at 3000 must be within ~2× of n=500, i.e. no longer
quadratic; the hard gate is the 4 µs absolute bound.)

## §4 Bounded live self-verification recipe (orchestrator, AFTER `build`)

New spec `tests/core/streaming-delivery-live.spec.ts` (written by T3, run by the orchestrator
once after the full build; ~4–5 interactions, ~90 s; patterns from
`tests/core/transcript-staleness.spec.ts` + `tests/live/extensions-dialogs.spec.ts`, helpers from
`tests/helpers/electron-app.ts`):

1. `launchDesktop(await makeUserDataDir(), { initialWorkspaces: [await makeWorkspace("stream-live")], testMode: "background" })` → `firstWindow()`.
2. `createNamedThread(window, "Stream live")`; `getDesktopState(window)` → assert `selectedSessionId` truthy and `revision > 0` (full snapshot path delivered).
3. Submit a message through the composer → poll `getDesktopState(window)` until `revision` strictly increases AND the sidebar session `preview` contains the submitted text (state-delta channel keeps the pushed state current) AND `getByTestId("transcript")` contains the text (transcript-delta channel intact).
4. Click the sidebar toggle (`.sidebar-toggle`) → assert the sidebar collapses AND `getDesktopState(window)` returns `sidebarCollapsed: true` (proves IPC round-trips are NOT stalled — the original bug symptom).
5. Close the harness.

Gate: the spec passes; the two existing e2e specs also pass (see §5).

## §5 E2E lane (existing specs — regression net for byte-compatibility)

Requires the orchestrator's `pnpm --filter @pi-gui/desktop build`. Run from the desktop dir
(`vendor/pi-gui/apps/desktop`), env per AGENTS.md:

```
PI_APP_TEST_MODE=background PI_OFFLINE=1 PI_APP_DISABLE_CARDO_UPDATE_CHECK=1 node_modules/.bin/playwright test -c playwright.config.ts tests/core/transcript-staleness.spec.ts
PI_APP_TEST_MODE=background PI_OFFLINE=1 PI_APP_DISABLE_CARDO_UPDATE_CHECK=1 node_modules/.bin/playwright test -c playwright.config.ts tests/live/extensions-dialogs.spec.ts
PI_APP_TEST_MODE=background PI_OFFLINE=1 PI_APP_DISABLE_CARDO_UPDATE_CHECK=1 node_modules/.bin/playwright test -c playwright.config.ts tests/core/streaming-delivery-live.spec.ts
```

All three green. These cover: transcript content after external-writer relaunch (full-snapshot
path), extension dialog flows (extension-UI state slices + notifications over the delta path),
and the bounded live recipe (§4).

## §6 Behavior-preservation contract (byte-compatibility evidence)

1. **PBT CONV** (state-delta): `applyStateDelta(prev, computeStateDelta(prev, next))` is
   `JSON.stringify`-equal to `next` — the renderer's final state content is identical under the
   delta path vs the full path.
2. **PBT E (transcript-delta) + A/B/C (streaming-sync)** stay green — transcript cache array
   semantics (id/kind/text/order), identity, and content accounting unchanged; the entry's
   `toArray()` reproduces the exact array content and item order of the previous cache arrays.
3. **IPC protocol unchanged**: `pi-gui:state-changed`, `pi-gui:selected-transcript-changed`,
   `pi-gui:transcript-delta` keep their names, directions and payload shapes; ONLY the two new
   channels (`pi-gui:state-delta`, `pi-gui:orchestration-changed`) are added. `state-changed`
   now carries the full state minus `orchestrationChildren` (which arrives on its own channel);
   the renderer merges both — final `DesktopAppState` content identical to pre-refactor.
4. **`DesktopAppState` shape unchanged** (`src/desktop-state.ts` untouched); the hook return
   shape `[snapshot, setSnapshot, selectedTranscript]` unchanged (`App.tsx` untouched).

## §7 Scope guard + hygiene

- `git status` (repo root) shows ONLY the owned files from the tasks.md ownership map
  (T1: 9 files · T2: 6 files · T3: 2 files) + `tasks.md`/`acceptance.md`; no stray files, no
  committed artifacts. Workers never commit; the orchestrator owns the merge.
- Every vendored edit carries a `// Cardo:` marker (grep: no modified vendored file lacks one).
- No transport change (in-process IPC retained); `electron/stream-publish.ts` coalescing
  untouched; `store.emit()`'s listener clone (app-store.ts:2730) untouched.
- Grep gates from tasks.md pass:
  - `electron/app-store.ts` line 312 no longer contains `structuredClone`.
  - `electron/app-store-timeline.ts` contains zero `[...transcript]` spreads and zero `findIndex`.
  - `tsconfig.pbt.json` includes `src/state-delta.ts`.
- Benchmark §3 green.

## §8 Docs/skill row (orchestrator-owned, optional but recommended)

Update `streaming-ui-delivery` skill → `references/cardo-store-liveness.md` (residual paragraph:
"persistent transcript structure would remove them" — now landed; record the new benchmark) and
the cardo-codebase SKILL.md residual bullet, so future sessions don't re-diagnose a fixed
residual.
