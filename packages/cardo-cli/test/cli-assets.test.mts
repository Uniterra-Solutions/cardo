/**
 * Platform-aware release-asset selection tests (compiled dist).
 *
 * The CLI selects the desktop build asset by platform/arch:
 * - macOS: `<name>-<version>-<arch>-mac.zip` (electron-builder output)
 * - Windows: `<name>-<version>-<arch>-win.zip` (planned)
 * A wrong suffix is what broke `cardo update` on v0.5.0: the release shipped
 * `Cardo-0.5.0-arm64-mac.zip` but the CLI looked for `-arm64.zip`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { assetSuffixFor, findZipAsset } from '../dist/cli.js';

test('assetSuffixFor: macOS matches electron-builder output', () => {
  assert.equal(assetSuffixFor('darwin', 'arm64'), '-arm64-mac.zip');
  assert.equal(assetSuffixFor('darwin', 'x64'), '-x64-mac.zip');
});

test('assetSuffixFor: windows uses the -win.zip convention', () => {
  assert.equal(assetSuffixFor('win32', 'x64'), '-x64-win.zip');
});

test('assetSuffixFor: unsupported platforms fail loud', () => {
  assert.throws(() => assetSuffixFor('linux', 'x64'), /does not yet support linux/);
});

test('findZipAsset: selects the -arch-mac.zip asset for macOS arm64', () => {
  const release = {
    tag_name: 'v0.5.0',
    assets: [
      { name: 'Cardo-0.5.0-arm64-mac.zip', browser_download_url: 'https://example/arm64' },
      { name: 'Cardo-0.5.0-x64-mac.zip', browser_download_url: 'https://example/x64' },
    ],
  };
  const asset = findZipAsset(release, 'arm64', 'darwin');
  assert.equal(asset.name, 'Cardo-0.5.0-arm64-mac.zip');
  assert.equal(asset.browser_download_url, 'https://example/arm64');
});

test('findZipAsset: selects the -arch-win.zip asset for Windows x64', () => {
  const release = {
    tag_name: 'v0.5.0',
    assets: [
      { name: 'Cardo-0.5.0-x64-win.zip', browser_download_url: 'https://example/win' },
      { name: 'Cardo-0.5.0-arm64-mac.zip', browser_download_url: 'https://example/mac' },
    ],
  };
  const asset = findZipAsset(release, 'x64', 'win32');
  assert.equal(asset.name, 'Cardo-0.5.0-x64-win.zip');
});

test('findZipAsset: lists available assets when the suffix is missing', () => {
  const release = {
    tag_name: 'v0.5.0',
    assets: [{ name: 'Cardo-0.5.0-arm64-mac.zip', browser_download_url: 'https://example/arm64' }],
  };
  assert.throws(
    () => findZipAsset(release, 'x64', 'darwin'),
    (error: unknown) =>
      error instanceof Error &&
      error.message.includes('No -x64-mac.zip asset') &&
      error.message.includes('Cardo-0.5.0-arm64-mac.zip'),
  );
});
