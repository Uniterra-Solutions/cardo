/**
 * electron-builder beforeBuild hook.
 *
 * Returning false tells electron-builder that node_modules handling is done
 * externally (the source tree the CLI extracted already has its node_modules
 * installed — reinstalling would trip the root husky prepare).
 *
 * The source tree is embedded as Resources/src by the cardo CLI AFTER
 * packaging (the .app is moved out of the tree first, then the source is
 * copied in — copying src into its own subdirectory is not allowed).
 */
module.exports = async function beforeBuild() {
  return false;
};
