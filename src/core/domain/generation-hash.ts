import { createHash } from "node:crypto";
import type { SessionArtifact } from "./types";

export function computeSessionGenerationHash(input: {
  readonly artifact: SessionArtifact;
  readonly salt?: string;
}): string {
  const hash = createHash("sha256");
  hash.update("subscription-runtime-session-v1");
  hash.update("\0");
  hash.update(input.artifact.providerId);
  hash.update("\0");
  hash.update(input.artifact.kind);
  hash.update("\0");
  hash.update(input.artifact.formatVersion);
  hash.update("\0");
  if (input.salt) {
    hash.update(input.salt);
    hash.update("\0");
  }
  hash.update(input.artifact.bytes);
  return hash.digest("base64url");
}

export function cloneSessionBytes(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(bytes);
}
