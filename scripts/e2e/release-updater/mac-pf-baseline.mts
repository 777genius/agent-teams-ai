// pfctl renders normalization rules with the filter dump, separately from NAT.
// Disable the parser's cross-category ordering requirement, preserving every
// captured rule byte and its relative priority within the original category.
// Native parse preflight and exact post-restore -sr/-sn hashes remain mandatory.
export function serializeMacPfBaseline(nat: string, rules: string): string {
  return `set require-order no\n${nat}\n${rules}`;
}
