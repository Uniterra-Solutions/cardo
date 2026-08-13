# Pi App MVP Plan

## Goal

Build a macOS-first Electron desktop MVP for `pi` with a Codex-style UX, while keeping a low-drift path to track upstream `pi-mono` and later swap to the official future `pi` WebSocket server with limited client churn.

## Constraints

- Any app-server must live outside `pi-mono`
- The maintainer expects a future WebSocket server with session operations similar to current RPC mode
- One focused session in the main pane is enough for `P0`, but the app should support a real workspace/session catalog from the start
- Existing terminal `pi` users must keep working without our app changing their workflow
- Worktrees and automations are Phase 2+
- Eventual upstream compatibility is a real goal

## Success Criteria

### P0

- Define a concrete companion-repo architecture with minimal dead-code risk
- Reuse `pi-mono` through published packages wherever practical
- Keep the durable client boundary small enough to survive a future server swap
- Define an end-to-end proof plan for the real Electron app surface
- Define visual/interaction parity targets for the Codex-style shell shown in the reference image, minus explicitly deferred features
- Support the core Codex-style workspace/session UX: open different folders, see sessions associated with those folders, and jump between them while keeping only one active session at a time
- Treat the left sidebar as a real product surface with explicit workspace and session catalogs, not just “recent sessions”
- Define exactly what is temporary versus intended to survive

### P1

- Identify the main migration risks and how we contain them
- Identify the minimum maintainer follow-ups still worth asking
- Define a path to true concurrent session execution with bounded resource policies
- Reach >=85% confidence that the MVP can be implemented without hidden architectural blockers

## Recommendation

- Create a separate `pi-app` repo
- Build the desktop app in Electron
- Do not build a large custom permanent server before the official `pi` server exists
- Keep the durable client boundary shaped like current RPC and the maintainer's future WebSocket command/event model
- Use an in-process SDK-backed driver for MVP
- Keep the desktop client behind one small durable interface so the backend implementation can later swap to the official WebSocket server
- Keep terminal compatibility by leaving upstream `pi` untouched in MVP

## Durable Boundary

The durable abstraction is a small `SessionDriver` contract used by the desktop app. It should be the only backend-facing API the UI knows about.

### `SessionDriver` methods

- `createSession()`
- `openSession(sessionRef)`
- `sendUserMessage(sessionRef, input)`
- `cancelCurrentRun(sessionRef)`
- `subscribe(sessionRef, listener)`
- `closeSession(sessionRef)`

### `SessionDriver` event surface

- `sessionOpened`
- `assistantDelta`
- `toolStarted`
- `toolUpdated`
- `toolFinished`
- `runCompleted`
- `runFailed`
- `hostUiRequest`

This contract should map closely to current RPC concepts and future server concepts. It should not invent deep new semantics.

## App Catalog Model

The app should own a thin catalog for sidebar/navigation UX, while leaving transcript truth in `pi` session files/runtime.

### `WorkspaceCatalog`

Minimum metadata:

- `workspaceId`
- absolute folder path
- display name
- lastOpenedAt
- sidebar ordering

### `SessionCatalog`

Minimum metadata:

- `sessionRef`
- `workspaceId`
- title
- updatedAt
- lightweight preview snippet
- status: `idle | running | failed`

The app should not duplicate full transcript history. It should index sessions, group them by workspace, and remember enough UI state for navigation.

## Package Layout

- `apps/desktop`
  - Electron shell and web UI
- `packages/session-driver`
  - Minimal durable contract and event types
- `packages/pi-sdk-driver`
  - Temporary driver backed by exported `pi-mono` APIs such as `createAgentSession` and `SessionManager`

For MVP, keep app-specific state and UI models in the desktop app unless they are reused across packages. Do not create extra “protocol”, “shared-models”, or “app-core” packages unless a second real consumer appears.

## Dependency Strategy

### Default

- Separate `pi-app` repo
- Depend on published `pi-mono` packages by exact version
- Allow only backend-driver packages to depend directly on `@mariozechner/pi-coding-agent`

### Avoid

- No vendoring broad `pi-mono` source into `pi-app`
- No git submodule as the primary integration path
- No broad app-wide imports from `pi-mono` internals
- No backend-specific types leaking into the Electron app outside driver packages

### If upstream seams are missing

- Prefer exact npm version pins first
- If unreleased changes are required, use the smallest possible temporary forked package publish or local dev link
- Upstream small seam PRs selectively rather than forking the runtime wholesale

## Temporary Runtime Shape

- The Electron main process owns a `SessionSupervisor`
- The supervisor manages many known sessions and one focused session in the main pane for `P0`
- Use one in-process runtime-backed session per opened/running session through the SDK driver
- The app owns only the minimum workspace/session catalog metadata needed for navigation UX
- The SDK driver translates `pi-mono` runtime behavior into `SessionDriver` events
- The rest of the app must not know whether the backend is a child process, in-process runtime, or future WebSocket server
- Use `session` as the backend/domain term for compatibility with current `pi` and the maintainer’s server direction

### `SessionSupervisor`

The main process should own:

- workspace open/close
- session list/open/create/close
- event fanout to renderers
- run start/cancel
- running/idle/error state per session
- restart/reopen restoration
- later: bounded concurrent run limits

## Future Runtime Shape

- Replace the temporary backend driver with `pi-ws-driver`
- Keep `session-driver` and most of the desktop UI intact
- Move session authority from local process orchestration to the official `pi` server
- Prefer official future server semantics over preserving temporary MVP behavior

## Stable vs Disposable

### Durable

- Electron shell and UI
- `session-driver`
- workspace/session catalog model
- session list/detail UX
- streamed event handling
- self-test harness for the desktop app

### Replaceable

- temporary backend driver implementation details
- temporary recent-session metadata format
- any backend-specific normalization logic

## Deliberate Non-Goals

- No permanent custom app-server before the official `pi` server exists
- No attempt to match future server-only features like list/delete/join sessions if current RPC cannot support them cleanly
- No worktrees in MVP
- No automations in MVP
- No rewrite of upstream `pi-coding-agent`
- No replacement terminal client in MVP

## Self-Test Plan

### Definition of proof

- The MVP is not “done” unless the real Electron app is exercised end-to-end
- Unit or mock tests alone are insufficient
- The temporary backend swap story must be evidenced by an executable boundary check, not only architecture prose
- The real UI must match the intended Codex-style shell closely enough in layout and interaction model, excluding deferred features like worktrees and automations

### Proof areas

- `P0` shell parity
- `P0` workspace/session navigation parity
- `P0` single-session end-to-end chat proof
- `P1` concurrent-session proof
- `P1` extension-host proof

### P0 proof path

Use a deterministic fixture workspace and one known-good prompt:

- Fixture workspace contains a known `package.json` with a known `"name"`
- Prompt: `Read package.json and report only the name field`

Required proof:

- Launch Electron app
- Verify the shell matches the target structure: left sidebar, session list, top bar, main conversation canvas, and composer layout consistent with the reference image
- Verify the shell has comparable polish to the reference image: spacing, hierarchy, visual density, sidebar behavior, and navigation feel
- Open at least three different fixture folders in the app
- Verify the sidebar renders folder rows distinct from session rows
- Verify the sidebar can show sessions associated with those folders and let the user jump to a chosen session
- Verify timestamps/previews/status render for session rows
- Verify cross-folder jumps preserve correct folder and session selection state
- Create a new session
- Send the fixed prompt through the real UI
- Observe at least one streamed UI update
- Reach `runCompleted` without hanging
- Final visible answer contains the expected package name
- Quit app, relaunch app, reopen the same session
- Verify transcript continuity after reopen
- Verify folder expansion, selection state, and session ordering restore correctly after relaunch

### Minimum harnesses

- Driver smoke test against the chosen backend path
- Real in-process session smoke test through the SDK driver
- Electron E2E driven by Playwright-for-Electron or equivalent
- Real local click-through of the app using a desktop automation path is optional supplemental evidence; Playwright is the primary harness
- Restart/reopen E2E against the real desktop app
- Boundary check proving the desktop app imports only `session-driver`, not backend-specific types

### Artifacts required for proof

- saved backend event log
- Electron trace and screenshots
- screenshots covering shell layout parity with the reference image
- screenshots covering folder/session switching and sidebar grouping states
- transcript artifact before restart
- transcript artifact after reopen

### Release gates

- No P0 proof claim without working model credentials or a local-model equivalent
- No P0 proof claim without scripted Electron E2E artifacts
- No P0 proof claim without screenshot baselines covering shell parity states
- No P0 proof claim without a scripted cross-folder navigation test
- No P0 proof claim without visible streaming proof, not only event-log proof
- No P0 proof claim if restart + reopen is only manually checked
- No P0 proof claim if reopen restores transcript but not sidebar/folder selection state
- Host interaction or approval-like flows are P1 unless P0 implementation depends on them

### Known blockers

- Future official `pi` server protocol is not fully specified
- Exported SDK/runtime APIs may still carry some interactive/TUI-era coupling, so the MVP must prove the SDK path is clean enough for the chosen architecture
- Real end-to-end proof requires working model credentials or an equivalent local setup
- Cross-model external review was partially blocked locally by expired Claude auth and missing Oracle browser cookies/API quota

## Milestones

### P0

- Scaffold `pi-app` repo and Electron shell
- Define `session-driver`
- Define thin `WorkspaceCatalog` and `SessionCatalog`
- Build the Codex-style sidebar with folders and grouped sessions
- Implement `pi-sdk-driver` for one active session
- Add minimal workspace/session metadata needed for grouping, timestamps, previews, folder association, and reopen
- Prove shell parity + folder/session navigation + create -> prompt -> streaming -> completion -> restart -> reopen in the desktop app

### P1

- Add true concurrent session execution
- Add per-session running/idle/error indicators and bounded concurrency policy
- Add one real host-interaction or extension-UI flow, then broaden to the P1 support set
- Harden the boundary so a future `pi-ws-driver` can swap in cleanly
- Add more robust self-test automation and version-lock checks

### P2

- Add worktrees
- Add automations
- Revisit terminal integration after the desktop MVP is proven
- Migrate to the official `pi` WebSocket server when ready

## Open Questions

- Which exact `WorkspaceCatalog` / `SessionCatalog` fields are enough for the Codex-style sidebar without creating a second source of transcript truth?
- Which extension-host flows are required in `P0` versus `P1`?
- Which small upstream seams in `pi-mono` would most reduce adapter fragility?
- Is one follow-up maintainer question still worth asking about whether current RPC concepts are likely to stay close to the future WebSocket command/event model?

## Spike Tasks

Run these before broad implementation. Each spike should end with a short written verdict and a keep/change decision.

### Spike 1: SDK Session Driver

Goal:

- Prove the Electron main process can create and drive one `pi` session through exported `pi-mono` APIs behind `session-driver`

Success:

- create session
- send prompt
- receive streamed events
- complete run
- reopen same session

Output:

- verdict on whether `pi-sdk-driver` is clean enough for the chosen architecture

### Spike 2: Workspace/Session Catalog

Goal:

- Prove a thin app-owned catalog is enough for Codex-style sidebar UX without duplicating transcript truth

Success:

- index multiple workspaces
- list grouped sessions
- persist selection/open state
- restore after relaunch

Output:

- exact catalog schema for `WorkspaceCatalog` and `SessionCatalog`

### Spike 3: Visual Shell

Goal:

- Prove the Codex-style sidebar/canvas shell can be matched in Electron with the desired level of polish

Success:

- left rail
- grouped folders/sessions
- selected session styling
- top bar
- composer
- responsive scrolling and truncation behavior

Output:

- screenshot set and acceptance checklist for visual parity

### Spike 4: Extension Host Minimum Surface

Goal:

- Prove the desktop app can support the minimum extension-host interactions needed for a strong product

Success:

- at least one dialog flow
- one notification/status flow
- one session-control flow

Output:

- confirmed `P0` support set and deferred list

## Implementation Milestones

### Milestone 1: Repo Scaffold

- create `pi-app` workspace
- add Electron app shell
- add package boundaries
- wire build, typecheck, lint, and test commands

Done when:

- Electron app boots
- renderer and main process communicate cleanly
- CI/local scripts exist for app development

### Milestone 2: Session Driver + SDK Integration

- define `session-driver`
- implement `pi-sdk-driver`
- prove one session can run end-to-end from the main process

Done when:

- deterministic prompt works through the driver
- streamed events reach the renderer
- restart/reopen works for one session

### Milestone 3: Workspace/Session Sidebar

- implement `WorkspaceCatalog`
- implement `SessionCatalog`
- build grouped folder/session sidebar
- support folder switching and session jumping

Done when:

- app can open multiple folders
- sessions render under the right folder
- selection/restoration works after relaunch

### Milestone 4: Codex-Style Main Surface

- build polished main conversation pane
- build composer and streaming transcript UI
- add timestamps, status indicators, and selected-row treatment

Done when:

- shell visually matches the intended Codex-style reference closely enough
- one real session can be used comfortably through the UI

### Milestone 5: P0 Proof

- add Playwright-for-Electron harness
- automate shell parity, navigation parity, and single-session E2E
- produce required screenshots and trace artifacts

Done when:

- `P0` self-test gates all pass

### Milestone 6: Early P1 Parallel Sessions

- add `SessionSupervisor`
- support multiple live sessions in memory
- add per-session run state in sidebar
- enforce bounded concurrency

Done when:

- two sessions can run concurrently with scripted proof
- sidebar shows running state correctly

### Milestone 7: Early P1 Extension Host

- implement minimum real extension-host flows beyond `P0`
- route host UI requests to the correct focused/running session

Done when:

- one real extension-host flow is exercised end-to-end in the app

## Initial Repo Scaffold

```text
pi-app/
  package.json
  pnpm-workspace.yaml
  tsconfig.base.json
  playwright.config.ts
  apps/
    desktop/
      package.json
      electron/
        main.ts
        preload.ts
      src/
        app/
        components/
        features/
          sidebar/
          session-view/
          composer/
        styles/
      tests/
  packages/
    session-driver/
      package.json
      src/
        index.ts
        types.ts
    pi-sdk-driver/
      package.json
      src/
        index.ts
        session-supervisor.ts
        runtime/
    catalogs/
      package.json
      src/
        workspace-catalog.ts
        session-catalog.ts
```

## First Tickets

1. Scaffold `pi-app` repo with Electron + React + Playwright.
2. Define `session-driver` types and event model.
3. Implement a single-session `pi-sdk-driver` spike using exported `pi-mono` APIs.
4. Define thin `WorkspaceCatalog` and `SessionCatalog` schemas.
5. Build the sidebar shell with fixture data before wiring full runtime state.
6. Replace fixture data with real catalog data from session indexing.
7. Add the deterministic single-session Playwright proof.
