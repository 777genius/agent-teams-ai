import { resolve } from "node:path";
export function nodeErrorCode(error) {
    return typeof error === "object" && error !== null &&
        "code" in error &&
        typeof error.code === "string"
        ? error.code
        : undefined;
}
export function stringArrayArg(value) {
    if (value === undefined)
        return [];
    const values = typeof value === "string" ? [value] : value;
    if (!Array.isArray(values))
        throw new Error("string_array_arg_invalid");
    return values.map((item) => {
        if (typeof item !== "string" || item.length === 0) {
            throw new Error("string_array_arg_invalid");
        }
        return item;
    });
}
export function uniqueProjectControlStrings(values) {
    return [...new Set(values.filter((value) => value.length > 0))];
}
export function pathInsideAnyProjectRoot(path, roots) {
    return roots.some((root) => pathInsideOrEqual(path, root));
}
export function pathInsideOrEqual(path, root) {
    const normalizedPath = resolve(path);
    const normalizedRoot = resolve(root);
    return normalizedPath === normalizedRoot ||
        normalizedPath.startsWith(`${normalizedRoot}/`);
}
export function matchesProjectControlPrefix(value, prefixes) {
    return prefixes.length === 0 ||
        prefixes.some((prefix) => value.startsWith(prefix));
}
//# sourceMappingURL=codex-goal-mcp-project-utils.js.map