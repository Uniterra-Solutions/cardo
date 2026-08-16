/**
 * PBT suite for the cardo CLI install logic (compiled dist).
 *
 * Business invariants locked here:
 *  - PARSE: parseArgs is a pure flag/command decoder — flags commute, the
 *    command is the first positional, `--version`/`-v` anywhere wins, unknown
 *    commands throw.
 *  - URL: sourceArchiveUrl always points at the GitHub auto-generated source
 *    tarball for the given tag and the tag round-trips through encoding.
 *  - ROOT: findSourceRoot accepts exactly one `cardo-*` directory.
 *  - APP: findBuiltApp finds the electron-builder .app when one exists and
 *    throws otherwise (order-independent).
 *  - VER: readVersion returns the first `"version": "..."` line or throws.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fc from 'fast-check';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findBuiltApp, findSourceRoot, parseArgs, readVersion, sourceArchiveUrl } from '../dist/install-logic.js';

// ---------------------------------------------------------------------------
// PARSE — parseArgs
// ---------------------------------------------------------------------------

const flagArb = fc.constantFrom('--no-open', '--dry-run');
const versionFlagArb = fc.constantFrom('--version', '-v');
const helpArb = fc.constantFrom('--help', '-h');
const commandArb = fc.constantFrom('setup', 'update');
/** Words that are never a command: they must make the model throw. */
const junkArb = fc.constantFrom('--frobnicate', 'foo', 'Setup', 'SETUP', '', 'install');

function modelParse(args: readonly string[]): {
  command: 'setup' | 'update' | 'version' | 'help';
  open: boolean;
  dryRun: boolean;
} {
  const positional = args.filter((a) => a !== '--no-open' && a !== '--dry-run');
  const open = !args.includes('--no-open');
  const dryRun = args.includes('--dry-run');
  if (positional.some((a) => a === '--version' || a === '-v')) {
    return { command: 'version', open, dryRun };
  }
  const command = positional[0];
  if (command === undefined || command === '--help' || command === '-h') {
    return { command: 'help', open, dryRun };
  }
  if (command === 'setup' || command === 'update') {
    return { command, open, dryRun };
  }
  throw new Error(`Unknown command: ${command}`);
}

test('parseArgs matches the spec model over arbitrary flag/command mixes', () => {
  fc.assert(
    fc.property(
      fc.array(fc.oneof(flagArb, versionFlagArb, helpArb, commandArb, junkArb), { maxLength: 8 }),
      (args) => {
        let expected: ReturnType<typeof modelParse> | undefined;
        let expectedThrows = false;
        try {
          expected = modelParse(args);
        } catch {
          expectedThrows = true;
        }
        if (expectedThrows) {
          assert.throws(() => parseArgs(args), /Unknown command/);
        } else {
          assert.deepEqual(parseArgs(args), expected);
        }
      },
    ),
  );
});

// The command is the FIRST positional — order of positionals is by design,
// so the only order-independence that holds is for FLAGS, which the spec
// model above already covers. No separate permutation property.

// ---------------------------------------------------------------------------
// URL — sourceArchiveUrl
// ---------------------------------------------------------------------------

test('sourceArchiveUrl: tag round-trips through the archive URL', () => {
  fc.assert(
    fc.property(
      fc.array(fc.constantFrom('v', '0', '1', '9', '.', '-', 'beta', 'rc', '_', 'a', 'b'), {
        minLength: 1,
        maxLength: 12,
      }),
      (parts) => {
        const tag = parts.join('');
        const url = sourceArchiveUrl(tag);
        assert.ok(url.startsWith('https://github.com/'), 'github origin');
        assert.ok(url.includes('/archive/refs/tags/'), 'source-archive path');
        assert.ok(url.endsWith('.tar.gz'), 'tarball suffix');
        const rest = url.split('/archive/refs/tags/')[1] as string;
        const decoded = decodeURIComponent(rest.replace(/\.tar\.gz$/, ''));
        assert.equal(decoded, tag, 'tag survives encode/decode');
      },
    ),
  );
});

// ---------------------------------------------------------------------------
// ROOT — findSourceRoot
// ---------------------------------------------------------------------------

test('findSourceRoot: exactly one cardo-* dir is accepted; otherwise it throws', async () => {
  const nameArb = fc.oneof(
    fc.constantFrom('cardo-v0.5.0', 'cardo-main', 'cardo-v1.0.0-beta.1'),
    fc.constantFrom('README.md', 'other-repo', 'cardo-dist', 'nested/cardo-x'),
  );
  await fc.assert(
    fc.asyncProperty(
      fc.array(nameArb, { maxLength: 6 }).map((names) => [...new Set(names)]),
      async (names) => {
      const dir = await mkdtemp(join(tmpdir(), 'cardo-root-'));
      try {
        const dirs = names.filter((n) => !n.includes('/') && n.startsWith('cardo-'));
        const files = names.filter((n) => !n.startsWith('cardo-') && !n.includes('/'));
        for (const f of files) {
          await writeFile(join(dir, f), 'x');
        }
        for (const d of dirs) {
          await mkdir(join(dir, d));
        }
        const expected =
          dirs.length === 1 ? join(dir, dirs[0] as string) : new Error('Unexpected source archive layout');
        if (expected instanceof Error) {
          await assert.rejects(() => findSourceRoot(dir), /Unexpected source archive layout/);
        } else {
          assert.equal(await findSourceRoot(dir), expected);
        }
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }),
  );
});

// ---------------------------------------------------------------------------
// APP — findBuiltApp
// ---------------------------------------------------------------------------

test('findBuiltApp: finds the .app when one exists, throws otherwise (order-independent)', async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(fc.constantFrom('mac-arm64', 'mac-x64', 'mac-universal'), { maxLength: 3 }),
      fc.array(fc.constantFrom('Cardo.app', 'other.app', 'builder.yml', 'yarn.lock'), {
        minLength: 1,
        maxLength: 5,
      }),
      fc.boolean(),
      async (macDirs, entries, placeApp) => {
        const src = await mkdtemp(join(tmpdir(), 'cardo-app-'));
        try {
          const desktopDist = join(src, 'packages', 'cardo-desktop', 'dist');
          const appName = 'Cardo.app';
          const appPath = join(desktopDist, macDirs[0] ?? 'mac-arm64', appName);
          for (const macDir of macDirs) {
            await mkdir(join(desktopDist, macDir), { recursive: true });
            for (const entry of entries) {
              if (entry.endsWith('.app')) {
                await mkdir(join(desktopDist, macDir, entry), { recursive: true });
              } else {
                await writeFile(join(desktopDist, macDir, entry), 'x');
              }
            }
          }
          if (placeApp && macDirs.length > 0) {
            await mkdir(appPath, { recursive: true });
          }
          const exists = macDirs.length > 0 && (placeApp || entries.some((e) => e.endsWith('.app')));
          if (exists) {
            const found = await findBuiltApp(src);
            assert.ok(found.endsWith('.app'), 'returns a .app path');
            assert.ok(found.startsWith(desktopDist), 'inside electron-builder dist');
            await assert.doesNotReject(
              (await import('node:fs/promises')).access(found),
              'the returned .app exists on disk',
            );
          } else {
            await assert.rejects(() => findBuiltApp(src), /No \.app bundle found/);
          }
        } finally {
          await rm(src, { recursive: true, force: true });
        }
      },
    ),
  );
});

// ---------------------------------------------------------------------------
// VER — readVersion
// ---------------------------------------------------------------------------

const linePrefixArb = fc.array(fc.constantFrom('', '  ', '{', '}', '  "name": "x",', '"dependencies": {', '"bin": {'), {
  maxLength: 4,
});

test('readVersion: returns the version of the first matching line', async () => {
  const versionValueArb = fc.constantFrom('0.5.2', '1.2.3', '0.0.1-beta.2', 'v9.9.9');
  await fc.assert(
    fc.asyncProperty(linePrefixArb, versionValueArb, async (prefixes, version) => {
      const dir = await mkdtemp(join(tmpdir(), 'cardo-ver-'));
      try {
        const body = `${prefixes.join('\n')}\n"version": "${version}"\n"other": "value"\n`;
        const pkg = join(dir, 'package.json');
        await writeFile(pkg, body);
        assert.equal(await readVersion(pkg), version);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }),
  );
});

test('readVersion: a file with no version line throws', async () => {
  await fc.assert(
    fc.asyncProperty(linePrefixArb, async (prefixes) => {
      const dir = await mkdtemp(join(tmpdir(), 'cardo-ver-'));
      try {
        const body = `${prefixes.join('\n')}\n"name": "x"\n`;
        const pkg = join(dir, 'package.json');
        await writeFile(pkg, body);
        await assert.rejects(() => readVersion(pkg), /Unable to read version/);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }),
  );
});

test('readVersion: the actual CLI package.json round-trips', async () => {
  const version = await readVersion();
  assert.match(version, /^\d+\.\d+\.\d+/);
});
