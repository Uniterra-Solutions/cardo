# Module: cardo-updater

**Purpose:** Pure update logic for the desktop app (no Electron/fs imports, so the semantics are unit-testable): probes the npm CLI dist-tag and the cardo GitHub release, decides whether an update is available, maps the update-prompt response onto the action to take, and supports the user's skipped-version gate.

Source: `packages/cardo-updater/src/` (`index.ts`, `decision.ts`); tests `test/decision.test.mts`.

## Public API

| Export                     | Signature                                                                              | Description                                                                                                                                                         |
| -------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `compareSemver`            | `(a: string, b: string) => number`                                                     | negative/zero/positive; prerelease precedence; unparseable inputs compare equal (`0`) — never claim an update we cannot verify                                      |
| `resolveCardoUpdateStatus` | `(versions: CardoUpdateVersions) => CardoUpdateResult`                                 | Merge CLI + release probes into one verdict                                                                                                                         |
| `shouldPromptForUpdate`    | `(latestVersion: string \| undefined, skippedVersion: string \| undefined) => boolean` | Prompt only when a strictly newer version than the skipped one exists                                                                                               |
| `resolveUpdateAction`      | `(result: CardoUpdateResult, response: number) => CardoUpdateAction`                   | update-available + 0 → `quit-and-update`; + 2 → `skip-version`; anything else → `none`                                                                              |
| `updateInvocation`         | `(commandOverride?: string) => UpdateInvocation`                                       | The quit-and-update spawn spec: default `npx --yes @uniterra-solutions/cardo@latest update` (always the LATEST updater); override → `{ command, args: ['update'] }` |
| `CardoUpdateVersions`      | type                                                                                   | `{ appVersion: string; cliVersion?: string; latestReleaseVersion?: string; latestCliVersion?: string }`                                                             |
| `CardoUpdateResult`        | type                                                                                   | `{ status: 'update-available'; latestVersion; currentVersion } \| { status: 'up-to-date'; currentVersion } \| { status: 'error'; message }`                         |
| `CardoUpdateAction`        | type                                                                                   | `{ action: 'quit-and-update' } \| { action: 'skip-version'; skippedVersion: string } \| { action: 'none' }`                                                         |
| `UpdateInvocation`         | type                                                                                   | `{ command: string; args: readonly string[] }`                                                                                                                      |

## Decision Semantics

- `latestVersion = newestOf(latestReleaseVersion, latestCliVersion)`; both undefined → `error`.
- Either newer than the installed counterpart (semver) → `update-available`; `currentVersion = newestOf(appVersion, cliVersion)`.
- One failing probe is ignored; only both failing is an error.
- `shouldPromptForUpdate`: no latest → false; no skip recorded → true; `latest <= skipped` → false; `latest > skipped` → true. The newest of CLI/release doubles as the skip key.
- `resolveUpdateAction`: `cardo update` is the single full-update command (CLI refresh + app rebuild + relaunch), so Update Now always quits and updates — the desktop spawns the updater detached and the CLI relaunches the app when done. Skip persists the offered `latestVersion`; non-update verdicts and any other response take no action.
- `updateInvocation`: the default spawn runs `npx --yes @uniterra-solutions/cardo@latest update` so the LATEST published updater executes even when the user's global `cardo` CLI is stale (a pre-full-update CLI would only refresh itself and leave the app closed); `CARDO_UPDATE_COMMAND` overrides the command for tests/dev.
- Skip-version persistence (where the desktop stores it) lives in the desktop shell — see [cardo-desktop.md](cardo-desktop.md) `[INFERRED: persistence is wired outside this package]`.

## Dependencies

- Outbound: none (pure functions over input records).
- Inbound: `packages/cardo-desktop` (`@cardo/cardo-updater` is its only runtime dependency).

## Patterns & Gotchas

- No Electron/fs imports by design — property tests drive every branch of `decision.ts`.
- Unparseable semver compares equal, so a garbage probe can never produce a false "update available".

## How to Update

- Decision semantics change → update this file and `test/decision.test.mts` together.

## Find It Fast

```bash
grep -n 'export' packages/cardo-updater/src/decision.ts  # the whole public surface
```
