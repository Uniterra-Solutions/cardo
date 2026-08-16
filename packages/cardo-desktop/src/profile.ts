/**
 * Cardo desktop profile bootstrap — the bundle-row manifest constants the
 * desktop resolves against. This module is pure data, testable without
 * Electron. (Provisioning of the built-ins themselves lives in builtin.ts.)
 */

/** The npm-published community plugins the cardo profile mounts, in add order. */
export const PROFILE_PLUGINS: readonly string[] = [
  'dshmarket@1.9.0',
  'dsh-notifier@0.6.2',
  'dsh-better-sidebar@0.12.2',
  'dsh-file-upload@0.4.2',
  'dsh-lan-gateway@0.2.1',
  'dsh-find-plugin@0.3.6',
  'dsh-subagent-model-picker@0.1.1',
] as const;

/** Vendored (non-npm) community plugins, installed from the monorepo checkout
 * at build time. The `vendor/dsh-plugins` pin ledger records their commits. */
export const VENDOR_PLUGIN_DIRS: readonly string[] = [
  'dsh-deep-whale',
  'dsh-subagent-monitor',
  'dsh-thinking-effort',
  'dsh-shortcuts',
  'dsh-git-graph',
] as const;

/** The official dsh bundles every profile stacks (resolved from the dsh CLI). */
export const OFFICIAL_BUNDLES: readonly string[] = [
  '@deepseek-ai/dsh-base',
  '@deepseek-ai/dsh-web-app',
] as const;

/** Build scripts the profile pnpm must be allowed to run (pnpm 11 blocks by default). */
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

/** The profile package.json the launcher scaffolds on first run. */
export function profileManifest(): string {
  return JSON.stringify(
    {
      name: 'dsh-profile-cardo',
      private: true,
      dependencies: {},
      dsh: {
        profile: {
          bundles: [
            ...OFFICIAL_BUNDLES,
            ...PROFILE_PLUGINS.map((p) => p.split('@')[0] as string),
            ...VENDOR_PLUGIN_DIRS.map((dir) => dir),
          ],
        },
      },
    },
    null,
    2,
  );
}

/** The pnpm workspace file needed so plugin installs allow native builds. */
export function profilePnpmWorkspace(): string {
  const lines = ['allowBuilds:'];
  for (const pkg of PROFILE_ALLOW_BUILDS) {
    lines.push(`  ${pkg}: true`);
  }
  lines.push('minimumReleaseAge: 0', '');
  return lines.join('\n');
}
