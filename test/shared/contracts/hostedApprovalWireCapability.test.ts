import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  HOSTED_APPROVAL_RUNTIME_WIRE_CAPABILITY,
  HOSTED_APPROVAL_RUNTIME_WIRE_CAPABILITY_DIGEST,
} from '../../../src/shared/contracts/hostedApprovalWireCapability';

describe('hosted approval wire capability', () => {
  it('pins canonical cross-repository bytes and their exact digest', () => {
    expect(JSON.stringify(JSON.parse(HOSTED_APPROVAL_RUNTIME_WIRE_CAPABILITY))).toBe(
      HOSTED_APPROVAL_RUNTIME_WIRE_CAPABILITY
    );
    expect(
      `sha256:${createHash('sha256')
        .update(HOSTED_APPROVAL_RUNTIME_WIRE_CAPABILITY, 'utf8')
        .digest('hex')}`
    ).toBe(HOSTED_APPROVAL_RUNTIME_WIRE_CAPABILITY_DIGEST);
    expect(JSON.parse(HOSTED_APPROVAL_RUNTIME_WIRE_CAPABILITY)).toEqual({
      format: 'agent-teams.hosted-approval-wire-capability/v1',
      wireSchemaVersion: 4,
      ownerProofDomain: 'agent-teams.hosted-runtime-approval.owner-proof/v1',
      operations: [
        'approval_ingress_claim',
        'approval_ingress_ack',
        'approval_ingress_authority_resolve',
        'approval_decision_deliver',
        'approval_decision_reconcile',
      ],
      openCodeProtocol: 'agent-teams-hosted-approval-v2',
      openCodeSchemaVersion: 2,
    });
  });
});
