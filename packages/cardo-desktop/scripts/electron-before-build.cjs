/**
 * electron-builder beforeBuild hook.
 *
 * Returning false tells electron-builder that node_modules handling is done
 * externally: the dsh runtime is pre-built into resources/dsh-runtime by
 * scripts/prepare-runtime.mjs and the app's own runtime deps are none (the
 * main process only imports @cardo/cardo-updater, resolved from its dist).
 * This prevents electron-builder from running `pnpm install --production`
 * in the workspace, which would trip the root husky prepare.
 */
module.exports = async function beforeBuild() {
  return false;
};
