import assert from 'node:assert/strict';
import type { ProcessFact } from '../../packages/legacy-agent-host/tests/fixtures/native-input-capture.ts';

/** Management belongs to the Host, separately from the three selected runtime sessions. */
export function selectMixedProcessChildren(
  children: ProcessFact[],
  executablePaths: { claude: string; codex: string; opencode: string },
  managementCommand: string,
  commands: ReadonlyMap<number, string>
) {
  const management = children.filter(
    (child) =>
      child.command === executablePaths.opencode && commands.get(child.pid) === managementCommand
  );
  assert.equal(management.length, 1, 'one exact profile-bound OpenCode management child');
  const managementChild = management[0]!;
  const runtimeChildren = children.filter((child) => child.pid !== managementChild.pid);
  assert.equal(
    runtimeChildren.length,
    3,
    'all other original children are the three selected runtimes'
  );
  for (const [provider, executable] of Object.entries(executablePaths))
    assert.equal(
      runtimeChildren.filter((child) => child.command === executable).length,
      1,
      `one exact ${provider} runtime child under the captured Host`
    );
  return { managementChild, runtimeChildren };
}

/** No original peer, unknown child or recycled PID can disappear behind a member count. */
export function assertMixedRestartProcessConservation(
  originalHost: ProcessFact,
  childrenBefore: ProcessFact[],
  oldBobChild: ProcessFact,
  tableAfter: ProcessFact[],
  codexPath: string
) {
  const currentHost = tableAfter.find((child) => child.pid === originalHost.pid);
  const childrenAfter = tableAfter.filter((child) => child.parentPid === originalHost.pid);
  assert.deepEqual(currentHost, originalHost, 'same original Host identity after Bob Restart');
  assert.equal(childrenAfter.length, childrenBefore.length, 'all original child slots conserved');
  assert.ok(!tableAfter.some((child) => child.pid === oldBobChild.pid), 'original Bob PID absent');
  const peers = childrenBefore.filter((child) => child.pid !== oldBobChild.pid);
  for (const peer of peers)
    assert.deepEqual(
      childrenAfter.find((child) => child.pid === peer.pid),
      peer,
      'every original peer identity unchanged under the original Host'
    );
  const newChildren = childrenAfter.filter(
    (child) => !childrenBefore.some((previous) => previous.pid === child.pid)
  );
  assert.equal(newChildren.length, 1, 'only the selected Bob child is replaced');
  const newBobChild = newChildren[0]!;
  assert.equal(newBobChild.command, codexPath);
  return { currentHost, childrenAfter, peers, newBobChild };
}
