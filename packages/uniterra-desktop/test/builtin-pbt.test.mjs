/**
 * PBT suite for the uniterra desktop built-ins (compiled dist).
 *
 * Business invariants locked here:
 *  - REGISTRY: the single registerBuiltinPlugin registry is the source of
 *    truth — one representative entry per kind (npm / vendor / workspace /
 *    optional) flows into the expected bundles, and retired names never do.
 *    Optional entries never do either.
 *  - EXTRACT: every built-in npm spec `<name>@<version>` contributes its
 *    package NAME to the expected bundles — including scoped names
 *    (`@scope/name@1.0.0` → `@scope/name`).
 *  - SET: hasAllBuiltins is true iff the profile bundle list carries every
 *    expected bundle (extras and order never matter); malformed manifests
 *    are "not provisioned", never an exception.
 *  - STALE: the unified copyBuiltinsStale detects drift by content identity
 *    for BOTH vendored and workspace built-ins, and never for optional ones
 *    (reconcileOptionalPlugins owns their freshness).
 *  - RETIRED: removeRetiredBuiltins heals exactly the retired names.
 *  - OPTIONAL: the `.uniterra.json` toggle is authoritative — enabled means
 *    row + fresh copy ensured, disabled means row + copy removed; a missing
 *    file migrates from the bundle rows (existing installs preserved), and
 *    an illegible file is never destructive and never overwritten.
 *  - READY: awaitReadiness resolves with the first `http://127.0.0.1:<port>`
 *    seen, across arbitrary chunk boundaries, and rejects when the stream
 *    never carries one.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fc from 'fast-check';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import {
  OPTIONAL_PLUGINS_FILE,
  builtinPackageName,
  builtinPlugins,
  copyBuiltins,
  copyBuiltinsStale,
  expectedBuiltinBundles,
  hasAllBuiltins,
  npmBuiltinSpecs,
  reconcileOptionalPlugins,
  removeRetiredBuiltins,
  retiredBuiltinNames,
} from '../dist/builtin.js';
import { awaitReadiness } from '../dist/dsh-process.js';

const NPM_SPECS = npmBuiltinSpecs();
const VENDOR = copyBuiltins('vendor');
const WORKSPACE = copyBuiltins('workspace');
const OPTIONAL = copyBuiltins('optional');
const RETIRED = retiredBuiltinNames();

// ---------------------------------------------------------------------------
// REGISTRY — one declarative entry per built-in, every consumer derived
// ---------------------------------------------------------------------------

test('REGISTRY: one representative entry per kind flows into the expected bundles', () => {
  const expected = expectedBuiltinBundles();
  // Official dsh bundles always lead.
  assert.deepEqual(expected.slice(0, 2), ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']);
  // npm kind.
  assert.ok(NPM_SPECS.length >= 9, 'the full npm built-in set is registered');
  for (const spec of NPM_SPECS) {
    assert.ok(
      expected.includes(builtinPackageName(spec)),
      `npm spec ${spec} contributes its package name`,
    );
  }
  // vendor kind.
  assert.ok(VENDOR.length >= 1, 'the vendored built-in is registered');
  for (const { dir, package: pkg } of VENDOR) {
    assert.ok(expected.includes(pkg), `vendor ${dir} contributes ${pkg}`);
  }
  // workspace kind.
  assert.ok(WORKSPACE.length >= 1, 'the workspace built-in is registered');
  for (const { dir, package: pkg } of WORKSPACE) {
    assert.ok(expected.includes(pkg), `workspace ${dir} contributes ${pkg}`);
  }
  // The settings-UI extension ships as a workspace built-in (issue #2).
  assert.ok(
    WORKSPACE.some(({ package: pkg }) => pkg === '@uniterra-solutions/uniterra-settings-ui'),
    'the settings UI extension is registered as a workspace built-in',
  );
  assert.ok(
    expected.includes('@uniterra-solutions/uniterra-settings-ui'),
    'the settings UI extension is an expected bundle',
  );
  // dsh-memory ships as an npm built-in, pinned exact (issue #5).
  assert.ok(
    NPM_SPECS.includes('@meomeo-dev/dsh-memory@0.5.6'),
    'dsh-memory is registered at the pinned exact version',
  );
  assert.ok(expected.includes('@meomeo-dev/dsh-memory'), 'dsh-memory contributes its package name');
  // optional kind — registered, but NEVER an expected bundle.
  assert.ok(OPTIONAL.length >= 1, 'the optional built-in stays registered');
  for (const { dir, package: pkg } of OPTIONAL) {
    assert.ok(!expected.includes(pkg), `optional ${dir} does not contribute ${pkg}`);
  }
});

test('REGISTRY: retired names never enter the expected bundles', () => {
  assert.equal(RETIRED.length, 5, 'the five retired built-ins stay declared');
  const expected = expectedBuiltinBundles();
  for (const name of RETIRED) {
    assert.ok(!expected.includes(name), `retired ${name} is not an expected bundle`);
  }
});

test('REGISTRY: every entry is declared exactly once', () => {
  const plugins = builtinPlugins();
  const identities = plugins.map((entry) =>
    entry.retired === true
      ? `retired:${entry.package}`
      : `${entry.kind}:${entry.kind === 'npm' ? entry.spec : entry.dir}`,
  );
  assert.equal(new Set(identities).size, identities.length, 'no duplicate declarations');
});

test('REGISTRY: npm specs are pinned exact (no caret/tilde, semver version)', () => {
  for (const spec of NPM_SPECS) {
    const at = spec.lastIndexOf('@');
    const version = spec.slice(at + 1);
    assert.ok(/^\d+\.\d+\.\d+$/u.test(version), `${spec} is exact`);
  }
});

// ---------------------------------------------------------------------------
// EXTRACT — npm spec → package name
// ---------------------------------------------------------------------------

const npmSpecArb = fc.oneof(
  fc.constant('dshmarket@1.9.0'),
  fc.constant('dsh-notifier@0.6.2'),
  fc.constant('dsh-better-sidebar@0.12.2'),
  fc.constant('@dsh-external/dsh-client-ui-skin-maid-atelier@1.0.0'),
  fc.constant('@meomeo-dev/dsh-memory@0.5.6'),
  fc.constant('dsh-shortcuts@1.1.0'),
);

/** Independent model: the version split is on the LAST `@` (names may be scoped). */
function packageNameOf(spec) {
  const at = spec.lastIndexOf('@');
  return at <= 0 ? spec : spec.slice(0, at);
}

test('EXTRACT: a spec always splits its package name on the LAST @', () => {
  fc.assert(
    fc.property(npmSpecArb, (spec) => {
      assert.equal(builtinPackageName(spec), packageNameOf(spec));
    }),
  );
});

test('EXTRACT regression: scoped spec — the split must be on the LAST @', () => {
  // PBT counterexample: `spec.split('@')[0]` returned '' for a scoped package,
  // so the idempotency gate could never trip for scoped built-ins.
  assert.equal(
    builtinPackageName('@dsh-external/dsh-client-ui-skin-maid-atelier@1.0.0'),
    '@dsh-external/dsh-client-ui-skin-maid-atelier',
  );
  assert.equal(builtinPackageName('dshmarket@1.9.0'), 'dshmarket');
  assert.equal(builtinPackageName('@scope/name'), '@scope/name'); // no version
  assert.equal(builtinPackageName('plain'), 'plain');
});

// ---------------------------------------------------------------------------
// SET — hasAllBuiltins
// ---------------------------------------------------------------------------

const bundleWordArb = fc.constantFrom(
  '@deepseek-ai/dsh-base',
  '@deepseek-ai/dsh-web-app',
  'dshmarket',
  'dsh-notifier',
  'dsh-better-sidebar',
  'dsh-file-upload',
  'dsh-find-plugin',
  'dsh-subagent-model-picker',
  '@dsh-external/dsh-client-ui-skin-maid-atelier',
  'dsh-shortcuts',
  '@meomeo-dev/dsh-memory',
  '@uniterra-solutions/uniterra-provider',
  '@uniterra-solutions/uniterra-settings-ui',
  // Retired built-ins linger in profiles provisioned by older uniterra builds;
  // they must count as harmless extras for the SET verdict.
  ...RETIRED,
  'user-installed-plugin',
  'totally-unrelated',
);

/** Independent expected set computed from the registry accessors. */
function modelExpected() {
  return expectedBuiltinBundles();
}

async function writeProfileManifest(dir, bundles) {
  const profileDir = join(dir, 'profiles', 'web');
  await mkdir(profileDir, { recursive: true });
  await writeFile(
    join(profileDir, 'package.json'),
    `${JSON.stringify({ dsh: { profile: { bundles } } })}\n`,
  );
}

test('SET: hasAllBuiltins iff every expected bundle is present; order and extras are irrelevant', async () => {
  await fc.assert(
    fc.asyncProperty(fc.array(bundleWordArb, { maxLength: 20 }), async (bundles) => {
      const dir = await mkdtemp(join(tmpdir(), 'uniterra-set-'));
      try {
        await writeProfileManifest(dir, bundles);
        const expected = modelExpected();
        const want = expected.every((name) => bundles.includes(name));
        assert.equal(hasAllBuiltins(dir), want, `bundles=${JSON.stringify(bundles)}`);
        // Order independence: a shuffled profile decides identically.
        const shuffled = [...bundles].sort(() => -1);
        await writeProfileManifest(dir, shuffled);
        assert.equal(hasAllBuiltins(dir), want, 'shuffled order must not change the verdict');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }),
  );
});

test('SET: malformed profiles are "not provisioned", never an exception', async () => {
  const malformed = fc.oneof(
    fc.constant('not json at all {{{'),
    fc.constant('{"name":"x"}'),
    fc.constant('{"dsh":{}}'),
    fc.constant('{"dsh":{"profile":{}}}'),
    fc.constant('{"dsh":{"profile":{"bundles":"oops"}}}'),
    fc.constant('{"dsh":{"profile":{"bundles":[42,true]}}}'),
  );
  await fc.assert(
    fc.asyncProperty(malformed, async (body) => {
      const dir = await mkdtemp(join(tmpdir(), 'uniterra-set-'));
      try {
        const profileDir = join(dir, 'profiles', 'web');
        await mkdir(profileDir, { recursive: true });
        await writeFile(join(profileDir, 'package.json'), body);
        assert.equal(hasAllBuiltins(dir), false, 'malformed manifest is not provisioned');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }),
  );
});

test('SET: a missing profile directory is "not provisioned"', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'uniterra-set-'));
  try {
    assert.equal(hasAllBuiltins(dir), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// VENDOR — vendored built-ins must be self-contained, and the skin is the
//          standalone distribution (not the retired builtin-row one)
// ---------------------------------------------------------------------------

const vendorPluginsRoot = resolve(import.meta.dirname, '..', '..', '..', 'vendor', 'dsh-plugins');

/**
 * A vendored bundle patch is self-contained iff every top-level entry is a
 * root `insert`. The retired skin distribution augmented a base
 * `ui-skin-maid-atelier` row that only the theme-plugins bundle ships — an
 * id-targeted patch like that silently no-ops on the pinned rc.6 family and
 * the plugin never mounts (the reported bug).
 */
function isSelfContainedPatch(patchText) {
  const topLevel = patchText
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => /^- /u.test(line));
  assert.ok(topLevel.length > 0, 'patch must have at least one top-level entry');
  return topLevel.every((line) => /^-\s+insert\s*:/u.test(line));
}

test('VENDOR: every vendored built-in contributes its Loader row via a self-contained insert patch', async () => {
  assert.ok(VENDOR.length >= 1, 'the vendored built-in remains shipped');
  for (const { dir } of VENDOR) {
    const text = await readFile(join(vendorPluginsRoot, dir, 'cordis.patch.yml'), 'utf8');
    assert.ok(
      isSelfContainedPatch(text),
      `${dir}/cordis.patch.yml must be a self-contained root insert`,
    );
  }
});

test('VENDOR regression: retired built-ins must be gone from the vendored registry', () => {
  const vendorPackages = VENDOR.map((entry) => entry.package);
  for (const name of RETIRED) {
    assert.ok(!vendorPackages.includes(name), `retired ${name} must not ship as vendored`);
  }
});

// ---------------------------------------------------------------------------
// STALE — the unified copyBuiltinsStale detects drift for BOTH kinds
// ---------------------------------------------------------------------------

/** Every copy-based built-in with its source root. */
function copyEntries() {
  return [
    ...VENDOR.map((entry) => ({ ...entry, root: 'vendor' })),
    ...WORKSPACE.map((entry) => ({ ...entry, root: 'workspace' })),
  ];
}

/** Write one copy built-in's source package.json under its kind's root. */
async function writeCopySource(rootDir, dir, version) {
  const dest = join(rootDir, dir);
  await mkdir(dest, { recursive: true });
  await writeFile(join(dest, 'package.json'), `${JSON.stringify({ name: dir, version })}\n`);
}

/** Write one copy built-in's installed copy into a profile's node_modules. */
async function writeInstalledCopy(profileDir, pkgName, version) {
  const dest = join(profileDir, 'node_modules', ...pkgName.split('/'));
  await mkdir(dest, { recursive: true });
  await writeFile(join(dest, 'package.json'), `${JSON.stringify({ name: pkgName, version })}\n`);
}

/** Build a profile + vendor/workspace fixture where every copy built-in is
 * present, optionally drifting exactly one of them. Returns the fixture. */
async function staleFixture({ driftDir }) {
  const dir = await mkdtemp(join(tmpdir(), 'uniterra-stale-'));
  const vendor = join(dir, 'vendor');
  const source = join(dir, 'source');
  const profile = join(dir, 'profiles', 'web');
  await mkdir(profile, { recursive: true });
  await writeProfileManifest(dir, []);
  for (const entry of copyEntries()) {
    const root = entry.root === 'vendor' ? vendor : source;
    await writeCopySource(root, entry.dir, '1.0.0');
    const version = entry.dir === driftDir ? '1.0.1' : '1.0.0';
    await writeInstalledCopy(profile, entry.package, version);
  }
  return { dir, vendor, source, profile };
}

test('STALE: a copy matching the source is fresh; a single drift (either kind) is stale', async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.constantFrom(...copyEntries().map((entry) => entry.dir), null),
      async (driftDir) => {
        const { dir, vendor, source, profile } = await staleFixture({ driftDir });
        try {
          assert.equal(copyBuiltinsStale(profile, vendor, source), driftDir !== null);
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      },
    ),
  );
});

test('STALE: a missing or illegible installed copy is stale (forces re-provision)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'uniterra-stale-'));
  try {
    const vendor = join(dir, 'vendor');
    const source = join(dir, 'source');
    const profile = join(dir, 'profiles', 'web');
    await mkdir(profile, { recursive: true });
    await writeProfileManifest(dir, []);
    for (const entry of copyEntries()) {
      const root = entry.root === 'vendor' ? vendor : source;
      await writeCopySource(root, entry.dir, '1.0.0');
    }
    // No installed copies at all → stale.
    assert.equal(copyBuiltinsStale(profile, vendor, source), true);
    // One illegible installed package.json → stale.
    const skin = join(profile, 'node_modules', '@dsh-external', 'dsh-client-ui-skin-maid-atelier');
    await mkdir(skin, { recursive: true });
    await writeFile(join(skin, 'package.json'), 'not json at all');
    assert.equal(copyBuiltinsStale(profile, vendor, source), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('STALE: optional entries never force a stale verdict (reconcile owns them)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'uniterra-stale-'));
  try {
    const vendor = join(dir, 'vendor');
    const source = join(dir, 'source');
    const profile = join(dir, 'profiles', 'web');
    await mkdir(profile, { recursive: true });
    await writeProfileManifest(dir, []);
    for (const entry of copyEntries()) {
      const root = entry.root === 'vendor' ? vendor : source;
      await writeCopySource(root, entry.dir, '1.0.0');
      await writeInstalledCopy(profile, entry.package, '1.0.0');
    }
    // Every mandatory copy matches; the optional skin has NO copy at all.
    // A disabled optional must not make the profile look stale — that would
    // force a re-provision on every boot.
    assert.equal(copyBuiltinsStale(profile, vendor, source), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// OPTIONAL — the .uniterra.json toggle is authoritative; a missing file
//            migrates from bundle rows (existing installs preserved); an
//            illegible file is never destructive and never overwritten
// ---------------------------------------------------------------------------

const SKIN_PKG = '@dsh-external/dsh-client-ui-skin-maid-atelier';

test('OPTIONAL regression: the skin ships the standalone dsh-deep-whale distribution, not the retired builtin-row one', () => {
  const skin = OPTIONAL.find((entry) => entry.dir === 'dsh-deep-whale');
  assert.equal(skin?.package, SKIN_PKG);
  assert.ok(
    !VENDOR.some((entry) => entry.dir === 'deep-whale-day-night-theme'),
    'the retired deep-whale-day-night-theme source must be gone',
  );
  assert.ok(
    !expectedBuiltinBundles().includes(SKIN_PKG),
    'the skin is never an expected bundle (default absent)',
  );
});

/** Build a profile fixture with a skin source in `vendor/` and the given
 * toggle file, bundle rows, and installed copy version. */
async function optionalFixture({ stateFile, bundles, installedVersion }) {
  const dir = await mkdtemp(join(tmpdir(), 'uniterra-optional-'));
  const vendor = join(dir, 'vendor');
  const profile = join(dir, 'profiles', 'web');
  const skinSource = join(vendor, 'dsh-deep-whale');
  await mkdir(skinSource, { recursive: true });
  await writeFile(
    join(skinSource, 'package.json'),
    `${JSON.stringify({ name: SKIN_PKG, version: '1.0.0' })}\n`,
  );
  await mkdir(profile, { recursive: true });
  await writeFile(
    join(profile, 'package.json'),
    `${JSON.stringify({ dsh: { profile: { bundles } } })}\n`,
  );
  if (stateFile !== undefined) {
    await writeFile(join(profile, OPTIONAL_PLUGINS_FILE), stateFile);
  }
  if (installedVersion !== undefined) {
    const dest = join(profile, 'node_modules', ...SKIN_PKG.split('/'));
    await mkdir(dest, { recursive: true });
    await writeFile(
      join(dest, 'package.json'),
      `${JSON.stringify({ name: SKIN_PKG, version: installedVersion })}\n`,
    );
  }
  return { dir, profile, vendor };
}

async function readManifest(profile) {
  return JSON.parse(await readFile(join(profile, 'package.json'), 'utf8'));
}

async function readStateFile(profile) {
  return JSON.parse(await readFile(join(profile, OPTIONAL_PLUGINS_FILE), 'utf8'));
}

async function skinInstalled(profile) {
  return existsSync(join(profile, 'node_modules', ...SKIN_PKG.split('/')));
}

test('OPTIONAL DEFAULT-ABSENT: a fresh profile stays skin-free and is persisted as disabled', async () => {
  const { dir, profile } = await optionalFixture({
    bundles: ['@deepseek-ai/dsh-base'],
    stateFile: undefined,
  });
  try {
    const changed = reconcileOptionalPlugins(profile, join(dir, 'vendor'));
    assert.equal(changed, true, 'the missing toggle file is persisted');
    const manifest = await readManifest(profile);
    assert.ok(!manifest.dsh.profile.bundles.includes(SKIN_PKG), 'no skin row added');
    assert.equal(await skinInstalled(profile), false, 'no skin copy installed');
    assert.deepEqual((await readStateFile(profile)).optionalPlugins, {}, 'persisted as disabled');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('OPTIONAL MIGRATION: an existing row-bearing profile is preserved and persisted as enabled', async () => {
  const { dir, profile } = await optionalFixture({
    bundles: ['@deepseek-ai/dsh-base', SKIN_PKG],
    stateFile: undefined,
    installedVersion: '1.0.0',
  });
  try {
    const changed = reconcileOptionalPlugins(profile, join(dir, 'vendor'));
    assert.equal(changed, true, 'the missing toggle file is persisted');
    const manifest = await readManifest(profile);
    assert.ok(manifest.dsh.profile.bundles.includes(SKIN_PKG), 'the existing row is kept');
    assert.equal(await skinInstalled(profile), true, 'the installed copy is kept');
    assert.equal(
      (await readStateFile(profile)).optionalPlugins[SKIN_PKG],
      true,
      'persisted as enabled',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('OPTIONAL ENABLED: the toggle installs the row and a fresh copy', async () => {
  const stateFile = `${JSON.stringify({ version: 1, optionalPlugins: { [SKIN_PKG]: true } })}\n`;
  const { dir, profile } = await optionalFixture({
    bundles: ['@deepseek-ai/dsh-base'],
    stateFile,
  });
  try {
    const changed = reconcileOptionalPlugins(profile, join(dir, 'vendor'));
    assert.equal(changed, true, 'the row and copy were installed');
    const manifest = await readManifest(profile);
    assert.ok(manifest.dsh.profile.bundles.includes(SKIN_PKG), 'row appended');
    const installed = JSON.parse(
      await readFile(join(profile, 'node_modules', ...SKIN_PKG.split('/'), 'package.json'), 'utf8'),
    );
    assert.equal(installed.version, '1.0.0', 'fresh copy installed');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('OPTIONAL ENABLED: a stale enabled copy is healed to the source version', async () => {
  const stateFile = `${JSON.stringify({ version: 1, optionalPlugins: { [SKIN_PKG]: true } })}\n`;
  const { dir, profile } = await optionalFixture({
    bundles: ['@deepseek-ai/dsh-base', SKIN_PKG],
    stateFile,
    installedVersion: '0.9.0',
  });
  try {
    const changed = reconcileOptionalPlugins(profile, join(dir, 'vendor'));
    assert.equal(changed, true, 'the stale copy was replaced');
    const installed = JSON.parse(
      await readFile(join(profile, 'node_modules', ...SKIN_PKG.split('/'), 'package.json'), 'utf8'),
    );
    assert.equal(installed.version, '1.0.0', 'copy healed to the source version');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('OPTIONAL DISABLED: the toggle removes the row and the copy, idempotently', async () => {
  const stateFile = `${JSON.stringify({ version: 1, optionalPlugins: {} })}\n`;
  const { dir, profile } = await optionalFixture({
    bundles: ['@deepseek-ai/dsh-base', SKIN_PKG],
    stateFile,
    installedVersion: '1.0.0',
  });
  try {
    const changed = reconcileOptionalPlugins(profile, join(dir, 'vendor'));
    assert.equal(changed, true, 'the disabled skin was removed');
    const manifest = await readManifest(profile);
    assert.ok(!manifest.dsh.profile.bundles.includes(SKIN_PKG), 'row removed');
    assert.equal(await skinInstalled(profile), false, 'copy removed');
    assert.equal(
      reconcileOptionalPlugins(profile, join(dir, 'vendor')),
      false,
      'second pass is a no-op',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('OPTIONAL: an illegible toggle file is never destructive and never overwritten', async () => {
  const { dir, profile } = await optionalFixture({
    bundles: ['@deepseek-ai/dsh-base', SKIN_PKG],
    stateFile: 'not json at all {{{',
    installedVersion: '1.0.0',
  });
  try {
    const changed = reconcileOptionalPlugins(profile, join(dir, 'vendor'));
    assert.equal(changed, false, 'nothing is changed for an illegible file');
    const manifest = await readManifest(profile);
    assert.ok(manifest.dsh.profile.bundles.includes(SKIN_PKG), 'row preserved');
    assert.equal(await skinInstalled(profile), true, 'copy preserved');
    assert.equal(
      await readFile(join(profile, OPTIONAL_PLUGINS_FILE), 'utf8'),
      'not json at all {{{',
      'file untouched',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('OPTIONAL: an illegible manifest never throws — the profile is left alone', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'uniterra-optional-'));
  try {
    const profile = join(dir, 'profiles', 'web');
    await mkdir(profile, { recursive: true });
    await writeFile(join(profile, 'package.json'), 'not json at all {{{');
    assert.equal(reconcileOptionalPlugins(profile, join(dir, 'vendor')), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// RETIRED — retired built-ins must heal an already-provisioned profile by
//           removal (rows, dependency entries, installed copies), and never
//           touch anything else
// ---------------------------------------------------------------------------

test('RETIRED: removeRetiredBuiltins removes exactly the retired rows, deps, and installed copies', async () => {
  await fc.assert(
    fc.asyncProperty(fc.subarray(RETIRED, { minLength: 0 }), async (retired) => {
      const dir = await mkdtemp(join(tmpdir(), 'uniterra-retired-'));
      try {
        const profile = join(dir, 'profiles', 'web');
        const installed = new Set(retired);
        const extras = ['user-installed-plugin', '@user/scope-plugin'];
        const deps = Object.fromEntries([
          ...retired.map((name) => [name, '0.1.0']),
          ...extras.map((name) => [name, '1.0.0']),
        ]);
        await mkdir(profile, { recursive: true });
        for (const name of [...installed, ...extras]) {
          const dest = join(profile, 'node_modules', ...name.split('/'));
          await mkdir(dest, { recursive: true });
          await writeFile(join(dest, 'package.json'), `${JSON.stringify({ name })}\n`);
        }
        await writeFile(
          join(profile, 'package.json'),
          `${JSON.stringify({
            dependencies: deps,
            dsh: { profile: { bundles: [...retired, ...extras, 'dsh-better-sidebar'] } },
          })}\n`,
        );

        const removed = removeRetiredBuiltins(profile);
        assert.equal(
          removed,
          retired.length > 0,
          'removal reported iff something retired was present',
        );

        // Second pass is a no-op (idempotent).
        assert.equal(removeRetiredBuiltins(profile), false);

        const manifest = JSON.parse(await readFile(join(profile, 'package.json'), 'utf8'));
        for (const name of RETIRED) {
          assert.ok(!manifest.dsh.profile.bundles.includes(name), `${name} row removed`);
          assert.ok(!(name in manifest.dependencies), `${name} dependency removed`);
        }
        for (const name of extras) {
          assert.ok(manifest.dsh.profile.bundles.includes(name), `${name} row untouched`);
          assert.ok(name in manifest.dependencies, `${name} dependency untouched`);
        }
        assert.ok(manifest.dsh.profile.bundles.includes('dsh-better-sidebar'));
        for (const name of RETIRED) {
          assert.equal(
            existsSync(join(profile, 'node_modules', ...name.split('/'))),
            false,
            `${name} installed copy removed`,
          );
        }
        for (const name of extras) {
          assert.equal(
            existsSync(join(profile, 'node_modules', ...name.split('/'))),
            true,
            `${name} installed copy untouched`,
          );
        }
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }),
  );
});

test('RETIRED: an illegible manifest never throws — node_modules cleanup still runs', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'uniterra-retired-'));
  try {
    const profile = join(dir, 'profiles', 'web');
    await mkdir(profile, { recursive: true });
    const name = RETIRED[0];
    const dest = join(profile, 'node_modules', ...name.split('/'));
    await mkdir(dest, { recursive: true });
    await writeFile(join(profile, 'package.json'), 'not json at all {{{');
    assert.equal(removeRetiredBuiltins(profile), true); // the installed copy was removed
    assert.equal(removeRetiredBuiltins(profile), false);
    assert.equal(existsSync(dest), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// READY — awaitReadiness
// ---------------------------------------------------------------------------

const READY_URL = 'http://127.0.0.1:3080';
/** The readiness line dsh prints — the URL is always followed by a terminator. */
const READY_LINE = `${READY_URL} (LAN: 192.168.1.5)`;

/** Chunks of `s` cut at generated boundaries (empty cuts = one chunk). */
function chunkArb(s) {
  const cuts = fc
    .uniqueArray(fc.integer({ min: 1, max: Math.max(1, s.length - 1) }), {
      maxLength: 10,
      selector: (x) => x,
    })
    .map((xs) => [...xs].sort((a, b) => a - b));
  return cuts.map((cs) => {
    const chunks = [];
    let prev = 0;
    for (const c of cs) {
      chunks.push(s.slice(prev, c));
      prev = c;
    }
    chunks.push(s.slice(prev));
    return chunks;
  });
}

test('READY: resolves with the first 127.0.0.1 URL even when split across arbitrary chunks', async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(fc.constantFrom('booting', ' ', '\n', 'log', 'line', '...', 'http', '://'), {
        maxLength: 8,
      }),
      chunkArb(READY_LINE),
      async (junkParts, chunks) => {
        const stream = new PassThrough();
        const promise = awaitReadiness(stream, 500);
        for (const part of junkParts) {
          stream.write(part);
        }
        for (const chunk of chunks) {
          stream.write(chunk);
        }
        stream.end();
        const url = await promise;
        assert.equal(url, READY_URL);
      },
    ),
  );
});

test('READY: a stream that never carries a 127.0.0.1 URL rejects', async () => {
  const junk = fc.array(
    fc.constantFrom(
      'booting',
      ' ',
      '\n',
      'log',
      'line',
      '...',
      'http',
      '://',
      'localhost',
      'https',
    ),
    { maxLength: 12 },
  );
  await fc.assert(
    fc.asyncProperty(junk, async (parts) => {
      const stream = new PassThrough();
      const promise = awaitReadiness(stream, 25);
      for (const part of parts) {
        stream.write(part);
      }
      stream.end();
      await assert.rejects(() => promise, /did not report readiness/);
    }),
  );
});

test('READY: only http://127.0.0.1:<port> qualifies — https and localhost do not', async () => {
  const stream = new PassThrough();
  const promise = awaitReadiness(stream, 25);
  stream.write('https://127.0.0.1:3080\n');
  stream.write('http://localhost:3080\n');
  stream.end();
  await assert.rejects(() => promise, /did not report readiness/);
});

test('READY regression: a chunk boundary inside the port digits must not truncate the URL', async () => {
  // PBT counterexample: chunks ["http://127.0.0.1:3", "080"] resolved early to
  // "http://127.0.0.1:3" — the shell would have loaded the wrong port.
  const stream = new PassThrough();
  const promise = awaitReadiness(stream, 500);
  stream.write('dsh web: http://127.0.0.1:3');
  stream.write('080 (LAN: 192.168.1.5)\n');
  stream.end();
  assert.equal(await promise, 'http://127.0.0.1:3080');
});

test('READY: the first qualifying URL wins when several appear', async () => {
  const stream = new PassThrough();
  const promise = awaitReadiness(stream, 500);
  stream.write('http://127.0.0.1:1234\n');
  stream.write('http://127.0.0.1:3080\n');
  stream.end();
  assert.equal(await promise, 'http://127.0.0.1:1234');
});
