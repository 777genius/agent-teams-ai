import { BoundaryViolationError } from "@777genius/subscription-runtime/core";
const forbiddenPlaintextKeys = [
    "access_token",
    "refresh_token",
    "id_token",
    "authJson",
    "auth_json",
    "session",
    "token",
];
const forbiddenValuePatterns = [
    /\bBearer\s+[A-Za-z0-9._~+/=-]+/i,
    /"auth_mode"\s*:\s*"chatgpt"/i,
    /"refresh_token"\s*:/i,
    /"access_token"\s*:/i,
    /"id_token"\s*:/i,
];
export function assertNoPlaintextSessionFields(value) {
    const json = JSON.stringify(value);
    for (const key of forbiddenPlaintextKeys) {
        if (json.includes(`"${key}"`)) {
            throw new BoundaryViolationError(`Plaintext provider field is forbidden at no-custody boundary: ${key}`);
        }
    }
    for (const pattern of forbiddenValuePatterns) {
        if (pattern.test(json)) {
            throw new BoundaryViolationError("Plaintext provider value is forbidden at no-custody boundary.");
        }
    }
}
export function assertLooksLikeGitHubSealedBox(value) {
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
        throw new BoundaryViolationError("Encrypted secret must be base64.");
    }
    if (value.length < 64) {
        throw new BoundaryViolationError("Encrypted secret is too short.");
    }
}
//# sourceMappingURL=no-plaintext-boundary.js.map