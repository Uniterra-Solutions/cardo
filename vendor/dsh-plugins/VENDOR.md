# Vendored dsh community plugins

These plugins are vendored at pinned commits because they are **not published
to npm** (`dsh plugin add github:<owner>/<repo>` would install the default
branch's HEAD with no version lock — a breaking-change surprise under a fast
moving ecosystem). Vendoring gives uniterra a reproducible, auditable, patchable
copy for every checkout, with no build-time GitHub dependency.

## Pin ledger (2026-08-17)

| Directory | Upstream | Pinned commit | Notes |
|---|---|---|---|
| `dsh-deep-whale` | `Small-tailqwq/dsh-deep-whale` | `873f5c6d7f52aa4e4283a5ffd5598229595184da` | Whale-maid skin, **standalone distribution** (`maid-atelier/` package). **OPTIONAL** — shipped but not installed by default (see "Optional plugins" below). Chosen over the GGBond `deep-whale-day-night-theme` builtin-row distribution, which depends on `dsh-client-ui-theme-plugins` / `dsh-host-theme-catalog` (absent in the pinned rc.6 family) and so silently never loaded. This copy self-inserts its `ui-skin-maid-atelier` row, ships a no-op host (`apply` is empty, art embedded as data URIs) and needs only `@deepseek-ai/cordis`. Trimmed to runtime files (`lib/` + `package.json` + `cordis.patch.yml` + `skin.json` + `preview/` + license/NOTICE/README); `src/`/`assets/`/`build/`/`tests/` are source/build, not runtime. Package name: `@dsh-external/dsh-client-ui-skin-maid-atelier`. CC BY-NC-SA 4.0 — non-commercial only. |
| `dsh-shortcuts` | `Ricketts-Guo/dsh-shortcuts` | `0d12280cea78451d7d7e65bdb7e8b475f41c0a79` | 34 pre-registered keyboard shortcuts (session/view/clipboard/model/permission/system), one-click recording, macOS-first defaults. Client-only plugin (needs `react`, `@deepseek-ai/cordis`, `@deepseek-ai/dsh-client-runtime` — all host-provided). Trimmed to runtime (`lib/` + `package.json` + `cordis.patch.yml` + docs); `test/`/`install.sh` are source/ops, not runtime. |

## Retired plugins

These were vendored built-ins once, then dropped because their function
overlapped another built-in (see the desktop's `RETIRED_BUILTINS` list):

| Directory (removed) | Replaced by |
|---|---|
| `dsh-subagent-monitor` (`@leetoners/dsh-ui-subagent-monitor`) | `dsh-better-sidebar` Tasks page (subagent topology + background jobs) |
| `dsh-git-graph` | `dsh-better-sidebar` Git panel (history, diff, uncommitted changes) |
| `dsh-thinking-effort` | `@uniterra-solutions/uniterra-provider` (declares + edits `reasoningEfforts` from models.dev) |
| `dsh-hotkeys` (npm) | `dsh-shortcuts` |

## Update policy

To bump one plugin:

1. `git -C vendor/dsh-plugins/<name> fetch --depth 1 origin`
2. Checkout the new commit, verify it still targets the uniterra-pinned dsh
   family (`0.1.0-rc.6` / cordis `4.0.1`), re-run the smoke test below.
3. Update this ledger's commit row.

## Optional plugins

`dsh-deep-whale` is a built-in **option**: the desktop ships the source but
never installs or activates it unless the user's profile opts in. The toggle
is the profile's `.uniterra.json` (created by the desktop on first run):

```json
{
  "version": 1,
  "optionalPlugins": {
    "@dsh-external/dsh-client-ui-skin-maid-atelier": true
  }
}
```

- `true` (or the key present) → the desktop ensures the skin's bundle row and
  a fresh copy in the profile at every boot; removing the key (or the whole
  `optionalPlugins` object) → the row and the copy are removed.
- No file yet (pre-toggle installs) → the desktop migrates: an existing skin
  row is preserved and persisted as enabled; a profile without one stays
  skin-free.

Manual, CLI-free enable/disable via the dsh CLI also works (the desktop
honours whatever the row says when no file exists, and a working pnpm link is
left alone):

```sh
dsh plugin --profile web add /absolute/path/vendor/dsh-plugins/dsh-deep-whale
dsh plugin --profile web remove @dsh-external/dsh-client-ui-skin-maid-atelier
```

## Install (in a uniterra profile)

`dsh-shortcuts` is a built-in — provisioned automatically. The manual
`dsh plugin add` path above is only needed to opt into the optional skin
without editing `.uniterra.json`.

Smoke test after any change: sandbox `DSH_HOME`, boot the profile, expect
HTTP 200 on the web port with no load error mentioning these plugins.
