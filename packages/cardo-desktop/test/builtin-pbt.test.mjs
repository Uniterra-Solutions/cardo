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
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import {
  BUILTIN_NPM_PLUGINS,
  BUILTIN_VENDOR_PLUGINS,
  builtinPackageName,
  expectedBuiltinBundles,
  hasAllBuiltins,
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
