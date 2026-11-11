// TEST-only diagnostic for the V2 session.shell HTTP operation.
// A direct shell route is NOT a model-initiated tool or permission-enforcement proof.
import { setTimeout as delay } from 'node:timers/promises';
import { isOwnedNativeSessionSnapshot } from './opencode-v2-native-session-guard.mjs';

export const DIRECT_SHELL_EFFECT_FILE = 'TEST-v2-direct-shell-effect.txt';
export const DIRECT_SHELL_EXPECTED = 'TEST_V2_NATIVE_DIRECT_SHELL_EFFECT\n';

/**
 * Try one mutation in a disposable native session and inspect only its owned
 * workspace. A transport/ACK failure is HOLD, never a reason to resend.
 * Cleanup sends exactly one DELETE; uncertain deletion is a hard failure.
 */
export async function probeNativeDirectShellEffect(
  call, workspace, readEffect, sleep = (ms) => delay(ms)
) {
  const rules = [
    { action: 'shell', resource: '*', effect: 'allow' },
    { action: 'external_directory', resource: '*', effect: 'deny' },
  ];
  const created = await call('/api/session', 'POST', {
    location: { directory: workspace }, agent: 'build', permissions: rules,
  });
  const id = created.data?.data?.id;
  if (created.status !== 200 || !/^ses_[A-Za-z0-9_-]+$/.test(id || ''))
    throw Error('TEST_direct_shell_session_create_unconfirmed');
  const base = '/api/session/' + encodeURIComponent(id);
  try {
    const snapshot = await call(base);
    if (!isOwnedNativeSessionSnapshot(snapshot, id, workspace, rules))
      throw Error('TEST_direct_shell_session_not_owned');
    // Fresh TEST evidence must be absent BEFORE the only native mutation.
    // A stale file can otherwise masquerade as an acknowledged shell effect.
    if (await readEffect(DIRECT_SHELL_EFFECT_FILE) !== undefined)
      throw Error('TEST_direct_shell_stale_effect_preexisting');
    let status = null;
    let responseUncertain = false;
    // One and only one native shell submission. A rejected HTTP response, a
    // malformed body or an uncertain ACK must never trigger a replay.
    try {
      const reply = await call(base + '/shell', 'POST', {
        command: "printf 'TEST_V2_NATIVE_DIRECT_SHELL_EFFECT\\n' > TEST-v2-direct-shell-effect.txt",
      });
      status = reply.status;
      if (!Number.isInteger(status) || status < 100 || status > 599)
        throw Error('TEST_direct_shell_invalid_HTTP_status');
    } catch {
      responseUncertain = true;
      status = null;
    }
    let effect;
    const accepted = status === 200 || status === 204;
    for (let attempt = 0; attempt < (accepted ? 12 : 1); attempt++) {
      effect = await readEffect(DIRECT_SHELL_EFFECT_FILE);
      if (effect !== undefined) break;
      if (attempt < 11 && accepted) await sleep(100);
    }
    if (effect !== undefined && effect !== DIRECT_SHELL_EXPECTED)
      throw Error('TEST_direct_shell_unexpected_file_effect');
    return {
      attempted: true,
      outcome: accepted && effect === DIRECT_SHELL_EXPECTED ? 'effect-confirmed' : 'hold',
      status,
      responseUncertain,
      modelTurnProven: false,
      toolPermissionEnforcementProven: false,
    };
  } finally {
    // Never retry a potentially applied DELETE or modify a foreign session.
    const removed = await call(base, 'DELETE');
    if (removed.status !== 204)
      throw Error('TEST_direct_shell_session_cleanup_unconfirmed');
  }
}
