import { createHash } from "node:crypto";
export function hashProviderAccountKey(input) {
    const normalized = normalizeAccountKey(input.accountKey);
    if (!normalized)
        return undefined;
    const digest = createHash("sha256")
        .update(`${input.provider}:${normalized}`, "utf8")
        .digest("hex");
    return `sha256:${digest}`;
}
export function shortAccountHash(accountKeyHash) {
    if (!accountKeyHash)
        return "unknown";
    return accountKeyHash.replace(/^sha256:/, "").slice(0, 10);
}
export function normalizeAccountKey(value) {
    return value?.trim().toLowerCase() ?? "";
}
export function maskEmail(value) {
    const trimmed = value.trim();
    const at = trimmed.indexOf("@");
    if (at <= 0)
        return trimmed;
    const local = trimmed.slice(0, at);
    const domain = trimmed.slice(at + 1);
    return `${maskEdge(local)}@${maskDomain(domain)}`;
}
function maskEdge(value) {
    if (value.length <= 2)
        return "*".repeat(value.length);
    return `${value.slice(0, 2)}***${value.slice(-2)}`;
}
function maskDomain(domain) {
    const parts = domain.split(".");
    if (parts.length < 2)
        return maskEdge(domain);
    const tld = parts.pop();
    return `${maskEdge(parts.join("."))}.${tld}`;
}
//# sourceMappingURL=identity.js.map