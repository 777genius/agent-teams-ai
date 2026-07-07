import { resolve } from "node:path";

export function nodeErrorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null &&
      "code" in error &&
      typeof (error as { readonly code?: unknown }).code === "string"
    ? (error as { readonly code: string }).code
    : undefined;
}

export function stringArrayArg(value: unknown): readonly string[] {
  if (value === undefined) return [];
  const values = typeof value === "string" ? [value] : value;
  if (!Array.isArray(values)) throw new Error("string_array_arg_invalid");
  return values.map((item) => {
    if (typeof item !== "string" || item.length === 0) {
      throw new Error("string_array_arg_invalid");
    }
    return item;
  });
}

export function uniqueProjectControlStrings(
  values: readonly string[],
): readonly string[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}

export function pathInsideAnyProjectRoot(
  path: string,
  roots: readonly string[],
): boolean {
  return roots.some((root) => pathInsideOrEqual(path, root));
}

export function pathInsideOrEqual(path: string, root: string): boolean {
  const normalizedPath = resolve(path);
  const normalizedRoot = resolve(root);
  return normalizedPath === normalizedRoot ||
    normalizedPath.startsWith(`${normalizedRoot}/`);
}

export function matchesProjectControlPrefix(
  value: string,
  prefixes: readonly string[],
): boolean {
  return prefixes.length === 0 ||
    prefixes.some((prefix) => value.startsWith(prefix));
}
