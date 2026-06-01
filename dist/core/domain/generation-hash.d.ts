import type { SessionArtifact } from "./types";
export declare function computeSessionGenerationHash(input: {
    readonly artifact: SessionArtifact;
    readonly salt?: string;
}): string;
export declare function cloneSessionBytes(bytes: Uint8Array): Uint8Array;
//# sourceMappingURL=generation-hash.d.ts.map