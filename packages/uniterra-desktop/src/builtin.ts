/**
 * Uniterra built-ins: the company plugins and skills that ship with the app and
 * are ensured in the profile the user actually runs (dev → the mirrored test
 * home, packaged → ~/.dsh's `web` profile).
 *
 * A built-in is declared ONCE, through {@link registerBuiltinPlugin}, under one
 * of the three existing mechanisms — npm, vendored, or workspace — or flagged
 * retired. Every consumer (expected bundles, the provisioning loops, stale
 * detection, and the retirement heal) derives from that single registry, so
 * adding a built-in never means wiring a second code path.
 *
 * Idempotent: a profile that already carries every built-in is left alone, so
 * user-installed extras and edits are never touched.
 */

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import * as path from 'node:path';

/** One npm-published built-in, pinned exact, as a `dsh plugin add` spec. */
export interface NpmBuiltin {
  readonly kind: 'npm';
  readonly spec: string;
}

/** One copy-based built-in: vendored (third-party, under `vendor/dsh-plugins`)
 * or in-house workspace (`packages/*`, this repo's own). Copied into the
 * profile's node_modules under its package name (not pnpm-installed) because
 * some declare peers that only exist in the dsh source workspace and pnpm
 * would fail fetching them. The package name can differ from the repo dir. */
export interface CopyBuiltin {
  readonly kind: 'vendor' | 'workspace';
  readonly dir: string;
  readonly package: string;
}

/** A built-in dropped from the profile (or folded into another). Declared in
 * the SAME registry with a `retired` flag so the heal and the expected-bundle
 * computation derive from one source of truth instead of a separate
 * RETIRED_BUILTINS list. The heal removes exactly this package name. */
export interface RetiredBuiltin {
  readonly retired: true;
  readonly package: string;
  /** Why it was dropped / what replaced it, for the record. */
  readonly comment?: string;
}

/** One registry entry: active (npm / vendor / workspace) or retired. */
export type BuiltinPlugin = NpmBuiltin | CopyBuiltin | RetiredBuiltin;

/** A non-retired registry entry. */
export type ActiveBuiltin = NpmBuiltin | CopyBuiltin;

/** The single registry every built-in is declared through. */
const registry: BuiltinPlugin[] = [];

/**
 * Declare one built-in. This is the ONLY place a built-in is wired: adding a
 * plugin is a single call here, and every derived consumer picks it up.
 */
export function registerBuiltinPlugin(plugin: BuiltinPlugin): void {
  registry.push(plugin);
}

function isRetired(entry: BuiltinPlugin): entry is RetiredBuiltin {
  return (entry as { retired?: unknown }).retired === true;
}

// ---------------------------------------------------------------------------
// Registry declarations — the full built-in set, one entry per plugin.
// ---------------------------------------------------------------------------

registerBuiltinPlugin({ kind: 'npm', spec: 'dshmarket@1.9.0' });
registerBuiltinPlugin({ kind: 'npm', spec: 'dsh-notifier@0.6.2' });
registerBuiltinPlugin({ kind: 'npm', spec: 'dsh-better-sidebar@0.12.2' });
registerBuiltinPlugin({ kind: 'npm', spec: 'dsh-file-upload@0.4.2' });
registerBuiltinPlugin({ kind: 'npm', spec: 'dsh-find-plugin@0.3.6' });
registerBuiltinPlugin({ kind: 'npm', spec: 'dsh-subagent-model-picker@0.1.1' });
registerBuiltinPlugin({ kind: 'npm', spec: 'dsh-tool-git@0.1.3' });
registerBuiltinPlugin({ kind: 'npm', spec: 'dsh-browser-playwright@0.1.1' });
registerBuiltinPlugin({ kind: 'npm', spec: 'dsh-computer-use@0.1.0' });

// The skin is the `dsh-deep-whale` standalone distribution (`maid-atelier`
// package) — self-inserting, host is a no-op, art embedded. The earlier
// `deep-whale-day-night-theme` builtin-row distribution was retired: it
// augmented a base row only shipped by `dsh-client-ui-theme-plugins` (absent
// on the pinned rc.6 family), so its patch silently no-oped and the skin
// never loaded. See `vendor/dsh-plugins/VENDOR.md`.
registerBuiltinPlugin({
  kind: 'vendor',
  dir: 'dsh-deep-whale',
  package: '@dsh-external/dsh-client-ui-skin-maid-atelier',
});
registerBuiltinPlugin({ kind: 'vendor', dir: 'dsh-shortcuts', package: 'dsh-shortcuts' });

// In-house workspace built-ins ship built — the workspace build must have run
// before provisioning — and their host bundles are self-contained (runtime
// deps inlined), so copying the package dir is enough: the profile gets
// `package.json` + `lib/` + `cordis.patch.yml` with no pnpm install.
registerBuiltinPlugin({
  kind: 'workspace',
  dir: 'packages/uniterra-provider',
  package: '@uniterra-solutions/uniterra-provider',
});

registerBuiltinPlugin({
  retired: true,
  package: 'dsh-hotkeys',
  comment: 'Keyboard hotkeys: overlapped by the vendored dsh-shortcuts.',
});
registerBuiltinPlugin({
  retired: true,
  package: '@leetoners/dsh-ui-subagent-monitor',
  comment: 'Live subagent monitor: covered by dsh-better-sidebar Tasks page.',
});
registerBuiltinPlugin({
  retired: true,
  package: 'dsh-git-graph',
  comment: 'Embedded git graph: covered by dsh-better-sidebar Git panel.',
});
registerBuiltinPlugin({
  retired: true,
  package: 'dsh-thinking-effort',
  comment:
    'Third-party reasoning-effort editor: the provider declares reasoningEfforts from models.dev.',
});

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

/** Every declared registry entry, in declaration order (a snapshot copy). */
export function builtinPlugins(): readonly BuiltinPlugin[] {
  return [...registry];
}

/** Active (non-retired) registry entries, in declaration order. */
function activeBuiltins(): readonly ActiveBuiltin[] {
  return registry.filter((entry): entry is ActiveBuiltin => !isRetired(entry));
}

/** The npm built-in specs, in declaration order. */
export function npmBuiltinSpecs(): readonly string[] {
  return activeBuiltins()
    .filter((entry): entry is NpmBuiltin => entry.kind === 'npm')
    .map((entry) => entry.spec);
}

/** The copy-based built-ins of one kind, in declaration order. */
export function copyBuiltins(kind: 'vendor' | 'workspace'): readonly CopyBuiltin[] {
  return activeBuiltins().filter((entry): entry is CopyBuiltin => entry.kind === kind);
}

/** The package names of every retired built-in, in declaration order. */
export function retiredBuiltinNames(): readonly string[] {
  return registry.filter(isRetired).map((entry) => entry.package);
}

/** The expected bundle rows of a fully provisioned uniterra profile: the
 * official dsh bundles plus every active built-in plugin's package name. */
export function expectedBuiltinBundles(): string[] {
  return [
    '@deepseek-ai/dsh-base',
    '@deepseek-ai/dsh-web-app',
    ...npmBuiltinSpecs().map(builtinPackageName),
    ...copyBuiltins('vendor').map((entry) => entry.package),
    ...copyBuiltins('workspace').map((entry) => entry.package),
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
    return expectedBuiltinBundles().every((name) => bundles.has(name));
  } catch {
    return false;
  }
}

/** Whether any copy-based built-in's installed copy in the profile has drifted
 * from the current source. The bundle list alone cannot tell — a plugin can
 * ship a fixed distribution under the SAME package name (the skin swap), so a
 * stale node_modules copy must be detected by content identity (package.json
 * `version`). A missing or illegible installed copy is stale. Kind-aware:
 * vendored sources resolve under `vendorRoot`, workspace sources under
 * `sourceRoot`. Returns false only when every installed copy matches. */
export function copyBuiltinsStale(
  profileDirPath: string,
  vendorRoot: string,
  sourceRoot: string,
): boolean {
  for (const entry of activeBuiltins()) {
    if (entry.kind === 'npm') {
      continue;
    }
    const root = entry.kind === 'vendor' ? vendorRoot : sourceRoot;
    const sourcePkg = path.join(root, entry.dir, 'package.json');
    const installedPkg = path.join(
      profileDirPath,
      'node_modules',
      ...entry.package.split('/'),
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
 * Remove retired built-ins from one profile: their bundle rows, their
 * `dependencies` entries, and their installed copies under node_modules.
 * Idempotent and cheap; runs before the provisioning gate so already-full
 * profiles heal by removal instead of early-returning.
 *
 * @returns true when anything was removed or rewritten.
 */
export function removeRetiredBuiltins(profileDirPath: string): boolean {
  const retired = retiredBuiltinNames();
  let changed = false;
  for (const name of retired) {
    const dest = path.join(profileDirPath, 'node_modules', ...name.split('/'));
    if (existsSync(dest)) {
      rmSync(dest, { recursive: true, force: true });
      changed = true;
    }
  }
  const manifestPath = path.join(profileDirPath, 'package.json');
  try {
    const manifest = readJson(manifestPath) as {
      dependencies?: Record<string, string>;
      dsh?: { profile?: { bundles?: unknown } };
    };
    let manifestChanged = false;
    const profile = manifest.dsh?.profile;
    if (profile !== undefined && Array.isArray(profile.bundles)) {
      const kept = (profile.bundles as unknown[]).filter(
        (name) => typeof name !== 'string' || !retired.includes(name),
      );
      if (kept.length !== profile.bundles.length) {
        profile.bundles = kept;
        manifestChanged = true;
      }
    }
    if (manifest.dependencies !== undefined) {
      const keptDeps: Record<string, string> = {};
      for (const [name, version] of Object.entries(manifest.dependencies)) {
        if (!retired.includes(name)) {
          keptDeps[name] = version;
        }
      }
      if (Object.keys(keptDeps).length !== Object.keys(manifest.dependencies).length) {
        manifest.dependencies = keptDeps;
        manifestChanged = true;
      }
    }
    if (manifestChanged) {
      writeJson(manifestPath, manifest);
      changed = true;
    }
  } catch {
    // No legible manifest — nothing to clean there; node_modules removal
    // above has already run.
  }
  return changed;
}

/**
 * Ensure the built-in plugins are installed into `dshHome`'s profile.
 *
 * @param dshHome the home the running dsh uses (dev test home or ~/.dsh).
 * @param profile the profile name (`web`).
 * @param dshCli absolute path to the bundled dsh CLI (lib/bin.js).
 * @param nodeExec the node executable to run the CLI with.
 * @param vendorRoot the vendored plugin sources (app resources or monorepo).
 * @param sourceRoot the source root the workspace built-ins live under
 *   (dev → the monorepo root, packaged → `Contents/Resources/src`).
 */
export function ensureBuiltinPlugins(
  dshHome: string,
  profile: string,
  dshCli: string,
  nodeExec: string,
  vendorRoot: string,
  sourceRoot: string,
): void {
  const dir = profileDir(dshHome, profile);
  if (!existsSync(dir)) {
    return; // no profile yet — nothing to ensure
  }
  // Heal retired built-ins first: an already-full profile early-returns
  // below, so this is the only pass that can remove them.
  removeRetiredBuiltins(dir);
  if (hasAllBuiltins(dir) && !copyBuiltinsStale(dir, vendorRoot, sourceRoot)) {
    return;
  }

  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'pnpm-workspace.yaml'), PROFILE_PNPM_WORKSPACE, 'utf8');

  const env = { ...process.env, DSH_HOME: dshHome, ELECTRON_RUN_AS_NODE: '1' };
  for (const spec of npmBuiltinSpecs()) {
    execFileSync(nodeExec, [dshCli, 'plugin', '--profile', profile, 'add', spec], {
      env,
      stdio: 'inherit',
    });
  }

  // Copy-based built-ins (vendor + workspace): copy under their package name
  // and append the bundle rows to the profile manifest (dsh plugin add can't
  // be used — these packages declare peers that are not on npm).
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

  // Copy one built-in package dir into the profile's node_modules and make
  // sure its Loader bundle row is present in the manifest.
  const copyBuiltin = (sourceDir: string, pkgName: string): void => {
    if (!bundles.includes(pkgName)) {
      bundles.push(pkgName);
    }
    const dest = path.join(dir, 'node_modules', ...pkgName.split('/'));
    rmSync(dest, { recursive: true, force: true });
    mkdirSync(path.dirname(dest), { recursive: true });
    cpSync(sourceDir, dest, { recursive: true });
  };

  for (const entry of activeBuiltins()) {
    if (entry.kind === 'npm') {
      continue;
    }
    const root = entry.kind === 'vendor' ? vendorRoot : sourceRoot;
    copyBuiltin(path.join(root, entry.dir), entry.package);
  }
  writeJson(manifestPath, manifest);
}

/** The bundled skills dir (rank-600 bundled provider): dev → monorepo
 * packages/uniterra-skills/src/skills, packaged → resources/skills. */
export function builtinSkillsDir(
  dev: boolean,
  resourcesPath: string,
  monorepoRoot: string,
): string | undefined {
  const candidate = dev
    ? path.join(monorepoRoot, 'packages', 'uniterra-skills', 'src', 'skills')
    : path.join(resourcesPath, 'skills');
  return existsSync(candidate) ? candidate : undefined;
}
