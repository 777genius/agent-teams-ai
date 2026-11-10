/** Finite prospective Draft candidate tuples; actual native/SDK/packed proofs remain separate. */
export type QualifiedDarwinBuild = '24G90' | '24G624';
export function isQualifiedDarwinBuild(value: unknown): value is QualifiedDarwinBuild {
  return value === '24G90' || value === '24G624';
}
