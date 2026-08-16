/**
 * Cardo built-ins: the company plugins and skills that ship with the app and
 * are ensured in the profile the user actually runs (dev → the mirrored test
 * home, packaged → ~/.dsh's `web` profile).
 *
 * Idempotent: a profile that already carries every built-in is left alone, so
 * user-installed extras and edits are never touched.
 */

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import * as path from 'node:path';

/** npm-published built-in plugins, pinned exact, as `dsh plugin add` specs. */
export const BUILTIN_NPM_PLUGINS: readonly string[] = [
  'dshmarket@1.9.0',
  'dsh-notifier@0.6.2',
  'dsh-better-sidebar@0.12.2',
  'dsh-file-upload@0.4.2',
  'dsh-find-plugin@0.3.6',
  'dsh-subagent-model-picker@0.1.1',
] as const;

/** Vendored (non-npm) built-ins: source dir → package name. The loader
 * resolves a bundle row by the package.json `name`, which can differ from
 * the repo dir (e.g. the subagent-monitor dir's package is
 * `@leetoners/dsh-ui-subagent-monitor`). They are copied into the profile's
 * node_modules (not pnpm-installed) because some declare peers that only
 * exist in the dsh source workspace and pnpm would fail fetching them.
 *
 * The skin is the `dsh-deep-whale` standalone distribution (`maid-atelier`
 * package) — self-inserting, host is a no-op, art embedded. The earlier
 * `deep-whale-day-night-theme` builtin-row distribution was retired: it
 * augmented a base row only shipped by `dsh-client-ui-theme-plugins` (absent
 * on the pinned rc.6 family), so its patch silently no-oped and the skin
 * never loaded. See `vendor/dsh-plugins/VENDOR.md`. */
export const BUILTIN_VENDOR_PLUGINS: Readonly<Record<string, string>> = {
  'dsh-deep-whale': '@dsh-external/dsh-client-ui-skin-maid-atelier',
  'dsh-subagent-monitor': '@leetoners/dsh-ui-subagent-monitor',
  'dsh-thinking-effort': 'dsh-thinking-effort',
};

/** The pnpm settings every profile needs for plugin installs. */
const PROFILE_PNPM_WORKSPACE = [
  'allowBuilds:',
  '  node-pty: true',
  '  sharp: true',
  '  protobufjs: true',
  '  fsevents: true',
  '  tesseract.js: true',
  'minimumReleaseAge: 0',
  '',
].join('\n');

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, 'utf8')) as unknown;
}

function writeJson(file: string, value: unknown): void {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

/** The profile directory under one dsh home. */
function profileDir(dshHome: string, profile: string): string {
  return path.join(dshHome, 'profiles', profile);
}

/** Extract the package name from an npm spec `<name>@<version>`. The name may
 * itself be scoped (`@scope/name`), so the version split is on the LAST `@`. */
export function builtinPackageName(spec: string): string {
  const at = spec.lastIndexOf('@');
  return at <= 0 ? spec : spec.slice(0, at);
}

/** The expected bundle rows of a fully provisioned cardo profile: the
 * official dsh bundles plus every built-in plugin's package name. */
export function expectedBuiltinBundles(
  npmPlugins: readonly string[],
  vendorPlugins: Readonly<Record<string, string>>,
): string[] {
  return [
    '@deepseek-ai/dsh-base',
    '@deepseek-ai/dsh-web-app',
    ...npmPlugins.map(builtinPackageName),
    ...Object.values(vendorPlugins),
  ];
}

/** Whether the profile's bundle list already carries every built-in. */
export function hasAllBuiltins(profileDirPath: string): boolean {
  try {
    const manifest = readJson(path.join(profileDirPath, 'package.json')) as {
      dsh?: { profile?: { bundles?: unknown } };
    };
    const raw = manifest.dsh?.profile?.bundles;
    const bundles = new Set(Array.isArray(raw) ? (raw as unknown[]) : []);
    const expected = expectedBuiltinBundles(BUILTIN_NPM_PLUGINS, BUILTIN_VENDOR_PLUGINS);
    return expected.every((name) => bundles.has(name));
  } catch {
    return false;
  }
}

/** Whether any built-in vendored plugin's installed copy in the profile has
 * drifted from the current source. The bundle list alone cannot tell — a
 * plugin can ship a fixed distribution under the SAME package name (the skin
 * swap), so a stale node_modules copy must be detected by content identity
 * (package.json `version`). A missing or illegible installed copy is stale.
 * Returns false only when every installed copy matches the current source. */
export function vendoredPluginsStale(profileDirPath: string, vendorRoot: string): boolean {
  for (const [dirName, pkgName] of Object.entries(BUILTIN_VENDOR_PLUGINS)) {
    const sourcePkg = path.join(vendorRoot, dirName, 'package.json');
    const installedPkg = path.join(
      profileDirPath,
      'node_modules',
      ...pkgName.split('/'),
      'package.json',
    );
    try {
      const sourceVersion = (readJson(sourcePkg) as { version?: string }).version;
      const installedVersion = (readJson(installedPkg) as { version?: string }).version;
      if (sourceVersion !== installedVersion) {
        return true;
      }
    } catch {
      return true; // cannot read either copy → assume stale, re-provision
    }
  }
  return false;
}

/**
 * Ensure the built-in plugins are installed into `dshHome`'s profile.
 *
 * @param dshHome the home the running dsh uses (dev test home or ~/.dsh).
 * @param profile the profile name (`web`).
 * @param dshCli absolute path to the bundled dsh CLI (lib/bin.js).
 * @param nodeExec the node executable to run the CLI with.
 * @param vendorRoot the vendored plugin sources (app resources or monorepo).
 */
export function ensureBuiltinPlugins(
  dshHome: string,
  profile: string,
  dshCli: string,
  nodeExec: string,
  vendorRoot: string,
): void {
  const dir = profileDir(dshHome, profile);
  if (!existsSync(dir)) {
    return; // no profile yet — nothing to ensure
  }
  if (hasAllBuiltins(dir) && !vendoredPluginsStale(dir, vendorRoot)) {
    return;
  }

  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'pnpm-workspace.yaml'), PROFILE_PNPM_WORKSPACE, 'utf8');

  const env = { ...process.env, DSH_HOME: dshHome, ELECTRON_RUN_AS_NODE: '1' };
  for (const spec of BUILTIN_NPM_PLUGINS) {
    execFileSync(nodeExec, [dshCli, 'plugin', '--profile', profile, 'add', spec], {
      env,
      stdio: 'inherit',
    });
  }

  // Vendored plugins: copy under their package name and append the bundle rows
  // to the profile manifest (dsh plugin add can't be used — the vendored
  // packages declare peers that are not on npm).
  const manifestPath = path.join(dir, 'package.json');
  const manifest = readJson(manifestPath) as {
    name?: string;
    private?: boolean;
    dependencies?: Record<string, string>;
    dsh?: { profile?: { bundles?: string[] } };
  };
  manifest.dsh ??= {};
  manifest.dsh.profile ??= {};
  manifest.dsh.profile.bundles ??= [];
  const bundles = manifest.dsh.profile.bundles;

  for (const [dirName, pkgName] of Object.entries(BUILTIN_VENDOR_PLUGINS)) {
    if (!bundles.includes(pkgName)) {
      bundles.push(pkgName);
    }
    const src = path.join(vendorRoot, dirName);
    const dest = path.join(dir, 'node_modules', ...pkgName.split('/'));
    rmSync(dest, { recursive: true, force: true });
    mkdirSync(path.dirname(dest), { recursive: true });
    cpSync(src, dest, { recursive: true });
  }
  writeJson(manifestPath, manifest);
}

/** The bundled skills dir (rank-600 bundled provider): dev → monorepo
 * packages/cardo-skills/src/skills, packaged → resources/skills. */
export function builtinSkillsDir(
  dev: boolean,
  resourcesPath: string,
  monorepoRoot: string,
): string | undefined {
  const candidate = dev
    ? path.join(monorepoRoot, 'packages', 'cardo-skills', 'src', 'skills')
    : path.join(resourcesPath, 'skills');
  return existsSync(candidate) ? candidate : undefined;
}
