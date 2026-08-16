# Vendored dsh community plugins

These plugins are vendored at pinned commits because they are **not published
to npm** (`dsh plugin add github:<owner>/<repo>` would install the default
branch's HEAD with no version lock — a breaking-change surprise under a fast
moving ecosystem). Vendoring gives cardo a reproducible, auditable, patchable
copy for every checkout, with no build-time GitHub dependency.

## Pin ledger (2026-08-16)

| Directory | Upstream | Pinned commit | Notes |
|---|---|---|---|
| `deep-whale-day-night-theme` | `GGBond2424648901/deep-whale-day-night-theme` | `4833f4f4dd582ead0a23fec59256e652830ca0ac` | Whale-maid skin. Trimmed to runtime files (`lib/` + `package.json` + `cordis.patch.yml` + `skin.json` + license); `assets/`/`src/`/`screenshots` are source artwork, not runtime. CC BY-NC-SA 4.0 — non-commercial only. |
| `dsh-subagent-monitor` | `Mombrane/dsh-subagent-monitor` | `5f7f026f877b127c53d4205aeec2cca94e316bcc` | npm package name: `@leetoners/dsh-ui-subagent-monitor` |
| `dsh-thinking-effort` | `hytime/dsh-thinking-effort` | `b2f5c54f1a0743114ece8c6de6334a7ae652b436` | Custom-provider reasoning-effort GUI |

## Update policy

To bump one plugin:

1. `git -C vendor/dsh-plugins/<name> fetch --depth 1 origin`
2. Checkout the new commit, verify it still targets the cardo-pinned dsh
   family (`0.1.0-rc.6` / cordis `4.0.1`), re-run the smoke test below.
3. Update this ledger's commit row.

## Install (in a cardo profile)

```sh
dsh plugin --profile cardo add /absolute/path/vendor/dsh-plugins/deep-whale-day-night-theme
dsh plugin --profile cardo add /absolute/path/vendor/dsh-plugins/dsh-subagent-monitor
dsh plugin --profile cardo add /absolute/path/vendor/dsh-plugins/dsh-thinking-effort
```

Smoke test after any change: sandbox `DSH_HOME`, boot the profile, expect
HTTP 200 on the web port with no load error mentioning these plugins.
