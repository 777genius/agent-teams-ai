import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { callUi, inspectElement } from './uap-management-ui';

import type { ManagementSession } from '../../src/features/extension-management/contracts';
import type { DesktopCdp, UiLocator, UiWait } from './uap-management-ui';

const primaryClients = ['claude', 'codex', 'opencode'] as const;

// This inert executable qualifies passive detection only. It must never be run,
// and is never selected for installation or represented as a native runtime proof.
export async function createAdditionalTargetProof(root: string) {
  assert.notEqual(process.platform, 'win32', 'The desktop detection fixture requires POSIX');
  const binDirectory = path.join(root, 'additional-target-bin');
  const executable = path.join(binDirectory, 'cursor');
  const executionWitness = path.join(binDirectory, 'unexpected-execution');
  await mkdir(binDirectory, { recursive: true });
  const quotedWitness = `'${executionWitness.replaceAll("'", "'\\''")}'`;
  const content = `#!/bin/sh\nprintf '%s\\n' 'unexpected Cursor execution' >> ${quotedWitness}\nexit 97\n`;
  await writeFile(executable, content, { mode: 0o755, flag: 'wx' });
  const sha256 = createHash('sha256').update(content).digest('hex');
  const evidence: {
    qualification: string;
    nativeRuntimeQualified: false;
    installationExercised: false;
    executable: string;
    sha256: string;
    executionWitness: string;
    checks: { stage: string; executableUnchanged: true; executionWitnessAbsent: true }[];
    session?: Pick<ManagementSession, 'contextId' | 'environmentId' | 'targets'>;
    initialSelection?: Record<string, boolean>;
  } = {
    qualification: 'controlled passive detection through Go, SDK, host capture and Electron UI',
    nativeRuntimeQualified: false,
    installationExercised: false,
    executable,
    sha256,
    executionWitness,
    checks: [],
  };

  async function assertUnexecuted(stage: string) {
    const witness = await lstat(executionWitness).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    assert.equal(witness, null, `Passive Cursor detection executed the fixture: ${stage}`);
    const current = await lstat(executable);
    assert(current.isFile() && !current.isSymbolicLink(), 'Detection executable was replaced');
    assert.equal(
      createHash('sha256')
        .update(await readFile(executable))
        .digest('hex'),
      sha256,
      `Detection executable bytes changed: ${stage}`
    );
    evidence.checks.push({ stage, executableUnchanged: true, executionWitnessAbsent: true });
  }

  return {
    binDirectory,
    evidence,
    assertUnexecuted,
    async observeInitialUi(cdp: DesktopCdp, wait: UiWait, panel: UiLocator) {
      // This is the public owned capture API, not a fabricated renderer target.
      const session = await callUi<ManagementSession>(cdp, 'session');
      const initialSelection: Record<string, boolean> = {};
      for (const client of [...primaryClients, 'cursor']) {
        const targets = session.targets.filter((target) => target.client === client);
        assert.equal(targets.length, 1, `Expected exactly one captured ${client} profile`);
        const [target] = targets;
        assert.equal(target.id, client);
        assert.equal(target.scope, 'user');
        assert.equal(target.available, true, target.reason);
        assert.equal(target.detectionStatus, 'detected');
        const control: UiLocator = {
          selector: '[data-testid=uap-install-target]',
          within: panel,
          attributes: { 'data-target-id': target.id },
        };
        await wait(async () => {
          const state = await inspectElement(cdp, control);
          return state?.visible && !state.disabled;
        }, `${client} initial installation target is available`);
        const selected = client !== 'cursor';
        assert.equal(
          await callUi<number>(cdp, 'count', [
            { ...control, attributes: { ...control.attributes, 'aria-checked': String(selected) } },
          ]),
          1,
          `${client} initial selection must be ${selected}`
        );
        initialSelection[client] = selected;
      }
      evidence.session = {
        contextId: session.contextId,
        environmentId: session.environmentId,
        targets: session.targets,
      };
      evidence.initialSelection = initialSelection;
      await assertUnexecuted('after-initial-electron-ui');
    },
  };
}
