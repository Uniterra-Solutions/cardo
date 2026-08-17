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
import {
  builderArgs,
  cmdQuote,
  embedResourcesDir,
  findBuiltApp,
  findSourceRoot,
  installDestination,
  launchTarget,
  parseArgs,
  psSingleQuote,
  readVersion,
  sourceArchiveUrl,
  startMenuShortcut,
} from '../dist/install-logic.js';

// ---------------------------------------------------------------------------
// PARSE — parseArgs
// ---------------------------------------------------------------------------

const flagArb = fc.constantFrom('--no-open', '--dry-run');
const versionFlagArb = fc.constantFrom('--version', '-v');
const helpArb = fc.constantFrom('--help', '-h');
const commandArb = fc.constantFrom('setup', 'update');
const sourceFlagArb = fc.constant('--source');
/** Words that are never a command: they must make the model throw. */
const junkArb = fc.constantFrom('--frobnicate', 'foo', 'Setup', 'SETUP', '', 'install');

function modelParse(args: readonly string[]): {
  command: 'setup' | 'update' | 'version' | 'help';
  open: boolean;
  dryRun: boolean;
  source?: string;
} {
  let open = true;
  let dryRun = false;
  let source: string | undefined;
  const positional: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--no-open') {
      open = false;
    } else if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--source') {
      // --source consumes the NEXT token as its path value.
      const value = args[i + 1];
      if (value === undefined) {
        throw new Error('--source requires a path argument');
      }
      source = value;
      i += 1;
    } else if (arg !== undefined) {
      positional.push(arg);
    }
  }
  if (positional.some((a) => a === '--version' || a === '-v')) {
    return { command: 'version', open, dryRun, source };
  }
  const command = positional[0];
  if (command === undefined || command === '--help' || command === '-h') {
    return { command: 'help', open, dryRun, source };
  }
  if (command === 'setup' || command === 'update') {
    return { command, open, dryRun, source };
  }
  throw new Error(`Unknown command: ${command} (run "cardo --help" for usage)`);
}

test('parseArgs matches the spec model over arbitrary flag/command mixes', () => {
  fc.assert(
    fc.property(
      fc.array(fc.oneof(flagArb, versionFlagArb, helpArb, commandArb, junkArb, sourceFlagArb), {
        maxLength: 8,
      }),
      (args) => {
        let expected: ReturnType<typeof modelParse> | undefined;
        let expectedMessage: string | undefined;
        try {
          expected = modelParse(args);
        } catch (error) {
          expectedMessage = error instanceof Error ? error.message : String(error);
        }
        if (expectedMessage !== undefined) {
          assert.throws(
            () => parseArgs(args),
            (error: unknown) => error instanceof Error && error.message === expectedMessage,
          );
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
            dirs.length === 1
              ? join(dir, dirs[0] as string)
              : new Error('Unexpected source archive layout');
          if (expected instanceof Error) {
            await assert.rejects(() => findSourceRoot(dir), /Unexpected source archive layout/);
          } else {
            assert.equal(await findSourceRoot(dir), expected);
          }
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      },
    ),
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
          const exists =
            macDirs.length > 0 && (placeApp || entries.some((e) => e.endsWith('.app')));
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

const linePrefixArb = fc.array(
  fc.constantFrom('', '  ', '{', '}', '  "name": "x",', '"dependencies": {', '"bin": {'),
  {
    maxLength: 4,
  },
);

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

// ---------------------------------------------------------------------------
// PLATFORM — Windows install branches
// ---------------------------------------------------------------------------

test('findBuiltApp (windows): finds win-unpacked with an .exe, throws otherwise', async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(fc.constantFrom('win-unpacked', 'win-x64', 'mac-arm64'), { maxLength: 3 }),
      fc.array(fc.constantFrom('Cardo.exe', 'Cardo-0.6.2.exe', 'builder.yml', 'update.exe.bak'), {
        minLength: 1,
        maxLength: 5,
      }),
      fc.boolean(),
      async (dirs, entries, placeExe) => {
        const src = await mkdtemp(join(tmpdir(), 'cardo-win-'));
        try {
          const desktopDist = join(src, 'packages', 'cardo-desktop', 'dist');
          const unpacked = join(desktopDist, 'win-unpacked');
          for (const dir of dirs) {
            await mkdir(join(desktopDist, dir), { recursive: true });
            for (const entry of entries) {
              await writeFile(join(desktopDist, dir, entry), 'x');
            }
          }
          if (placeExe && dirs.includes('win-unpacked')) {
            await writeFile(join(unpacked, 'Cardo.exe'), 'x');
          }
          const exists =
            dirs.includes('win-unpacked') && (placeExe || entries.some((e) => e.endsWith('.exe')));
          if (exists) {
            const found = await findBuiltApp(src, 'windows');
            assert.ok(found.endsWith(join('win-unpacked')), 'returns the win-unpacked dir');
            assert.ok(found.startsWith(desktopDist), 'inside electron-builder dist');
            await assert.doesNotReject(
              (await import('node:fs/promises')).access(found),
              'the returned dir exists on disk',
            );
          } else {
            await assert.rejects(() => findBuiltApp(src, 'windows'), /No Cardo\.exe found/);
          }
        } finally {
          await rm(src, { recursive: true, force: true });
        }
      },
    ),
  );
});

test('installDestination: macOS keeps the .app name under ~/Applications', () => {
  const dest = installDestination('macos', {}, join('/tmp', 'out', 'Cardo.app'));
  assert.ok(dest.endsWith(join('Applications', 'Cardo.app')));
});

test('installDestination: Windows installs under %LOCALAPPDATA%\\Programs\\Cardo', () => {
  const dest = installDestination(
    'windows',
    { LOCALAPPDATA: 'C:\\Users\\dev\\AppData\\Local' },
    '/ignored',
  );
  assert.ok(dest.startsWith('C:\\Users\\dev\\AppData\\Local'), 'LOCALAPPDATA honored');
  assert.ok(dest.endsWith(join('Programs', 'Cardo')));
});

test('installDestination: Windows falls back to homedir/AppData/Local without LOCALAPPDATA', () => {
  const dest = installDestination('windows', {}, '/ignored');
  assert.ok(dest.endsWith(join('AppData', 'Local', 'Programs', 'Cardo')));
});

test('launchTarget: the .app on macOS, Cardo.exe on Windows', () => {
  assert.equal(launchTarget('macos', join('/tmp', 'Cardo.app')), join('/tmp', 'Cardo.app'));
  assert.equal(
    launchTarget('windows', 'C:\\Programs\\Cardo'),
    join('C:\\Programs\\Cardo', 'Cardo.exe'),
  );
});

test('embedResourcesDir: Contents/Resources on macOS, resources on Windows', () => {
  assert.equal(
    embedResourcesDir('macos', '/tmp/app'),
    join('/tmp', 'app', 'Contents', 'Resources'),
  );
  assert.equal(embedResourcesDir('windows', 'C:\\app'), join('C:\\app', 'resources'));
});

test('builderArgs: --mac on macOS, --win --dir on Windows, version stamped', () => {
  assert.deepEqual(builderArgs('macos', '0.6.2'), [
    '--mac',
    '--publish',
    'never',
    '-c.extraMetadata.version=0.6.2',
  ]);
  assert.deepEqual(builderArgs('windows', '0.6.2'), [
    '--win',
    '--dir',
    '--publish',
    'never',
    '-c.extraMetadata.version=0.6.2',
  ]);
});

test(
  'psSingleQuote: every single quote doubles (PowerShell ' +
    "''" +
    ' escape), nothing else changes',
  () => {
    fc.assert(
      fc.property(fc.string(), (value) => {
        assert.equal(psSingleQuote(value), value.replace(/'/g, "''"));
      }),
    );
  },
);

test('cmdQuote: tokens containing whitespace are double-quoted; others are unchanged', () => {
  fc.assert(
    fc.property(fc.string(), (value) => {
      const quoted = cmdQuote(value);
      if (/\s/.test(value)) {
        assert.equal(quoted, `"${value}"`, 'whitespace tokens are wrapped');
      } else {
        assert.equal(quoted, value, 'tokens without whitespace are untouched');
      }
    }),
  );
});

test('startMenuShortcut: Start Menu path, APPDATA fallback, and script shape', () => {
  const exe = join('C:\\Users\\dev\\AppData\\Local\\Programs\\Cardo', 'Cardo.exe');
  const spec = startMenuShortcut(exe, { APPDATA: 'C:\\Users\\dev\\AppData\\Roaming' });
  assert.ok(spec.lnkPath.startsWith('C:\\Users\\dev\\AppData\\Roaming'), 'APPDATA honored');
  assert.ok(
    spec.lnkPath.endsWith(join('Microsoft', 'Windows', 'Start Menu', 'Programs', 'Cardo.lnk')),
  );
  assert.ok(spec.script.includes("CreateShortcut('"), 'creates the shortcut');
  assert.ok(spec.script.includes(`TargetPath='${psSingleQuote(exe)}'`), 'targets the exe');
  assert.ok(spec.script.includes('WorkingDirectory='), 'sets the working dir');
  assert.ok(spec.script.endsWith('$s.Save()'), 'saves the shortcut');
});

test('startMenuShortcut: exe paths with quotes survive the PS script', () => {
  fc.assert(
    fc.property(fc.array(fc.string({ minLength: 1 }), { minLength: 1, maxLength: 4 }), (parts) => {
      const exePath = join(...parts, 'Cardo.exe');
      const spec = startMenuShortcut(exePath, {});
      assert.ok(spec.script.includes(`TargetPath='${psSingleQuote(exePath)}'`));
    }),
  );
});
