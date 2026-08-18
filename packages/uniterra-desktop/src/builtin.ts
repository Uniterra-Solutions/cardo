/**
 * Uniterra built-ins: the company plugins and skills that ship with the app and
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
  'dsh-tool-git@0.1.3',
  'dsh-browser-playwright@0.1.1',
  'dsh-computer-use@0.1.0',
] as const;

/** Vendored (non-npm) built-ins: source dir → package name. The loader
 * resolves a bundle row by the package.json `name`, which can differ from
 * the repo dir. They are copied into the profile's node_modules (not
 * pnpm-installed) because some declare peers that only exist in the dsh
 * source workspace and pnpm would fail fetching them.
 *
 * The skin is the `dsh-deep-whale` standalone distribution (`maid-atelier`
 * package) — self-inserting, host is a no-op, art embedded. The earlier
 * `deep-whale-day-night-theme` builtin-row distribution was retired: it
 * augmented a base row only shipped by `dsh-client-ui-theme-plugins` (absent
 * on the pinned rc.6 family), so its patch silently no-oped and the skin
 * never loaded. See `vendor/dsh-plugins/VENDOR.md`. */
export const BUILTIN_VENDOR_PLUGINS: Readonly<Record<string, string>> = {
  'dsh-deep-whale': '@dsh-external/dsh-client-ui-skin-maid-atelier',
  'dsh-shortcuts': 'dsh-shortcuts',
};

/** In-house (this repo's own) built-ins: source dir (relative to the source
 * root — dev → the monorepo root, packaged → `Contents/Resources/src`) →
 * package name, matching {@link BUILTIN_VENDOR_PLUGINS}'s direction. They
 * ship built — the workspace build must have run before provisioning — and
 * their host bundles are self-contained (runtime deps inlined), so copying
 * the package dir is enough: the profile gets `package.json` + `lib/` +
 * `cordis.patch.yml` with no pnpm install. Unlike the vendored plugins
 * (third-party, pinned commits), these live in this repo under `packages/`,
 * which is why they resolve from the source root instead of
 * `vendor/dsh-plugins`. */
export const BUILTIN_WORKSPACE_PLUGINS: Readonly<Record<string, string>> = {
  'packages/uniterra-provider': '@uniterra-solutions/uniterra-provider',
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

/** The expected bundle rows of a fully provisioned uniterra profile: the
 * official dsh bundles plus every built-in plugin's package name. */
export function expectedBuiltinBundles(
  npmPlugins: readonly string[],
  vendorPlugins: Readonly<Record<string, string>>,
  workspacePlugins: Readonly<Record<string, string>> = BUILTIN_WORKSPACE_PLUGINS,
): string[] {
  return [
    '@deepseek-ai/dsh-base',
    '@deepseek-ai/dsh-web-app',
    ...npmPlugins.map(builtinPackageName),
    ...Object.values(vendorPlugins),
    ...Object.values(workspacePlugins),
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

/** Whether any in-house (workspace) built-in's installed copy has drifted
 * from the current source. Same content-identity check as
 * {@link vendoredPluginsStale}, but the source lives inside the source root
 * (`packages/*`) rather than `vendor/dsh-plugins`. A missing or illegible
 * installed copy is stale. Returns false only when every installed copy
 * matches the current source. */
export function workspacePluginsStale(profileDirPath: string, sourceRoot: string): boolean {
  for (const [relDir, pkgName] of Object.entries(BUILTIN_WORKSPACE_PLUGINS)) {
    const sourcePkg = path.join(sourceRoot, relDir, 'package.json');
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

/** Built-in plugins retired from the uniterra profile (dropped, or their
 * function folded into another built-in). A profile provisioned by an older
 * uniterra still carries their bundle rows and installed copies; because
 * {@link hasAllBuiltins} deliberately ignores extras, those rows would stay
 * loaded forever without an explicit heal. Removal targets exactly these
 * names — user-installed plugins are never touched. */
export const RETIRED_BUILTINS: readonly string[] = [
  // Keyboard hotkeys: overlapped by the vendored `dsh-shortcuts`.
  'dsh-hotkeys',
  // Live subagent monitor: covered by dsh-better-sidebar's Tasks page.
  '@leetoners/dsh-ui-subagent-monitor',
  // Embedded git graph: covered by dsh-better-sidebar's Git panel.
  'dsh-git-graph',
  // Third-party reasoning-effort editor: @uniterra-solutions/uniterra-provider declares
  // reasoningEfforts from models.dev and edits them in its own settings page.
  'dsh-thinking-effort',
  // Pre-rename workspace built-in: the project rename ships the same plugin as
  // @uniterra-solutions/uniterra-provider, so old profiles must not keep
  // loading both provider rows.
  '@cardo/cardo-provider',
];

/**
 * Remove retired built-ins from one profile: their bundle rows, their
 * `dependencies` entries, and their installed copies under node_modules.
 * Idempotent and cheap; runs before the provisioning gate so already-full
 * profiles heal by removal instead of early-returning.
 *
 * @returns true when anything was removed or rewritten.
 */
export function removeRetiredBuiltins(profileDirPath: string): boolean {
  let changed = false;
  for (const name of RETIRED_BUILTINS) {
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
        (name) => typeof name !== 'string' || !RETIRED_BUILTINS.includes(name),
      );
      if (kept.length !== profile.bundles.length) {
        profile.bundles = kept;
        manifestChanged = true;
      }
    }
    if (manifest.dependencies !== undefined) {
      const keptDeps: Record<string, string> = {};
      for (const [name, version] of Object.entries(manifest.dependencies)) {
        if (!RETIRED_BUILTINS.includes(name)) {
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
  if (
    hasAllBuiltins(dir) &&
    !vendoredPluginsStale(dir, vendorRoot) &&
    !workspacePluginsStale(dir, sourceRoot)
  ) {
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

  // Vendored plugins: copy under their package name and append the bundle rows
  // to the profile manifest (dsh plugin add can't be used — the vendored
  // packages declare peers that are not on npm).
  for (const [dirName, pkgName] of Object.entries(BUILTIN_VENDOR_PLUGINS)) {
    copyBuiltin(path.join(vendorRoot, dirName), pkgName);
  }

  // In-house workspace built-ins: same copy semantics, but the source lives in
  // the source root (`packages/*`). The workspace build must have produced the
  // package's lib/ before this runs — the copy carries the built bundle, the
  // package.json, and cordis.patch.yml, so the profile needs no pnpm install.
  for (const [relDir, pkgName] of Object.entries(BUILTIN_WORKSPACE_PLUGINS)) {
    copyBuiltin(path.join(sourceRoot, relDir), pkgName);
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
