/** Match the shell-selected document, allowing only renderer hash navigation. */
export function isTrustedRenderer(actual: string, expected: string | undefined): boolean {
  if (!expected) return false;
  try {
    const source = new URL(actual);
    const target = new URL(expected);
    return (
      !source.username &&
      !source.password &&
      source.protocol === target.protocol &&
      source.host === target.host &&
      source.pathname === target.pathname &&
      source.search === target.search
    );
  } catch {
    return false;
  }
}
