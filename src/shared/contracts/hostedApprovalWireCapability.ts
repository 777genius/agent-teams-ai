/** Exact cross-repository capability bytes pinned by signed v4 owner routes. */
export const HOSTED_APPROVAL_RUNTIME_WIRE_CAPABILITY =
  '{"format":"agent-teams.hosted-approval-wire-capability/v1","wireSchemaVersion":4,"ownerProofDomain":"agent-teams.hosted-runtime-approval.owner-proof/v1","operations":["approval_ingress_claim","approval_ingress_ack","approval_ingress_authority_resolve","approval_decision_deliver","approval_decision_reconcile"],"openCodeProtocol":"agent-teams-hosted-approval-v2","openCodeSchemaVersion":2}' as const;

export const HOSTED_APPROVAL_RUNTIME_WIRE_CAPABILITY_DIGEST =
  'sha256:40a6c4a131b4e64c04b87337fbce667c91f274fb85b3879c6cdcac49dbbbd639' as const;
