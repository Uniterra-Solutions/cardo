/**
 * Docker PBT suite for the uniterra installer/desktop flow.
 *
 * Runs inside the verify-cli-container image AFTER `pnpm install` +
 * `pnpm run build` on a pristine source tree (exactly what `uniterra setup`
 * does on a user machine). It locks the property that made v0.6.0's desktop
 * unbootable: the workspace build must produce the entry files the bundled
 * plugins' package.json declare, every built-in must be provisionable, and
 * a freshly provisioned profile must actually boot dsh to a reachable
 * readiness URL.
 *
 * Business invariants:
 *  - SOURCE_ENTRY: every workspace built-in ships the file its package.json
 *    `main` (and `exports` default) points at. Missing `lib/index.js` after
 *    `pnpm run build` → the installed app's profile copy cannot be imported
 *    by the dsh loader and boot dies with ERR_MODULE_NOT_FOUND.
 *  - VENDOR_ENTRY: every vendored built-in's package name matches its
 *    BUILTIN_VENDOR_PLUGINS row and ships a resolvable entry.
 *  - BUNDLES_SET: hasAllBuiltins is true iff every expected bundle is
 *    present; order and extras never matter; malformed manifests are
 *    "not provisioned", never an exception.
 *  - STALE_DETECTION: a missing or version-mismatched installed copy of any
 *    built-in is stale (re-provisioned); a matching copy is not.
 *  - BOOT: after provisioning, `dsh --profile web` reports readiness and
 *    the URL answers HTTP 2xx — the software actually starts.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fc from 'fast-check';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** The pristine source tree this suite runs against (verify.sh exports it). */
function sourceRoot() {
  return process.env.UNITERRA_SOURCE_ROOT ?? process.cwd();
}

// The suite lives outside the workspace (verify.sh copies it next to the
// image's fast-check install), so the compiled desktop dist is loaded from
// the source tree by absolute path.
const DESKTOP_DIST = pathToFileURL(join(sourceRoot(), 'packages', 'uniterra-desktop', 'dist')).href;

const {
  BUILTIN_NPM_PLUGINS,
  BUILTIN_VENDOR_PLUGINS,
  BUILTIN_WORKSPACE_PLUGINS,
  expectedBuiltinBundles,
  hasAllBuiltins,
  vendoredPluginsStale,
  workspacePluginsStale,
  ensureBuiltinPlugins,
} = await import(`${DESKTOP_DIST}/builtin.js`);
const { awaitReadiness, stopDsh } = await import(`${DESKTOP_DIST}/dsh-process.js`);

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

// ---------------------------------------------------------------------------
// SOURCE_ENTRY — the v0.6.0 regression
// ---------------------------------------------------------------------------

const workspaceDirArb = fc.constantFrom(...Object.keys(BUILTIN_WORKSPACE_PLUGINS));

test('SOURCE_ENTRY: every workspace built-in ships the entry its package.json declares', () => {
  fc.assert(
    fc.property(workspaceDirArb, (relDir) => {
      const pkgDir = join(sourceRoot(), relDir);
      const pkg = readJson(join(pkgDir, 'package.json'));
      assert.ok(pkg.main, `workspace built-in ${relDir} must declare main`);
      const entry = join(pkgDir, pkg.main);
      assert.ok(
        existsSync(entry),
        `entry ${pkg.main} missing for ${relDir} — the workspace build must produce it (uniterra setup runs pnpm run build)`,
      );
      const expDefault = pkg.exports?.['.']?.default;
      if (expDefault !== undefined) {
        assert.ok(
          existsSync(join(pkgDir, expDefault)),
          `exports['.'].default ${expDefault} missing for ${relDir}`,
        );
      }
      const expTypes = pkg.exports?.['.']?.types;
      if (expTypes !== undefined) {
        assert.ok(
          existsSync(join(pkgDir, expTypes)),
          `exports['.'].types ${expTypes} missing for ${relDir}`,
        );
      }
    }),
  );
});

test('SOURCE_ENTRY: every vendored built-in matches its package name and ships a resolvable entry', () => {
  fc.assert(
    fc.property(fc.constantFrom(...Object.keys(BUILTIN_VENDOR_PLUGINS)), (dirName) => {
      const pkgDir = join(sourceRoot(), 'vendor', 'dsh-plugins', dirName);
      const pkg = readJson(join(pkgDir, 'package.json'));
      assert.equal(pkg.name, BUILTIN_VENDOR_PLUGINS[dirName], `vendor dir ${dirName} package name`);
      const entryRel = pkg.main ?? 'index.js';
      assert.ok(
        existsSync(join(pkgDir, entryRel)),
        `vendored entry ${dirName}/${entryRel} missing`,
      );
    }),
  );
});

// ---------------------------------------------------------------------------
// BUNDLES_SET — hasAllBuiltins contract
// ---------------------------------------------------------------------------

const bundleWordArb = fc.constantFrom(
  '@deepseek-ai/dsh-base',
  '@deepseek-ai/dsh-web-app',
  ...BUILTIN_NPM_PLUGINS.map((spec) => spec.slice(0, spec.lastIndexOf('@'))),
  ...Object.values(BUILTIN_VENDOR_PLUGINS),
  ...Object.values(BUILTIN_WORKSPACE_PLUGINS),
  'user-installed-plugin',
  'totally-unrelated',
);

function writeProfileManifest(dir, bundles) {
  const profileDir = join(dir, 'profiles', 'web');
  mkdirSync(profileDir, { recursive: true });
  writeFileSync(
    join(profileDir, 'package.json'),
    `${JSON.stringify({ dsh: { profile: { bundles } } })}\n`,
  );
}

test('BUNDLES_SET: hasAllBuiltins iff every expected bundle is present; order and extras are irrelevant', () => {
  fc.assert(
    fc.property(fc.array(bundleWordArb, { maxLength: 20 }), (bundles) => {
      const dir = mkdtempSync(join(tmpdir(), 'uniterra-set-'));
      try {
        writeProfileManifest(dir, bundles);
        const expected = expectedBuiltinBundles(BUILTIN_NPM_PLUGINS, BUILTIN_VENDOR_PLUGINS);
        const want = expected.every((name) => bundles.includes(name));
        assert.equal(hasAllBuiltins(dir), want, `bundles=${JSON.stringify(bundles)}`);
        const shuffled = [...bundles].reverse();
        writeProfileManifest(dir, shuffled);
        assert.equal(hasAllBuiltins(dir), want, 'reversed order must not change the verdict');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }),
  );
});

test('BUNDLES_SET: malformed profiles are "not provisioned", never an exception', () => {
  const malformed = fc.oneof(
    fc.constant('not json at all {{{'),
    fc.constant('{"name":"x"}'),
    fc.constant('{"dsh":{}}'),
    fc.constant('{"dsh":{"profile":{}}}'),
    fc.constant('{"dsh":{"profile":{"bundles":"oops"}}}'),
    fc.constant('{"dsh":{"profile":{"bundles":[42,true]}}}'),
  );
  fc.assert(
    fc.property(malformed, (body) => {
      const dir = mkdtempSync(join(tmpdir(), 'uniterra-set-'));
      try {
        const profileDir = join(dir, 'profiles', 'web');
        mkdirSync(profileDir, { recursive: true });
        writeFileSync(join(profileDir, 'package.json'), body);
        assert.equal(hasAllBuiltins(dir), false, 'malformed manifest is not provisioned');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }),
  );
});

// ---------------------------------------------------------------------------
// STALE_DETECTION — installed-copy drift
// ---------------------------------------------------------------------------

const damageArb = fc.constantFrom('missing', 'version-bump', 'version-match');

function installedCopyDir(profileDir, pkgName) {
  return join(profileDir, 'node_modules', ...pkgName.split('/'));
}

test('STALE_DETECTION: a missing or version-mismatched copy of any built-in is stale; a matching copy is not', () => {
  fc.assert(
    fc.property(
      fc.oneof(
        fc.tuple(fc.constant('vendor'), fc.constantFrom(...Object.keys(BUILTIN_VENDOR_PLUGINS))),
        fc.tuple(
          fc.constant('workspace'),
          fc.constantFrom(...Object.keys(BUILTIN_WORKSPACE_PLUGINS)),
        ),
      ),
      damageArb,
      ([kind, dirKey], damage) => {
        const root = sourceRoot();
        const profileDir = join(mkdtempSync(join(tmpdir(), 'uniterra-stale-')), 'profiles', 'web');
        mkdirSync(profileDir, { recursive: true });
        try {
          // Baseline: EVERY built-in gets a version-matching installed copy.
          // The staleness checks scan all built-ins (any drift ⇒ stale), so
          // only the damaged target may differ from the source versions.
          const entries = [
            ...Object.entries(BUILTIN_VENDOR_PLUGINS).map(([dir, pkg]) => ['vendor', dir, pkg]),
            ...Object.entries(BUILTIN_WORKSPACE_PLUGINS).map(([dir, pkg]) => [
              'workspace',
              dir,
              pkg,
            ]),
          ];
          for (const [entryKind, dir, pkgName] of entries) {
            const sourcePkg =
              entryKind === 'vendor'
                ? readJson(join(root, 'vendor', 'dsh-plugins', dir, 'package.json'))
                : readJson(join(root, dir, 'package.json'));
            if (entryKind === kind && dir === dirKey && damage === 'missing') {
              continue; // the damaged target's installed copy stays absent
            }
            const dest = installedCopyDir(profileDir, pkgName);
            mkdirSync(dest, { recursive: true });
            const version =
              entryKind === kind && dir === dirKey && damage === 'version-bump'
                ? '999.0.0'
                : sourcePkg.version;
            writeFileSync(
              join(dest, 'package.json'),
              `${JSON.stringify({ name: pkgName, version })}\n`,
            );
          }
          const stale =
            kind === 'vendor'
              ? vendoredPluginsStale(profileDir, join(root, 'vendor', 'dsh-plugins'))
              : workspacePluginsStale(profileDir, root);
          assert.equal(stale, damage !== 'version-match', `${kind}/${dirKey} damage=${damage}`);
        } finally {
          rmSync(profileDir, { recursive: true, force: true });
        }
      },
    ),
  );
});

// ---------------------------------------------------------------------------
// BOOT — the software actually starts
// ---------------------------------------------------------------------------

test(
  'BOOT: a freshly provisioned profile boots dsh to a reachable readiness URL',
  { timeout: 300_000 },
  async () => {
    const root = sourceRoot();
    const home = join(tmpdir(), 'uniterra-boot-home');
    rmSync(home, { recursive: true, force: true });

    const dshCli = join(
      root,
      'packages',
      'uniterra-desktop',
      'node_modules',
      '@deepseek-ai',
      'dsh',
      'lib',
      'bin.js',
    );
    assert.ok(existsSync(dshCli), `dsh CLI missing at ${dshCli}`);

    // Provision the profile exactly like the app's startup (ensureBuiltinPlugins).
    ensureBuiltinPlugins(
      home,
      'web',
      dshCli,
      process.execPath,
      join(root, 'vendor', 'dsh-plugins'),
      root,
    );

    // Boot dsh against the sandboxed home and wait for the readiness line.
    const child = spawn(process.execPath, [dshCli, '--profile', 'web'], {
      env: { ...process.env, DSH_HOME: home, NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    try {
      const url = await awaitReadiness(child.stdout, 120_000);
      const res = await fetch(url);
      assert.ok(res.ok, `readiness URL ${url} must answer HTTP 2xx, got ${res.status}`);
    } finally {
      await stopDsh(child, 10_000).catch(() => {});
    }
  },
);
