// Implementation lives in shared main infrastructure so the OpenCode bridge
// command client and legacy CLI probes can reuse the same Windows node_modules
// junction recovery without a main -> feature dependency.
export {
  ensureOpenCodeProfileNodeModulesJunction,
  extractProfileIdFromSymlinkError,
  extractSymlinkSourcePath,
  extractSymlinkTargetPath,
  getProfileNodeModulesPath,
  getSharedCacheNodeModulesPath,
  isOpenCodeNodeModulesSymlinkError,
} from '@main/utils/openCodeNodeModulesJunction';
