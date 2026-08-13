# Phase 1 Codex Parity Plan

## Confidence
- Current planning confidence: 92%
- Main remaining risk: true parallel background session runs may expose hidden `pi` SDK assumptions around subscription scope and session status restoration.

## Phase 1 Goal
Make `pi-app` feel materially closer to Codex App in real use, not just shell polish.

Phase 1 focuses on:
- true parallel background session runs
- trustworthy per-session sidebar state
- richer Codex-style work timeline
- composer slash menu and lightweight settings/provider controls
- image attachments with preview/removal

Phase 2 will cover:
- worktrees
- automations
- broader host UI / approvals / widgets
- historical transcript reprocessing

## Success Criteria
Phase 1 is done when all of this is true on the real Electron app surface:

1. Session A can be running in the background while the user focuses Session B.
2. Session B can start its own run while Session A is still running.
3. No event bleed occurs between sessions.
4. Sidebar status is correct for every session, focused or unfocused.
5. Background sessions continue updating while not selected.
6. Returning to a background session shows the full timeline that happened while it was unfocused.
7. Tool/work timeline is richer and Codex-like:
   - tool rows
   - terminal/background rows
   - compact summaries
   - expanded details by default
8. Composer supports `/` slash menu for the first useful controls.
9. App exposes real `pi` model/provider/thinking controls where available.
10. Image attachments support preview and removal before send.
11. Restart/reopen preserves:
   - selected session
   - sidebar statuses
   - timeline rows
   - in-flight/background runs if the underlying runtime still exists

## Reverse-Engineered Codex Behaviors To Mirror

### Parallel Threads
- Parallel thread lifecycle is first-class.
- Background runs keep progressing after you switch away.
- Thread rows reflect running/queued/error state independently.

### Timeline
- Transcript includes work, not just prompts and answers.
- Tool/terminal/background activity is visible inline.
- Final assistant output lands after the work log that produced it.

### Composer
- `/` opens a command surface.
- Composer is the main control point for model/action toggles.
- Image attachments are first-class.

### Settings
- Controls are structured around real runtime capabilities, not generic preferences.
- Keyboard shortcuts and command discoverability matter.

## Current Gaps

### Architecture
- Desktop state still mixes focused-session concerns with global runtime concerns.
- Error state is still too global.
- Unfocused sessions are not guaranteed live subscriptions.
- Workspace sync can overwrite running-state truth with idle catalog state.

### Timeline
- Tool rows exist, but they are still a simplified rendering of runtime activity.
- Background session activity is not yet a first-class product path.
- Historical cache remains primary and is acceptable for Phase 1.

### Composer / Controls
- No slash-command surface.
- No image attach picker/preview/remove flow.
- No in-app provider/model/thinking controls yet.

## Technical Direction

### 1. Session Supervisor
Build a true session supervisor layer in the desktop backend.

Responsibilities:
- track all active sessions, not just the focused session
- keep per-session subscriptions alive while runs are active
- maintain per-session runtime overlays:
  - status
  - runningSince
  - lastError
  - pending work/timeline updates
- avoid clobbering running state during workspace sync

### 2. Per-Session UI State
Split:
- focused session transcript/composer state
from:
- global session runtime tracking

Needed per session:
- status
- runningSince
- lastError
- unread/background activity marker
- cached timeline
- draft attachments

### 3. Driver Surface
Phase 1 should add or expose:
- background-safe session subscription model
- model/provider change APIs
- thinking-level change APIs
- image attachment send path

### 4. Slash Menu
Implement slash parsing in the desktop composer first.

Initial commands:
- `/model`
- `/provider`
- `/thinking`
- `/status`
- `/image`

The slash menu should be a lightweight command palette anchored to the composer, not a global command bar first.

### 5. Image Attachments
Phase 1 image scope:
- picker support
- drag/drop support if cheap
- preview chip before send
- remove before send
- image preserved in the transcript after send
- explicit unsupported/error states

No generic file attachments in Phase 1.

## Milestones

### M1. Runtime Refactor
- split focused vs global session state
- add per-session runtime overlays
- preserve running state during workspace sync
- ensure non-focused running sessions stay subscribed

### M2. Parallel Session Execution
- allow true parallel runs
- show correct sidebar running/error/idle states
- prevent cross-session event bleed
- support switching focus while runs continue

### M3. Richer Work Timeline
- strengthen tool rows
- add background terminal / runtime rows where available
- keep final assistant output after tool rows
- add clearer run summaries and status transitions

### M4. Slash Controls + Settings Surface
- composer slash menu
- provider/model/thinking controls
- lightweight settings entry point
- command discoverability and shortcut hints

### M5. Image Attachments
- picker + preview + remove
- transcript rendering
- error/unsupported states

### M6. Restart / Recovery Hardening
- preserve sidebar truth on restart
- preserve background session timeline correctly
- verify reopen behavior with multiple sessions

## Self-Test Plan

### Core E2E
Run on the real Electron app surface with Playwright plus live local verification:

1. Launch app.
2. Open one workspace with at least two sessions.
3. Start a long-running session in Session A.
4. Switch to Session B and start a second run.
5. Verify:
   - both sessions show correct sidebar running state
   - no A events appear in B timeline
   - no B events appear in A timeline
6. Switch back and forth while both are running.
7. Let both complete.
8. Verify:
   - tool/work rows are intact
   - final assistant message ordering is correct
   - no stray `Working...`
   - no bogus `Used 0 tools`
9. Restart app.
10. Verify restored sidebar state and timelines for both sessions.

### Slash / Settings
1. Open slash menu from composer.
2. Change model/provider/thinking via exposed controls.
3. Verify the underlying `pi` session reflects the change and subsequent runs use it.

### Image Attachments
1. Attach an image.
2. Preview it before send.
3. Remove and re-add it.
4. Send with image attached.
5. Verify transcript rendering and persistence after restart.

## Known Deferred Work
- worktrees
- automations
- host UI request/response flows beyond timeline summaries
- generic file attachments
- historical transcript reprocessing from raw `pi` logs

## Immediate Implementation Order
1. Refactor session supervisor and desktop state for per-session runtime truth.
2. Prove two parallel sessions end-to-end with no event bleed.
3. Tighten sidebar status model around parallel runs.
4. Add slash menu and provider/model/thinking APIs.
5. Add image attachments.
6. Re-run full Electron self-test.
