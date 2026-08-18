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
 *  - VENDOR_ENTRY: every vendored built-in's package name matches its registry
 *    row and ships a resolvable entry.
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
  builtinPackageName,
  copyBuiltins,
  copyBuiltinsStale,
  expectedBuiltinBundles,
  hasAllBuiltins,
  npmBuiltinSpecs,
  ensureBuiltinPlugins,
} = await import(`${DESKTOP_DIST}/builtin.js`);
const { awaitReadiness, stopDsh } = await import(`${DESKTOP_DIST}/dsh-process.js`);

const NPM_SPECS = npmBuiltinSpecs();
const VENDOR = copyBuiltins('vendor');
const WORKSPACE = copyBuiltins('workspace');

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

// ---------------------------------------------------------------------------
// SOURCE_ENTRY — the v0.6.0 regression
// ---------------------------------------------------------------------------

const workspaceDirArb = fc.constantFrom(...WORKSPACE.map((entry) => entry.dir));

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
    fc.property(fc.constantFrom(...VENDOR), ({ dir, package: pkgName }) => {
      const pkgDir = join(sourceRoot(), 'vendor', 'dsh-plugins', dir);
      const pkg = readJson(join(pkgDir, 'package.json'));
      assert.equal(pkg.name, pkgName, `vendor dir ${dir} package name`);
      const entryRel = pkg.main ?? 'index.js';
      assert.ok(
        existsSync(join(pkgDir, entryRel)),
        `vendored entry ${dir}/${entryRel} missing`,
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
  ...NPM_SPECS.map(builtinPackageName),
  ...VENDOR.map((entry) => entry.package),
  ...WORKSPACE.map((entry) => entry.package),
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
        const expected = expectedBuiltinBundles();
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
// STALE_DETECTION — installed-copy drift (unified, kind-aware)
// ---------------------------------------------------------------------------

const damageArb = fc.constantFrom('missing', 'version-bump', 'version-match');

/** Every copy-based built-in with its source root discriminator. */
function copyEntries() {
  return [
    ...VENDOR.map((entry) => ({ kind: 'vendor', ...entry })),
    ...WORKSPACE.map((entry) => ({ kind: 'workspace', ...entry })),
  ];
}

function installedCopyDir(profileDir, pkgName) {
  return join(profileDir, 'node_modules', ...pkgName.split('/'));
}

test('STALE_DETECTION: a missing or version-mismatched copy of any built-in is stale; a matching copy is not', () => {
  fc.assert(
    fc.property(fc.constantFrom(...copyEntries()), damageArb, (target, damage) => {
      const root = sourceRoot();
      const profileDir = join(mkdtempSync(join(tmpdir(), 'uniterra-stale-')), 'profiles', 'web');
      mkdirSync(profileDir, { recursive: true });
      try {
        // Baseline: EVERY copy built-in gets a version-matching installed copy.
        // The unified staleness check scans all of them (any drift ⇒ stale), so
        // only the damaged target may differ from the source versions.
        for (const entry of copyEntries()) {
          const sourcePkg =
            entry.kind === 'vendor'
              ? readJson(join(root, 'vendor', 'dsh-plugins', entry.dir, 'package.json'))
              : readJson(join(root, entry.dir, 'package.json'));
          if (entry.kind === target.kind && entry.dir === target.dir && damage === 'missing') {
            continue; // the damaged target's installed copy stays absent
          }
          const dest = installedCopyDir(profileDir, entry.package);
          mkdirSync(dest, { recursive: true });
          const version =
            entry.kind === target.kind && entry.dir === target.dir && damage === 'version-bump'
              ? '999.0.0'
              : sourcePkg.version;
          writeFileSync(
            join(dest, 'package.json'),
            `${JSON.stringify({ name: entry.package, version })}\n`,
          );
        }
        const stale = copyBuiltinsStale(
          profileDir,
          join(root, 'vendor', 'dsh-plugins'),
          root,
        );
        rmSync(join(profileDir, '..', '..'), { recursive: true, force: true });
    }),
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
