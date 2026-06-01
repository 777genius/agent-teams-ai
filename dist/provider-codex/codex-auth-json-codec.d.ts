import type { ProviderFailure, SessionArtifact, SessionValidationResult } from "@777genius/subscription-runtime/core";
export declare function sessionArtifactFromCodexAuthJson(authJsonBytes: string): SessionArtifact;
export declare function codexAuthJsonFromArtifact(session: SessionArtifact): string;
export declare function validateCodexSessionArtifact(session: SessionArtifact): SessionValidationResult;
export declare function codexValidationFailure(error: unknown): ProviderFailure;
//# sourceMappingURL=codex-auth-json-codec.d.ts.map