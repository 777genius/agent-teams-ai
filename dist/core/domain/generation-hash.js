import { createHash } from "node:crypto";
export function computeSessionGenerationHash(input) {
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
export function cloneSessionBytes(bytes) {
    return new Uint8Array(bytes);
}
//# sourceMappingURL=generation-hash.js.map