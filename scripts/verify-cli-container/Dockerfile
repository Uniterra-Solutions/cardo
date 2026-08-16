# Cardo CLI flow container verification
#
# Reproduces, on a clean Linux machine, exactly what `cardo setup` does on a
# user's Mac: take a pristine source tree (no .git, no node_modules — the
# GitHub auto-generated source archive), `pnpm install --frozen-lockfile`,
# `pnpm run build`, and assert the packaged app's runtime dependencies are
# resolvable from the paths the Electron shell actually uses.
#
# Node 22 + Debian (not Alpine): dsh pins Node >= 22, and native builds
# (node-pty, sharp) need glibc + build toolchain. The user's Mac does not run
# the electron-builder --mac step in this container (macOS-only); this image
# verifies everything up to and including the workspace build.
FROM node:22-bookworm-slim

# pnpm version must match the root packageManager pin (pnpm 11).
RUN npm install -g pnpm@11.17.0

# fast-check for the Docker PBT suite (node:test + property-based testing).
# Installed outside the workspace so it never touches repo lockfiles; the
# suite is copied next to it below so `import 'fast-check'` resolves.
RUN mkdir -p /opt/pbt && cd /opt/pbt && npm init -y >/dev/null 2>&1 && \
    npm install --no-audit --no-fund fast-check@^4.9.0

# Native build toolchain for node-pty/sharp/esbuild postinstall scripts.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /src

# The full workspace (source only — node_modules/.git/dist are excluded via
# .dockerignore). This mirrors the extracted GitHub source archive.
COPY . .

# The verification script itself.
COPY scripts/verify-cli-container/verify.sh /verify.sh
RUN chmod +x /verify.sh

# The Docker PBT suite (node:test + fast-check), run from /opt/pbt so its
# fast-check install resolves.
COPY scripts/verify-cli-container/pbt /opt/pbt/pbt

CMD ["/verify.sh"]
