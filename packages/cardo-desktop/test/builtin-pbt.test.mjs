/**
 * PBT suite for the cardo desktop built-ins (compiled dist).
 *
 * Business invariants locked here:
 *  - EXTRACT: every built-in npm spec `<name>@<version>` contributes its
 *    package NAME to the expected bundles — including scoped names
 *    (`@scope/name@1.0.0` → `@scope/name`).
 *  - SET: hasAllBuiltins is true iff the profile bundle list carries every
 *    expected bundle (extras and order never matter); malformed manifests
 *    are "not provisioned", never an exception.
 *  - READY: awaitReadiness resolves with the first `http://127.0.0.1:<port>`
 *    seen, across arbitrary chunk boundaries, and rejects when the stream
 *    never carries one.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fc from 'fast-check';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import {
  BUILTIN_NPM_PLUGINS,
  BUILTIN_VENDOR_PLUGINS,
  BUILTIN_WORKSPACE_PLUGINS,
  builtinPackageName,
  expectedBuiltinBundles,
  hasAllBuiltins,
  vendoredPluginsStale,
} from '../dist/builtin.js';
import { awaitReadiness } from '../dist/dsh-process.js';

// ---------------------------------------------------------------------------
// EXTRACT — npm spec → package name
// ---------------------------------------------------------------------------

const npmSpecArb = fc.oneof(
  fc.constant('dshmarket@1.9.0'),
  fc.constant('dsh-notifier@0.6.2'),
  fc.constant('dsh-better-sidebar@0.12.2'),
  fc.constant('@dsh-external/dsh-client-ui-skin-maid-atelier@1.0.0'),
  fc.constant('@leetoners/dsh-ui-subagent-monitor@1.0.0'),
  fc.constant('dsh-thinking-effort@0.1.0'),
);

/** Independent model: the version split is on the LAST `@` (names may be scoped). */
function packageNameOf(spec) {
  const at = spec.lastIndexOf('@');
  return at <= 0 ? spec : spec.slice(0, at);
}

test('EXTRACT: a built-in npm spec always contributes its package name', () => {
  fc.assert(
    fc.property(npmSpecArb, (spec) => {
      const expected = expectedBuiltinBundles([spec], {});
      assert.ok(
        expected.includes(packageNameOf(spec)),
        `expected bundles from ${spec} should include its package name`,
      );
      assert.ok(expected.length >= 3, 'official bundles always present');
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
  '@leetoners/dsh-ui-subagent-monitor',
  'dsh-thinking-effort',
  '@cardo/cardo-provider',
  'user-installed-plugin',
  'totally-unrelated',
);

/** Independent expected set computed from the real constants. */
function modelExpected() {
  return [
    '@deepseek-ai/dsh-base',
    '@deepseek-ai/dsh-web-app',
    ...BUILTIN_NPM_PLUGINS.map((spec) => spec.slice(0, spec.lastIndexOf('@'))),
    ...Object.values(BUILTIN_VENDOR_PLUGINS),
    ...Object.values(BUILTIN_WORKSPACE_PLUGINS),
  ];
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
      const dir = await mkdtemp(join(tmpdir(), 'cardo-set-'));
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
      const dir = await mkdtemp(join(tmpdir(), 'cardo-set-'));
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
  const dir = await mkdtemp(join(tmpdir(), 'cardo-set-'));
  try {
    assert.equal(hasAllBuiltins(dir), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// VENDOR — vendored built-ins must be self-contained, and a stale copy of a
//          previously-provisioned distribution must force re-provision
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

test('VENDOR: every built-in vendored plugin contributes its Loader row via a self-contained insert patch', async () => {
  const entries = Object.entries(BUILTIN_VENDOR_PLUGINS);
  assert.ok(entries.length >= 3, 'all three vendored built-ins remain shipped');
  for (const [dirName] of entries) {
    const text = await readFile(join(vendorPluginsRoot, dirName, 'cordis.patch.yml'), 'utf8');
    assert.ok(
      isSelfContainedPatch(text),
      `${dirName}/cordis.patch.yml must be a self-contained root insert`,
    );
  }
});

test('VENDOR regression: the skin ships the standalone dsh-deep-whale distribution, not the retired builtin-row one', () => {
  assert.equal(
    BUILTIN_VENDOR_PLUGINS['dsh-deep-whale'],
    '@dsh-external/dsh-client-ui-skin-maid-atelier',
  );
  assert.ok(
    !('deep-whale-day-night-theme' in BUILTIN_VENDOR_PLUGINS),
    'the retired deep-whale-day-night-theme source must be gone',
  );
  assert.ok(
    expectedBuiltinBundles(BUILTIN_NPM_PLUGINS, BUILTIN_VENDOR_PLUGINS).includes(
      '@dsh-external/dsh-client-ui-skin-maid-atelier',
    ),
    'the skin package name stays an expected bundle',
  );
});

/** Write one vendored built-in's source package.json under a vendor root. */
async function writeVendorSource(vendorRootDir, dirName, version) {
  const dest = join(vendorRootDir, dirName);
  await mkdir(dest, { recursive: true });
  await writeFile(join(dest, 'package.json'), `${JSON.stringify({ name: dirName, version })}\n`);
}

/** Write one vendored built-in's installed copy into a profile's node_modules. */
async function writeInstalledVendor(profileDir, pkgName, version) {
  const dest = join(profileDir, 'node_modules', ...pkgName.split('/'));
  await mkdir(dest, { recursive: true });
  await writeFile(join(dest, 'package.json'), `${JSON.stringify({ name: pkgName, version })}\n`);
}

/** Build a profile + vendor fixture where every vendored built-in is present,
 * optionally drifting exactly one of them. Returns the profile dir. */
async function staleFixture({ driftDir }) {
  const dir = await mkdtemp(join(tmpdir(), 'cardo-vendor-'));
  const vendor = join(dir, 'vendor');
  const profile = join(dir, 'profiles', 'web');
  await mkdir(profile, { recursive: true });
  await writeProfileManifest(dir, []);
  for (const [dirName, pkgName] of Object.entries(BUILTIN_VENDOR_PLUGINS)) {
    await writeVendorSource(vendor, dirName, '1.0.0');
    const version = dirName === driftDir ? '1.0.1' : '1.0.0';
    await writeInstalledVendor(profile, pkgName, version);
  }
  return { dir, vendor, profile };
}

test('STALE: a vendored copy matching the source is fresh; a single drift is stale', async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.constantFrom(...Object.keys(BUILTIN_VENDOR_PLUGINS), null),
      async (driftDir) => {
        const { dir, vendor, profile } = await staleFixture({ driftDir });
        try {
          assert.equal(vendoredPluginsStale(profile, vendor), driftDir !== null);
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      },
    ),
  );
});

test('STALE: a missing or illegible installed copy is stale (forces re-provision)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cardo-vendor-'));
  try {
    const vendor = join(dir, 'vendor');
    const profile = join(dir, 'profiles', 'web');
    await mkdir(profile, { recursive: true });
    await writeProfileManifest(dir, []);
    for (const [dirName] of Object.entries(BUILTIN_VENDOR_PLUGINS)) {
      await writeVendorSource(vendor, dirName, '1.0.0');
    }
    // No installed copies at all → stale.
    assert.equal(vendoredPluginsStale(profile, vendor), true);
    // One illegible installed package.json → stale.
    const skin = join(profile, 'node_modules', '@dsh-external', 'dsh-client-ui-skin-maid-atelier');
    await mkdir(skin, { recursive: true });
    await writeFile(join(skin, 'package.json'), 'not json at all');
    assert.equal(vendoredPluginsStale(profile, vendor), true);
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
    fc.constantFrom('booting', ' ', '\n', 'log', 'line', '...', 'http', '://', 'localhost', 'https'),
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
