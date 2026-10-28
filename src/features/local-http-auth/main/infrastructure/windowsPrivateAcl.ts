// Compatibility entrypoint; all ACL decisions live in the canonical private-file policy.
export type { WindowsAclRunner, WindowsAclSnapshot } from './privateFileAcl';
export {
  assertPrivateWindowsAcl,
  assertSafeDarwinMcpAcl,
  assertWindowsMcpAncestry,
  runWindowsMcpAclScript,
  validateWindowsAcl,
  validateWindowsAncestorAcl,
} from './privateFileAcl';
