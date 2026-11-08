export interface OpenCodeNativeFacts {
  platform: string;
  arch: string;
  libc: 'glibc' | 'musl' | 'unknown' | null;
  avx2: 'yes' | 'no' | 'unknown';
}

export const OPEN_CODE_NATIVE_POLICY_VERSION = 1;

/** Execution architecture and ABI select packages; unknown CPU features use baseline only. */
export function getOpenCodeNativePackages(facts: OpenCodeNativeFacts): string[] {
  const os = facts.platform === 'win32' ? 'windows' : facts.platform;
  if (!['linux', 'darwin', 'windows'].includes(os) || !['x64', 'arm64'].includes(facts.arch))
    return [];
  if (os === 'linux' && facts.libc !== 'glibc' && facts.libc !== 'musl') return [];
  const suffix = os === 'linux' && facts.libc === 'musl' ? '-musl' : '';
  const prefix = `opencode-${os}-${facts.arch}`;
  if (facts.arch === 'arm64') return [`${prefix}${suffix}`];
  const baseline = `${prefix}-baseline${suffix}`;
  return facts.avx2 === 'yes' ? [`${prefix}${suffix}`, baseline] : [baseline];
}

export function compareOpenCodeNativeVersions(left: string, right: string): number | null {
  const parse = (value: string): number[] | null => {
    if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) return null;
    const parts = value.split('.').map(Number);
    return parts.every(Number.isSafeInteger) ? parts : null;
  };
  const a = parse(left),
    b = parse(right);
  if (!a || !b) return null;
  for (const [index, leftPart] of a.entries()) {
    const rightPart = b[index];
    if (rightPart === undefined) return null;
    if (leftPart !== rightPart) return leftPart - rightPart;
  }
  return 0;
}
