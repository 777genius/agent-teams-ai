export type {
  NativeVersionClassification,
  OpenCodeSemver,
  OpenCodeSupportDecision,
  OpenCodeSupportedVersionPolicy,
  OpenCodeSupportLevel,
} from './core/domain/generation';
export {
  classifyNativeVersion,
  evaluateLegacyOpenCodeSupport,
  isLegacyOpenCodeVersionSupported,
  MINIMUM_AGENT_TEAMS_OPENCODE_VERSION,
  parseOpenCodeSemver,
  semverLt,
} from './core/domain/generation';
export type { DecodeResult, NegotiationResult } from './core/domain/protocol2';
export {
  decodeOwnerPermissionReply,
  decodeProtocol2CommandContext,
  decodeProtocol2Handshake,
  decodeProtocol2Offer,
  negotiateOpenCodeProtocol,
} from './core/domain/protocol2';
