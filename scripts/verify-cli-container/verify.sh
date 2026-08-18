#!/usr/bin/env bash
# Verifies the uniterra CLI setup/update flow end-to-end inside a clean container:
#   1. The pristine source tree (no .git, no node_modules) installs with
#      `pnpm install --frozen-lockfile` — the exact command the CLI runs.
#   2. The workspace builds (`pnpm run build`).
#   3. `uniterra update --dry-run` reports the one-command full update plan
#      (CLI refresh + app rebuild + relaunch) without executing it.
#   4. The runtime dependencies the packaged Electron shell resolves are
#      present at the paths main.ts actually uses.
#   5. The bundled skills ship to dist/skills.
#   6. The release source asset carries the built artifacts + the prebuilt
#      marker (so `uniterra setup` skips the build on user machines).
set -euo pipefail

step() { printf '\n\033[1;36m==> %s\033[0m\n' "$1"; }
fail() { printf '\n\033[1;31mFAIL: %s\033[0m\n' "$1" >&2; exit 1; }
ok()   { printf '\033[1;32mok: %s\033[0m\n' "$1"; }

step "1/8 pnpm install --frozen-lockfile (no .git, no node_modules)"
# CI=true mirrors what the fixed uniterra CLI now passes (the app's updater has
# no TTY); it also stops pnpm 11's confirmModulesPurge prompt from aborting.
CI=true pnpm install --frozen-lockfile > /tmp/install.log 2>&1 || {
  tail -30 /tmp/install.log
  fail "pnpm install failed — this is the exact command the uniterra CLI runs on a user machine."
}
ok "install exited 0"

step "2/8 workspace build"
pnpm run build > /tmp/build.log 2>&1 || {
  tail -30 /tmp/build.log
  fail "pnpm run build failed"
}
ok "build exited 0"

step "3/8 uniterra update --dry-run (one-command update entry: plan report, no downloads)"
# The built CLI's update entry point: dry-run must report the full update
# (CLI refresh + app rebuild + relaunch) and exit 0 WITHOUT any network
# access — the exact command the desktop's Update Now spawns, minus the
# execution stages. Keeping it offline makes this gate deterministic.
UPDATE_DRY_OUT=/tmp/update-dry-run.log
node packages/uniterra-cli/dist/cli.js update --dry-run > "$UPDATE_DRY_OUT" 2>&1 || {
  tail -30 "$UPDATE_DRY_OUT"
  fail "uniterra update --dry-run failed"
}
grep -q "Would update the CLI, then rebuild + reinstall the desktop app and relaunch it" "$UPDATE_DRY_OUT" \
  || { cat "$UPDATE_DRY_OUT"; fail "uniterra update --dry-run did not report the full update plan"; }
ok "uniterra update --dry-run reported the full update plan (offline)"

step "4/8 dsh CLI resolvable at the path main.ts uses"
D=packages/uniterra-desktop/node_modules/@deepseek-ai/dsh/lib/bin.js
if [ ! -f "$D" ]; then
  echo "--- candidate locations found ---"
  find . -path ./node_modules -prune -o -name bin.js -path '*dsh*' -print 2>/dev/null | head
  fail "dsh CLI missing at $D — the Electron shell (dshCliPath) cannot start."
fi
ok "dsh bin present: $D"

step "5/8 bundled skills copied to dist"
[ -d packages/uniterra-skills/dist/skills ] || fail "dist/skills missing"
count=$(ls packages/uniterra-skills/dist/skills | wc -l | tr -d ' ')
[ "$count" -ge 6 ] || fail "expected >=6 bundled skills, got $count"
ok "dist/skills has $count skills"

step "6/8 desktop package typechecks (what electron-builder consumes)"
pnpm --filter @uniterra-solutions/uniterra-desktop run build > /tmp/desktop-build.log 2>&1 || {
  tail -20 /tmp/desktop-build.log
  fail "uniterra-desktop build failed"
}
ok "desktop build exited 0"

step "7/8 workspace built-in bundle produced by the build"
# The workspace built-in's host entry (packages/uniterra-provider/lib/index.js)
# is an esbuild artifact of the provider's own build, which the root build
# must run. Without it, the app copies a broken package into the dsh profile
# and boot dies with ERR_MODULE_NOT_FOUND (the v0.6.0 blank-app regression).
D=packages/uniterra-provider/lib/index.js
if [ ! -f "$D" ]; then
  echo "--- provider lib contents ---"
  ls packages/uniterra-provider/lib 2>/dev/null || echo "(no lib dir)"
  fail "provider bundle missing at $D — uniterra setup runs pnpm run build, which must produce it."
fi
ok "provider bundle present: $D"

step "8/8 Docker PBT suite (provisioning properties + real dsh boot)"
# UNITERRA_SOURCE_ROOT points the suite at the pristine source tree that was
# installed + built above (steps 1-2) — the exact tree uniterra setup embeds.
export UNITERRA_SOURCE_ROOT=/src
(cd /opt/pbt && node --test pbt/provisioning-pbt.test.mjs) > /tmp/pbt.log 2>&1 || {
  tail -80 /tmp/pbt.log
  fail "Docker PBT suite failed"
}
ok "Docker PBT passed (bundles/provisioning properties + dsh boot to readiness)"

step "9/9 release source asset ships the prebuilt build artifacts"
TAG="v0.0.0-verify"
scripts/make-source-asset.sh "$TAG" > /tmp/asset.log 2>&1 || {
  tail -20 /tmp/asset.log
  fail "make-source-asset.sh failed"
}
ASSET="uniterra-src-$TAG.tar.gz"
[ -f "$ASSET" ] || fail "asset $ASSET missing"
# The CLI must pick exactly this asset name — compute it from the compiled
# logic so the producer and the downloader can never drift apart.
ASSET_NAME="$(node --input-type=module -e \
  "import('./packages/uniterra-cli/dist/install-logic.js').then((m) => process.stdout.write(m.sourceAssetName('$TAG')))")"
[ "$ASSET" = "$ASSET_NAME" ] || fail "asset name $ASSET != CLI-expected $ASSET_NAME"
# Grep the listing from a FILE, not a pipe: `grep -q` exits on its first match
# and, under `set -o pipefail`, the SIGPIPE it sends the writer turns a
# successful match into a pipeline failure.
tar -tzf "$ASSET" > /tmp/asset-list.txt
for rel in \
  "uniterra-$TAG/.uniterra-prebuilt" \
  "uniterra-$TAG/packages/uniterra-desktop/dist/main.js" \
  "uniterra-$TAG/packages/uniterra-provider/lib/index.js"; do
  grep -qxF -- "$rel" /tmp/asset-list.txt || fail "asset missing $rel"
done
grep -qE "^uniterra-$TAG/packages/uniterra-skills/dist/skills/[^/]+/SKILL\.md$" /tmp/asset-list.txt \
  || fail "asset missing bundled skills"
if grep -qE '(^|/)node_modules/|(^|/)\.git/' /tmp/asset-list.txt; then
  fail "asset must not carry node_modules or .git"
fi
ok "asset $ASSET carries the marker + built artifacts (no node_modules/.git)"

printf '\n\033[1;32mALL CLI-FLOW CHECKS PASSED\033[0m\n'
