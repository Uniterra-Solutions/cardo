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
 *  - PLAN: installPlan — update = update-cli → build-install-app →
 *    launch-app; setup never runs update-cli; dry-run runs nothing;
 *    launch-app present iff open and last.
 *  - VER: readVersion returns the first `"version": "..."` line or throws.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fc from 'fast-check';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PREBUILT_MARKER,
  builderArgs,
  cmdQuote,
  commandErrorMessage,
  embedResourcesDir,
  embedStrategy,
  findBuiltApp,
  findSourceRoot,
  hasPrebuiltSource,
  installDestination,
  installPlan,
  launchTarget,
  parseArgs,
  pnpmInvocation,
  pnpmVersionFromPackageJson,
  psSingleQuote,
  readVersion,
  sourceArchiveUrl,
  sourceAssetName,
  sourceDownloadUrl,
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
// PLAN — installPlan (`cardo setup` vs the one-command `cardo update`)
// ---------------------------------------------------------------------------

const planCommandArb = fc.constantFrom('setup', 'update');

test('installPlan: update = CLI refresh + app rebuild + relaunch; setup never touches the CLI', () => {
  fc.assert(
    fc.property(planCommandArb, fc.boolean(), fc.boolean(), (command, open, dryRun) => {
      const plan = installPlan(command, open, dryRun);
      if (dryRun) {
        assert.deepEqual(plan, [], 'dry-run executes nothing');
        return;
      }
      const cliIndex = plan.indexOf('update-cli');
      if (command === 'update') {
        assert.equal(cliIndex, 0, 'update refreshes the CLI first (fail fast)');
      } else {
        assert.equal(cliIndex, -1, 'setup never touches the CLI');
      }
      assert.equal(
        plan.filter((stage) => stage === 'build-install-app').length,
        1,
        'exactly one app build/install',
      );
      assert.ok(plan.indexOf('build-install-app') > cliIndex, 'app build follows the CLI refresh');
      const launchIndex = plan.indexOf('launch-app');
      if (open) {
        assert.equal(launchIndex, plan.length - 1, 'relaunch is the last stage');
      } else {
        assert.equal(launchIndex, -1, '--no-open skips the relaunch');
      }
      const expected: readonly string[] = [
        ...(command === 'update' ? ['update-cli'] : []),
        'build-install-app',
        ...(open ? ['launch-app'] : []),
      ];
      assert.deepEqual(plan, expected, 'plan matches the documented stage order');
    }),
  );
});

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

// ---------------------------------------------------------------------------
// ASSET — prebuilt source asset selection (the CLI downloads it when the
// release carries one; otherwise it falls back to the auto-generated archive)
// ---------------------------------------------------------------------------

const tagPartsArb = fc.array(
  fc.constantFrom('v', '0', '1', '9', '.', '-', 'beta', 'rc', '_', 'a', 'b'),
  {
    minLength: 1,
    maxLength: 12,
  },
);
const assetUrlArb = fc.constantFrom(
  'https://cdn.example.com/cardo/x.tar.gz',
  'https://dl.example.org/a/b/c.tar.gz',
  'https://github.example/cardo-assets/1.tar.gz',
);

test('sourceAssetName: names the prebuilt asset for the tag', () => {
  fc.assert(
    fc.property(tagPartsArb, (parts) => {
      const tag = parts.join('');
      const name = sourceAssetName(tag);
      assert.ok(name.startsWith('cardo-src-'), 'asset prefix');
      assert.ok(name.endsWith('.tar.gz'), 'tarball suffix');
      assert.ok(name.includes(tag), 'the tag is carried in the name');
    }),
  );
});

test('sourceDownloadUrl: the matching asset wins at any position; otherwise the auto-archive fallback', () => {
  fc.assert(
    fc.property(
      tagPartsArb,
      fc.array(fc.tuple(assetUrlArb, assetUrlArb), { maxLength: 4 }),
      (parts, pairs) => {
        const tag = parts.join('');
        const matchUrl = 'https://releases.example.com/match.tar.gz';
        const others = pairs.map(([name, url]) => ({ name, browser_download_url: url }));
        assert.equal(
          sourceDownloadUrl(tag, others),
          sourceArchiveUrl(tag),
          'no matching asset → GitHub auto-archive fallback (old releases)',
        );
        for (let i = 0; i <= others.length; i += 1) {
          const withMatch = [
            ...others.slice(0, i),
            { name: sourceAssetName(tag), browser_download_url: matchUrl },
            ...others.slice(i),
          ];
          assert.equal(
            sourceDownloadUrl(tag, withMatch),
            matchUrl,
            `the matching asset wins at position ${i}`,
          );
        }
      },
    ),
  );
});

// ---------------------------------------------------------------------------
// PREBUILT — the marker alone decides whether `cardo setup` skips the build
// ---------------------------------------------------------------------------

test('hasPrebuiltSource: exactly the marker file decides the build skip', async () => {
  const entryArb = fc.constantFrom(
    PREBUILT_MARKER,
    'package.json',
    'pnpm-lock.yaml',
    'packages',
    'node_modules',
    '.git',
    'dist',
    'README.md',
  );
  await fc.assert(
    fc.asyncProperty(fc.array(entryArb, { maxLength: 6 }), async (entries) => {
      const dir = await mkdtemp(join(tmpdir(), 'cardo-marker-'));
      try {
        for (const entry of new Set(entries)) {
          await writeFile(join(dir, entry), 'x');
        }
        assert.equal(
          await hasPrebuiltSource(dir),
          entries.includes(PREBUILT_MARKER),
          'skip iff the marker is present — nothing else may decide',
        );
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }),
  );
});

test('hasPrebuiltSource: a missing root reports no marker (the caller builds)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cardo-marker-'));
  const missing = join(dir, 'does-not-exist');
  await rm(dir, { recursive: true, force: true });
  assert.equal(await hasPrebuiltSource(missing), false);
});

// ---------------------------------------------------------------------------
// EMBED — only a DOWNLOADED Windows source may be renamed into the app;
// a --source checkout must never be moved away from the user's tree
// ---------------------------------------------------------------------------

test('embedStrategy: only a downloaded Windows source moves; every other case copies', () => {
  fc.assert(
    fc.property(fc.constantFrom('macos', 'windows'), fc.boolean(), (platform, downloaded) => {
      const strategy = embedStrategy(platform, downloaded);
      if (platform === 'windows' && downloaded) {
        assert.equal(strategy, 'move', 'downloaded Windows source uses the rename fast path');
      } else {
        assert.equal(strategy, 'copy', '--source checkouts and macOS never move the source');
      }
    }),
  );
});

// ---------------------------------------------------------------------------
// ERROR — a failed subprocess must never swallow its captured output
// ---------------------------------------------------------------------------

test('commandErrorMessage: keeps the command line and surfaces the exit code + output', () => {
  fc.assert(
    fc.property(
      fc.string(),
      fc.oneof(fc.integer(), fc.string(), fc.constant(undefined)),
      fc.string(),
      fc.string(),
      (message, code, stderr, stdout) => {
        const err = commandErrorMessage(message, code, stderr, stdout);
        assert.ok(err.startsWith(message), 'the command line is always kept');
        if (typeof code === 'number') {
          assert.ok(
            err.includes(`(exit code ${code})`),
            'numeric code becomes an exit-code suffix',
          );
        }
        const output = [stderr.trim(), stdout.trim()].filter((part) => part.length > 0).join('\n');
        if (output.length > 0) {
          assert.ok(err.endsWith(output), 'captured output is appended verbatim');
        }
      },
    ),
  );
});

// ---------------------------------------------------------------------------
// PNPM — self-provision when the pinned package manager is absent
// ---------------------------------------------------------------------------

const pinnedVersionArb = fc
  .array(fc.constantFrom('0', '1', '9', '.', '-', 'a', 'b', 'rc'), {
    minLength: 1,
    maxLength: 8,
  })
  .map((parts) => parts.join(''));

test('pnpmVersionFromPackageJson: reads the packageManager pin or returns undefined', () => {
  fc.assert(
    fc.property(fc.boolean(), pinnedVersionArb, (present, version) => {
      const json = present
        ? `{"name":"x","version":"1.0.0","packageManager":"pnpm@${version}"}`
        : `{"name":"x","version":"1.0.0"}`;
      assert.equal(pnpmVersionFromPackageJson(json), present ? version : undefined);
    }),
  );
});

test('pnpmInvocation: pnpm on PATH is used as-is; otherwise npx fetches the pin; unknown pin throws', () => {
  const versionArb = fc.option(pinnedVersionArb).map((v) => v ?? undefined);
  fc.assert(
    fc.property(fc.boolean(), versionArb, (onPath, version) => {
      if (onPath) {
        assert.deepEqual(pnpmInvocation(true, version), { file: 'pnpm', args: [] });
      } else if (version !== undefined) {
        assert.deepEqual(pnpmInvocation(false, version), {
          file: 'npx',
          args: ['--yes', `pnpm@${version}`],
        });
      } else {
        assert.throws(() => pnpmInvocation(false, version), /cannot self-provision pnpm/);
      }
    }),
  );
});
