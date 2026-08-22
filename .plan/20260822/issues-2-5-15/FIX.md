# FIX — Issues 2, 5, 15 (universal settings UI, dsh-memory built-in, update progress)

Synthesized from the review cycle (requirement-feasibility ×3, design over-engineering ×1, acceptance-verifiability ×2). No qa-produced FIX.md exists; the reviews ARE the QA for this plan-driven flow. Worker paths reference the implementation batches in task-list.md / workflow-script.js.

## Issue inventory

| ID   | Severity | Finding                                                                                    | Status                                                                                                                          |
| ---- | -------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| R1-1 | P1       | FR-2.3: pattern-string claimed as select (not schema-derivable)                            | FIXED (prd/design/acceptance) — verified PASS by 42176b4d                                                                       |
| R1-2 | P1       | FR-5.3: keyless boot falsely claimed "calls llm.stream" / "no disk touch"                  | FIXED — verified PASS by 42176b4d                                                                                               |
| R1-3 | P1       | FR-2.4 vs FR-2.7 hand-edit tension                                                         | FIXED (escape-hatch scoping) — verified PASS by 42176b4d                                                                        |
| R2-1 | P2       | Design over-engineering review findings                                                    | APPLIED earlier (design.md render-tree, migration table)                                                                        |
| R3-1 | P2       | FR-15.4 evidence cites wrong test file (decision.test.mts) + non-existent spawn assertions | FIXED (update-overlay.test.mts; S4-pending spawn assertions marked)                                                             |
| R3-2 | P2       | FR-15.6 env var UNITERRA_UPDATE_CMD does not exist                                         | FIXED (UNITERRA_UPDATE_COMMAND, verified main.ts:301)                                                                           |
| R3-3 | P2       | FR-5.3 evidence cites phantom profile-bootstrap test                                       | FIXED (builtin-pbt REGISTRY property + container replay)                                                                        |
| R3-4 | P3       | FR-5.5 cites non-existent docs §manual tests                                               | FIXED (record steps in docs/modules/uniterra-desktop.md)                                                                        |
| R3-5 | P2       | FR-2.4: replace round-trip test missing; "PBT" overclaim                                   | FIXED — bridge.test.mjs "replace round-trips a wholesale section through the seam (FR-2.4)" (test 9) green; doc wording applied |
| R3-6 | P2       | FR-2.7: re-describe-after-edit test missing                                                | FIXED — bridge.test.mjs "external document edits re-describe once the provider watch settles (FR-2.7)" (test 10) green          |
| R3-7 | P3       | FR-15.4 overlay-spawn unit assertions absent                                               | FIXED — updater-flow.test.mjs asserts overlay spawn options (detached: false, stdio piped, --no-open); desktop suite 40/40      |

## Fix workers

- **B1 (docs citations)**: coordinator (procedural) — DONE, verified on disk.
- **B2 (settings-ui tests)**: subagent eda41014 (S1) — DONE. Tests added (bridge replace round-trip + re-describe; field-tree collectFieldPaths; widget-registry virtual/field split + PBT); settings-ui 28/28 green on the rebuilt lib/.
- **B3 (provider migration, S3)**: coordinator takeover (S3 stalled; fix-skill coordinator-fix precedent, disclosed) — widgets (model-catalog.tsx, api-key.tsx) + apply.ts rewrite landed, UniterraSection.tsx deleted, no settings.section registration remains; provider build/tests in flight.
- **B4 (desktop overlay, S4)**: batch2-prompts.json s4 — DONE. Overlay flow landed; desktop build green; 40/40 tests (builtin-pbt 29 incl. 10 npm specs + updater-flow 11); lint + typecheck clean.
- **B5 (docs, S5)**: coordinator — DONE. AGENTS.md (10 npm plugins incl. dsh-memory, 2 workspace plugins, settings-ui package + test bullets, desktop-test phrasing) and CHANGELOG Unreleased entries for #2/#5/#15 applied.

## Batch schedule

B1 (done) → B2 (in flight; gate: S1 test suite green or tsc-clean + hand-verified with environmental note) → pnpm install (workspace devDep link) → B3+B4 parallel (disjoint files: provider/src vs desktop/src+test) → gate: provider build → lib/ + desktop build + updater tests + builtin-pbt 10 specs → B5 → gate: lint/typecheck (build first), all suites, docs match.

## Verification gates

1. B2: 4 settings-ui test files green (or deferred to final gate with environmental blocker marked); tsc -p tsconfig.json + tsconfig.client.json clean.
2. B3: provider build → lib/; grep no settings.section in provider; UniterraSection.tsx gone; provider dual-protocol + reasoning suites green.
3. B4: desktop build; updater decision+overlay suites green; builtin-pbt 29/29 with 10 npm specs; overlay spawn assertions present.
4. Final: pnpm run lint + typecheck (build first); all package suites; acceptance re-review against final tree (704abea0 findings closed); then review skill → REPORT.md → branch/commit/push/PR (user: "/review , then raise pr" — commit AFTER review; overrides fix-skill commit step).

## Rules

- Disjoint file sets per batch (trusted; verified by final git diff).
- No new dependencies beyond approved list (issue 15 ora/cli-progress optional — not adopted).
- No default exports; NodeNext ESM; eslint strictTypeChecked --max-warnings 0.
- Machine memory-starved: esbuild service wedges → pkill -f "esbuild --service" + retry; park build/test re-runs at final gate if wedged.
