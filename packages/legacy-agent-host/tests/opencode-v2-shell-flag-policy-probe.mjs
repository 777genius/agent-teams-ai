// TEST-only native Permission.Service diagnostic; shell permission and
// external_directory permission are different. NO model/tool is executed.
import { join } from 'node:path';
import { isOwnedNativeSessionSnapshot } from './opencode-v2-native-session-guard.mjs';

export async function observeShellFlagPermissionSplit(call, workspace, root) {
  const outside = join(root, 'temp', 'TEST-outside-shell-flag');
  const rules = [
    { action: 'shell', resource: '*', effect: 'allow' },
    { action: 'external_directory', resource: '*', effect: 'deny' },
  ];
  const created = await call('/api/session', 'POST', {
    location: { directory: workspace }, agent: 'build', permissions: rules,
  });
  const id = created.data?.data?.id;
  if (created.status !== 200 || !/^ses_[A-Za-z0-9_-]+$/.test(id || ''))
    throw Error('TEST_shell_flag_session_unqualified');
  const base = '/api/session/' + encodeURIComponent(id);
  let cleanupAuthorized = false;
  try {
    const readback = await call(base);
    if (!isOwnedNativeSessionSnapshot(readback, id, workspace, rules))
      throw Error('TEST_shell_flag_native_rules_unqualified');
    cleanupAuthorized = true;
    const shell = await call(base + '/permission', 'POST', {
      action: 'shell', resources: ['git -C ' + outside + ' status'],
    });
    if (shell.status !== 200 || shell.data?.data?.effect !== 'allow')
      throw Error('TEST_shell_flag_native_shell_decision_unqualified');
    const external = await call(base + '/permission', 'POST', {
      action: 'external_directory', resources: [outside],
    });
    if (external.status !== 200 || external.data?.data?.effect !== 'deny')
      throw Error('TEST_shell_flag_native_external_decision_unqualified');
    const pending = await call(base + '/permission');
    if (pending.status !== 200 || !Array.isArray(pending.data?.data) || pending.data.data.length !== 0)
      throw Error('TEST_shell_flag_unexpected_pending_permission');
    return { decisionSplitObserved: true, toolExecutionProven: false };
  } finally {
    // A create ACK alone does not authorize DELETE. Confirm the same TEST
    // session and exact ordered policy again before this second mutation.
    if (cleanupAuthorized) {
      let stillOwned = false;
      try {
        stillOwned = isOwnedNativeSessionSnapshot(await call(base), id, workspace, rules);
      } catch { /* Missing readback is not evidence of ownership. */ }
      if (!stillOwned) throw Error('TEST_shell_flag_cleanup_ownership_unconfirmed');
      const deleted = await call(base, 'DELETE');
      if (deleted.status !== 204) throw Error('TEST_shell_flag_session_cleanup_unconfirmed');
    }
  }
}
