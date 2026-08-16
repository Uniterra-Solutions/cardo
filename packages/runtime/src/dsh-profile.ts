/**
 * Cardo dsh profile specification (migration from pi-gui).
 *
 * A running cardo app is a dsh profile: a directory under the app's own
 * `DSH_HOME/profiles/cardo` composed from ordered bundles. This module is the
 * single source of truth for what that profile contains — the official dsh
 * bundles, cardo's own bundles, and the pinned community plugins that ship as
 * built-ins.
 *
 * Installer notes:
 * - Versions are PINNED (no caret): @deepseek-ai/* is a developer preview
 *   with breaking changes. `npm view X version` returns the stale `latest`
 *   tag; the current family is the `next` tag (`0.1.0-rc.6` + cordis 4.0.1).
 * - Community plugins prefer the npm-published bundle; GitHub-sourced ones
 *   are installed with `dsh plugin add github:<owner>/<repo>`.
 */

/** One built-in plugin cardo ships in its profile. */
export interface CardoPlugin {
  /** npm package name (or package name inside a vendored dir when `install` is vendor). */
  readonly package: string;
  /** Why the plugin is built in. */
  readonly purpose: string;
  /** How `dsh plugin add` resolves the package. */
  readonly install: 'npm' | 'vendor';
  /** Pinned npm version for npm-installed plugins (no caret). */
  readonly version?: string;
  /** Path under `vendor/dsh-plugins/` when install is vendor. */
  readonly vendorDir?: string;
}

/** The official dsh bundles every cardo profile stacks, in order. */
export const OFFICIAL_BUNDLES: readonly string[] = [
  '@deepseek-ai/dsh-base',
  '@deepseek-ai/dsh-web-app',
] as const;

/** Cardo's own bundles (packages in this monorepo). */
export const CARDO_BUNDLES: readonly string[] = ['@cardo/cardo-modes'] as const;

/** Community plugins pinned as cardo built-ins. */
export const BUILTIN_PLUGINS: readonly CardoPlugin[] = [
  {
    package: 'dsh-thinking-effort',
    purpose: 'Custom-provider reasoning-effort GUI (default levels + per-model editor)',
    install: 'vendor',
    vendorDir: 'dsh-thinking-effort',
  },
  {
    package: 'dshmarket',
    purpose: 'Plugin market inside Settings (one-click install/themes)',
    install: 'npm',
    version: '1.9.0',
  },
  {
    package: 'dsh-find-plugin',
    purpose: 'AI plugin finder (agent installs plugins for you)',
    install: 'npm',
    version: '0.3.6',
  },
  {
    package: '@dsh-external/dsh-client-ui-skin-maid-atelier',
    purpose: 'Whale-maid skin (CC BY-NC-SA, non-commercial only)',
    install: 'vendor',
    vendorDir: 'deep-whale-day-night-theme',
  },
  {
    package: 'dsh-subagent-model-picker',
    purpose: 'Per-session subagent model + reasoning-effort selection',
    install: 'npm',
    version: '0.1.1',
  },
  {
    package: '@leetoners/dsh-ui-subagent-monitor',
    purpose: 'Live subagent run monitor panel (progress visibility)',
    install: 'vendor',
    vendorDir: 'dsh-subagent-monitor',
  },
  {
    package: 'dsh-notifier',
    purpose: '25+ channel notifications + mobile agent control',
    install: 'npm',
    version: '0.6.2',
  },
  {
    package: 'dsh-better-sidebar',
    purpose: 'IDE workbench sidebar: files, terminal, git, subagents',
    install: 'npm',
    version: '0.12.2',
  },
  {
    package: 'dsh-file-upload',
    purpose: 'Claude-style file upload + document-to-markdown (read_document tool)',
    install: 'npm',
    version: '0.4.2',
  },
  {
    package: 'dsh-lan-gateway',
    purpose: 'LAN/remote access (token gate, mobile UI injection)',
    install: 'npm',
    version: '0.2.1',
  },
] as const;

/** Environment variables the cardo profile expects the launcher to set. */
export const PROFILE_ENV: readonly { readonly key: string; readonly purpose: string }[] = [
  {
    key: 'DSH_BUNDLED_SKILL_DIR',
    purpose: 'Company skills directory (rank-600 bundled provider): packages/skills/src/skills',
  },
  {
    key: 'DSH_HOME',
    purpose: 'Cardo app data home (never the user personal ~/.dsh)',
  },
] as const;

/**
 * Build scripts the profile's pnpm must be allowed to run. Without this,
 * `dsh plugin add` fails with ERR_PNPM_IGNORED_BUILDS for plugins that ship
 * native deps (node-pty terminal, sharp images, tesseract OCR, …). The
 * launcher writes these into the profile's `pnpm-workspace.yaml`
 * `allowBuilds` block when it scaffolds the profile.
 */
export const PROFILE_ALLOW_BUILDS: readonly string[] = [
  'node-pty',
  'sharp',
  'protobufjs',
  'fsevents',
  'tesseract.js',
  '@google/genai',
  'electron',
  'electron-winstaller',
  'esbuild',
  'koffi',
] as const;

/** The full bundle list a cardo profile package.json should declare. */
export function cardoProfileBundles(): readonly string[] {
  return [...OFFICIAL_BUNDLES, ...CARDO_BUNDLES, ...BUILTIN_PLUGINS.map((p) => p.package)];
}
