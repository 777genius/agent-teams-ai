const MEMBER_NAME_SETS = [
  ['atlas', 'nova', 'echo', 'vector', 'ember', 'pixel'],
  ['scout', 'forge', 'quill', 'signal', 'patch', 'guard'],
  ['aurora', 'cipher', 'relay', 'kernel', 'beacon', 'sable'],
  ['orbit', 'flux', 'delta', 'prism', 'comet', 'node'],
] as const;

function normalizeMemberName(name: string): string {
  return name.trim().toLowerCase();
}

function belongsToBaseName(name: string, baseName: string): boolean {
  const normalized = normalizeMemberName(name);
  return normalized === baseName || normalized.startsWith(`${baseName}-`);
}

function getPreferredNameSet(existingNames: readonly string[]): readonly string[] {
  for (const nameSet of MEMBER_NAME_SETS) {
    if (
      nameSet.some((candidate) => existingNames.some((name) => belongsToBaseName(name, candidate)))
    ) {
      return nameSet;
    }
  }

  return MEMBER_NAME_SETS[0];
}

function createUniqueName(baseName: string, existingNames: readonly string[]): string {
  const normalizedExisting = new Set(existingNames.map(normalizeMemberName));
  if (!normalizedExisting.has(baseName)) {
    return baseName;
  }

  let suffix = 2;
  while (normalizedExisting.has(`${baseName}-${suffix}`)) {
    suffix += 1;
  }

  return `${baseName}-${suffix}`;
}

export function getNextSuggestedMemberName(existingNames: readonly string[]): string {
  const normalizedExisting = new Set(existingNames.map(normalizeMemberName).filter(Boolean));
  const preferredSet = getPreferredNameSet(existingNames);

  for (const candidate of preferredSet) {
    if (!normalizedExisting.has(candidate)) {
      return candidate;
    }
  }

  for (const nameSet of MEMBER_NAME_SETS) {
    for (const candidate of nameSet) {
      if (!normalizedExisting.has(candidate)) {
        return candidate;
      }
    }
  }

  const fallbackBaseName = preferredSet[existingNames.length % preferredSet.length] ?? 'agent';
  return createUniqueName(fallbackBaseName, existingNames);
}

export { MEMBER_NAME_SETS };
