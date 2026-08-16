#!/usr/bin/env bash
# Verifies the `cardo setup` CLI flow end-to-end inside a clean container:
#   1. The pristine source tree (no .git, no node_modules) installs with
#      `pnpm install --frozen-lockfile` — the exact command the CLI runs.
#   2. The workspace builds (`pnpm run build`).
#   3. The runtime dependencies the packaged Electron shell resolves are
#      present at the paths main.ts actually uses.
#   4. The bundled skills ship to dist/skills.
set -euo pipefail

step() { printf '\n\033[1;36m==> %s\033[0m\n' "$1"; }
fail() { printf '\n\033[1;31mFAIL: %s\033[0m\n' "$1" >&2; exit 1; }
ok()   { printf '\033[1;32mok: %s\033[0m\n' "$1"; }

step "1/5 pnpm install --frozen-lockfile (no .git, no node_modules)"
# CI=true mirrors what the fixed cardo CLI now passes (the app's updater has
# no TTY); it also stops pnpm 11's confirmModulesPurge prompt from aborting.
CI=true pnpm install --frozen-lockfile > /tmp/install.log 2>&1 || {
  tail -30 /tmp/install.log
  fail "pnpm install failed — this is the exact command the cardo CLI runs on a user machine."
}
ok "install exited 0"

step "2/5 workspace build"
pnpm run build > /tmp/build.log 2>&1 || {
  tail -30 /tmp/build.log
  fail "pnpm run build failed"
}
ok "build exited 0"

step "3/5 dsh CLI resolvable at the path main.ts uses"
D=packages/cardo-desktop/node_modules/@deepseek-ai/dsh/lib/bin.js
if [ ! -f "$D" ]; then
  echo "--- candidate locations found ---"
  find . -path ./node_modules -prune -o -name bin.js -path '*dsh*' -print 2>/dev/null | head
  fail "dsh CLI missing at $D — the Electron shell (dshCliPath) cannot start."
fi
ok "dsh bin present: $D"

step "4/5 bundled skills copied to dist"
[ -d packages/cardo-skills/dist/skills ] || fail "dist/skills missing"
count=$(ls packages/cardo-skills/dist/skills | wc -l | tr -d ' ')
[ "$count" -ge 6 ] || fail "expected >=6 bundled skills, got $count"
ok "dist/skills has $count skills"

step "5/5 desktop package typechecks (what electron-builder consumes)"
pnpm --filter @cardo/cardo-desktop run build > /tmp/desktop-build.log 2>&1 || {
  tail -20 /tmp/desktop-build.log
  fail "cardo-desktop build failed"
}
ok "desktop build exited 0"

printf '\n\033[1;32mALL CLI-FLOW CHECKS PASSED\033[0m\n'
