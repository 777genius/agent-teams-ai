// TEST-only native Permission.Service diagnostic; shell permission and
// external_directory permission are different. NO model/tool is executed.
import { join } from 'node:path';

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
  try {
    const readback = await call(base);
    const saved = readback.data?.data?.permissions;
    if (readback.status !== 200 || readback.data?.data?.id !== id ||
        readback.data?.data?.location?.directory !== workspace ||
        !Array.isArray(saved) || saved.length !== rules.length ||
        !rules.every((rule, index) => Object.keys(saved[index] || {}).length === 3 &&
          Object.entries(rule).every(([key, value]) => saved[index]?.[key] === value)))
      throw Error('TEST_shell_flag_native_rules_unqualified');
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
    // One disposable session DELETE, no retry after an uncertain ACK.
    const deleted = await call(base, 'DELETE');
    if (deleted.status !== 204) throw Error('TEST_shell_flag_session_cleanup_unconfirmed');
  }
}
