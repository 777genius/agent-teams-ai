import { sealGitHubEncryptedSecret } from "./encrypted-secret-policy";
import { assertNoPlaintextSessionFields } from "./plaintext-session-policy";

export { assertLooksLikeGitHubSealedBox } from "./encrypted-secret-policy";
export { assertNoPlaintextSessionFields } from "./plaintext-session-policy";

export type NoCustodyEncryptedWritebackBoundary = {
  readonly encryptedValue: string;
  readonly [field: string]: unknown;
};

export function assertEncryptedWritebackRequestIsNoCustody(
  request: NoCustodyEncryptedWritebackBoundary,
): void {
  assertNoPlaintextSessionFields(request);
  sealGitHubEncryptedSecret({
    encryptedValue: request.encryptedValue,
    keyId: typeof request.keyId === "string" ? request.keyId : "",
  });
}
