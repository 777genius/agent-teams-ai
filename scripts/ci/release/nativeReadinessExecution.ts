import { requireThat } from './contract.js';
import type { StagePlan } from './contract.js';
import {
  release216Execution,
  release220Execution,
  isClosedWindowsResumeHead,
  verifyRelease216Execution,
  verifyRelease220Execution,
  verifyRelease220MacExecution,
  verifyRelease220WindowsExecution,
  verifyRelease220WindowsResumeExecution,
} from './nativeReadinessAuthority.js';
import type { NativeReadinessPort, NativeReadinessReceipt } from './nativeReadiness.js';
import type { NativeScenarioRow } from './nativeReadinessRows.js';
import { RELEASE220_EXECUTION as pins } from './release220ExecutionPins.js';
import { RELEASE220_MAC_EXECUTION as macPins } from './release220MacExecutionPins.js';
import { RELEASE220_WINDOWS_EXECUTION as windowsPins } from './release220WindowsExecutionPins.js';
import { RELEASE220_WINDOWS_REMAINING_EXECUTION as remainingPins } from './release220WindowsRemainingExecutionPins.js';
import type { ExecutionProof } from './nativeReadinessAuthority.js';

function validateRemainingScenario(row: NativeScenarioRow, head: string): void {
  if (head !== remainingPins.head) return;
  requireThat(
    remainingPins.scenarios.some((scenario) => scenario === row.scenario),
    'Unapproved E15 remaining Windows scenario'
  );
}

/** Resolve only original tooling or one closed, reviewed role-specific executor. */
export function createNativeExecutionResolver(
  port: NativeReadinessPort,
  receipt: NativeReadinessReceipt,
  plan: StagePlan,
  planSha256: string,
  inputDigest: string,
  full: boolean
) {
  const verified = new Set<string>();
  async function verifyReviewedRole(
    role: 'Mac' | 'Windows' | 'Windows resume',
    head: string
  ): Promise<void> {
    if (verified.has(head)) return;
    const roles = {
      Mac: {
        prove: port.release220MacExecutionProof?.bind(port),
        verify: verifyRelease220MacExecution,
      },
      Windows: {
        prove: port.release220WindowsExecutionProof?.bind(port),
        verify: verifyRelease220WindowsExecution,
      },
      'Windows resume': {
        prove: port.release220WindowsResumeExecutionProof?.bind(port, head),
        verify: (proof: ExecutionProof) => verifyRelease220WindowsResumeExecution(proof, head),
      },
    };
    const { prove, verify } = roles[role];
    requireThat(typeof prove === 'function', `Missing complete ${role} executor proof`);
    const proof = await prove();
    verify(proof);
    verified.add(head);
  }
  return async (row: NativeScenarioRow, actualHead: string): Promise<string> => {
    let executionSha = plan.input.toolingSha;
    if (receipt.schemaVersion === 2 && !full)
      executionSha = release216Execution(row.kind, plan, planSha256, inputDigest);
    else if (full && plan.input.toolingSha === pins.base)
      executionSha = release220Execution(row.kind, plan, planSha256, inputDigest);
    if (full && row.kind === 'mac-manual' && actualHead === macPins.head) {
      requireThat(plan.input.toolingSha === macPins.base, 'Wrong Mac base plan');
      release220Execution(row.kind, plan, planSha256, inputDigest);
      executionSha = macPins.head;
      await verifyReviewedRole('Mac', executionSha);
    }
    if (full && row.kind === 'windows' && actualHead === windowsPins.head) {
      release220Execution(row.kind, plan, planSha256, inputDigest);
      executionSha = windowsPins.head;
      await verifyReviewedRole('Windows', executionSha);
    }
    if (full && row.kind === 'windows' && isClosedWindowsResumeHead(actualHead)) {
      requireThat(
        row.mode !== 'fresh',
        'Windows resume executor cannot qualify fresh installation'
      );
      validateRemainingScenario(row, actualHead);
      release220Execution(row.kind, plan, planSha256, inputDigest);
      executionSha = actualHead;
      await verifyReviewedRole('Windows resume', executionSha);
    }
    if (
      receipt.schemaVersion === 2 &&
      !full &&
      (row.kind === 'windows' || row.kind === 'mac-old') &&
      !verified.has(executionSha)
    ) {
      requireThat(
        typeof port.executionProof === 'function',
        'Missing complete executor proof capability'
      );
      verifyRelease216Execution(
        await port.executionProof(receipt.repository, executionSha),
        row.kind
      );
      verified.add(executionSha);
    }
    if (full && executionSha === pins.head && !verified.has(executionSha)) {
      requireThat(
        typeof port.release220ExecutionProof === 'function',
        'Missing closed full220 executor proof capability'
      );
      verifyRelease220Execution(await port.release220ExecutionProof());
      verified.add(executionSha);
    }
    return executionSha;
  };
}
