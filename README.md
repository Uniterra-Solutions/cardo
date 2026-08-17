# Cardo

A desktop app built on the DeepSeek Harness (dsh) agent runtime and community dsh plugins: an Electron shell launches the bundled dsh CLI, provisions built-in plugins and skills into the user's profile, and hosts the dsh Web UI in a window. **The goal is to let you build your own desktop agent app through plugins** — it ships 9 npm community plugins, 2 vendored community plugins, and 1 in-house provider plugin, and you can install more at any time.

**Docs: [Documentation](docs/README.md)** (architecture diagrams, module deep dives, setup, testing, workflows) · **Spec: [AGENTS.md](AGENTS.md)**

## Built-in Plugins

The app ships 12 built-in plugins (9 npm community, 2 vendored, 1 in-house). Source repositories:

| Plugin                      | Type     | Source                                                                                              |
| --------------------------- | -------- | --------------------------------------------------------------------------------------------------- |
| `dshmarket`                 | npm      | [dsh-market/dsh-market](https://github.com/dsh-market/dsh-market)                                   |
| `dsh-notifier`              | npm      | [THEWOLFWALKER/dsh-notifier](https://github.com/THEWOLFWALKER/dsh-notifier)                         |
| `dsh-better-sidebar`        | npm      | [omdsh-dev/DSH-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar)                     |
| `dsh-file-upload`           | npm      | [HongMing-Huang/dsh-file-upload](https://github.com/HongMing-Huang/dsh-file-upload)                 |
| `dsh-find-plugin`           | npm      | [awesome-dsh-plugin/dsh-find-plugin](https://github.com/awesome-dsh-plugin/dsh-find-plugin)         |
| `dsh-subagent-model-picker` | npm      | [npm package](https://www.npmjs.com/package/dsh-subagent-model-picker) (no public source repo)      |
| `dsh-tool-git`              | npm      | [lxj808624/dsh-tool-git](https://github.com/lxj808624/dsh-tool-git)                                 |
| `dsh-browser-playwright`    | npm      | [ChenyuHeee/dsh-browser-playwright](https://github.com/ChenyuHeee/dsh-browser-playwright)           |
| `dsh-computer-use`          | npm      | [988hj7tczd-oss/dsh-computer-use](https://github.com/988hj7tczd-oss/dsh-computer-use)               |
| `dsh-deep-whale`            | vendored | [Small-tailqwq/dsh-deep-whale](https://github.com/Small-tailqwq/dsh-deep-whale)                     |
| `dsh-shortcuts`             | vendored | [Ricketts-Guo/dsh-shortcuts](https://github.com/Ricketts-Guo/dsh-shortcuts)                         |
| `@cardo/cardo-provider`     | in-house | [Uniterra-Solutions/cardo](https://github.com/Uniterra-Solutions/cardo) (`packages/cardo-provider`) |

Vendored plugins are pinned at fixed commits — see [vendor/dsh-plugins/VENDOR.md](vendor/dsh-plugins/VENDOR.md).

## Built-in Workflows

| Workflow                                                                                            | Description                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **TDD development workflow** (`cardo-plan` → `cardo-implement` → `cardo-simplify` / `cardo-review`) | Plan → clarify → PRD/design → execution-plan.json (an explicit requirements list per task) → implement: simple tasks write failing property tests inline then fix code; complex tasks first write ALL failing property tests, then run a batched/fully-parallel dynamic workflow chosen by task overlap → simplify/review against an explicit scope. Property testing blocks the bugs a known invariant would introduce, during development |
| **TDD debugging workflow** (`cardo-pbt-debugging`)                                                  | Don't change code first: read the business logic, encode it as invariants, reproduce the bug via property testing (must fail; the counterexample is the reproduction) → fix the root cause → lock it with regression tests. Reduces debugging to a machine-search problem, maximizing an AI agent's ability to fix software defects                                                                                                         |
| **Project documentation management** (`project-documentation`, etc.)                                | Structured `docs/` tree generation and incremental updates; plus QA acceptance (`cardo-qa`), skill creation (`create-skill`), AGENTS.md management (`manage-agents-md`), git workflows (`manage-git-repo`)                                                                                                                                                                                                                                  |

Workflow details: [docs/modules/cardo-skills.md](docs/modules/cardo-skills.md) · common task recipes: [docs/workflows.md](docs/workflows.md)

## Built-in Provider Enhancement

`@cardo/cardo-provider`: a dual-protocol (OpenAI chat completions + Responses API) LLM provider plugin that can be configured against any OpenAI-compatible external provider, with upstream model metadata (context window / output tokens / reasoning efforts) auto-detected via models.dev, and a Web settings page for managing the gateway and per-model protocol overrides. See [docs/modules/cardo-provider.md](docs/modules/cardo-provider.md).

## Quick Start

```bash
# Install the app (macOS / Windows 10+)
npm install -g @uniterra-solutions/cardo
cardo setup
# macOS → ~/Applications/Cardo.app; Windows → %LOCALAPPDATA%\Programs\Cardo (with a Start Menu shortcut)
cardo update
# One-command update: refresh the CLI + rebuild/reinstall the app + auto-relaunch (Update Now in the app runs this too)

# Development
git clone https://github.com/Uniterra-Solutions/cardo.git
cd cardo
pnpm install --frozen-lockfile
pnpm build && pnpm lint && pnpm typecheck
pnpm --filter @cardo/cardo-desktop dev    # dev mode (does not touch the real ~/.dsh)
```

Test commands and the verification matrix: [docs/testing.md](docs/testing.md) · environment variables: [docs/setup.md](docs/setup.md)

## Tech Stack

Node ≥ 22 · Electron 37 · @deepseek-ai/dsh 0.1.0-rc.6 (pinned exact) · TypeScript ~5.9 (NodeNext ESM) · pnpm 11 · fast-check (PBT) · esbuild / electron-builder. Full list: [docs/tech-stack.md](docs/tech-stack.md)

## Conventions

NodeNext ESM (internal imports carry `.js` suffixes) · named exports only · no `any` · `@deepseek-ai/*` pinned exact · every business logic has tests. See [AGENTS.md](AGENTS.md) and [docs/conventions.md](docs/conventions.md).

## License

[MIT](LICENSE)
