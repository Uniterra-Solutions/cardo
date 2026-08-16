/**
 * Profile bootstrap unit tests (compiled dist).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  OFFICIAL_BUNDLES,
  PROFILE_PLUGINS,
  VENDOR_PLUGIN_DIRS,
  profileManifest,
  profilePnpmWorkspace,
} from '../dist/profile.js';

test('profile manifest stacks the official bundles', () => {
  const manifest = JSON.parse(profileManifest());
  const bundles = manifest.dsh.profile.bundles;
  for (const official of OFFICIAL_BUNDLES) {
    assert.ok(bundles.includes(official), `manifest includes ${official}`);
  }
});

test('profile manifest lists every npm and vendored plugin', () => {
  const manifest = JSON.parse(profileManifest());
  const bundles = manifest.dsh.profile.bundles;
  const pluginNames = PROFILE_PLUGINS.map((p) => p.split('@')[0]);
  for (const name of pluginNames) {
    assert.ok(bundles.includes(name), `manifest includes ${name}`);
  }
  for (const dir of VENDOR_PLUGIN_DIRS) {
    assert.ok(bundles.includes(dir), `manifest includes vendored ${dir}`);
  }
});

test('npm plugin specifiers are pinned with exact versions', () => {
  for (const spec of PROFILE_PLUGINS) {
    const [, version] = spec.split('@');
    assert.ok(version !== undefined && /^\d+\.\d+\.\d+$/.test(version), `${spec} is exact`);
  }
});

test('profile pnpm workspace allows native builds and disables release-age gate', () => {
  const ws = profilePnpmWorkspace();
  assert.ok(ws.includes('allowBuilds:'), 'has allowBuilds');
  assert.ok(ws.includes('node-pty: true'), 'allows node-pty');
  assert.ok(ws.includes('sharp: true'), 'allows sharp');
  assert.ok(ws.includes('minimumReleaseAge: 0'), 'disables release-age gate');
});
