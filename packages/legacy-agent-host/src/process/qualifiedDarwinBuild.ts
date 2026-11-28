/** Finite process-custody tuples; native Host, Desktop and packaged proofs remain separate. */
export type QualifiedDarwinBuild = '24G90' | '24G624' | '24H232' | '24G830';
export function isQualifiedDarwinBuild(
  value: unknown,
  architecture: string = process.arch
): value is QualifiedDarwinBuild {
  return (
    value === '24G90' ||
    value === '24G624' ||
    (value === '24H232' && architecture === 'arm64') ||
    (value === '24G830' && architecture === 'x64')
  );
}
