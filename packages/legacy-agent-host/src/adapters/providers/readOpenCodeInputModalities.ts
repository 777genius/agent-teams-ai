/** Native catalog declarations only. Missing, malformed or conflicting metadata is unknown. */
export function readOpenCodeInputModalities(raw: unknown): readonly string[] | null {
  const record = (value: unknown): Record<string, unknown> | undefined =>
    value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  const model = record(raw);
  if (!model) return null;
  const declarations: string[][] = [];
  for (const field of ['modalities', 'capabilities'] as const) {
    if (!Object.hasOwn(model, field)) continue;
    const parent = record(model[field]);
    if (!parent) return null;
    if (!Object.hasOwn(parent, 'input')) continue;
    const input = parent.input;
    if (Array.isArray(input)) {
      if (
        input.length > 64 ||
        input.some(
          (value) =>
            typeof value !== 'string' || !value || value.trim() !== value || value.length > 128
        )
      )
        return null;
      declarations.push([...new Set(input as string[])].sort());
    } else {
      if (field !== 'capabilities') return null;
      const flags = record(input);
      if (
        !flags ||
        Object.keys(flags).length > 64 ||
        Object.entries(flags).some(
          ([key, value]) =>
            !key || key.trim() !== key || key.length > 128 || typeof value !== 'boolean'
        )
      )
        return null;
      declarations.push(
        Object.keys(flags)
          .filter((key) => flags[key] === true)
          .sort()
      );
    }
  }
  const first = declarations[0];
  if (
    !first ||
    declarations.some((value) =>
      ['image', 'video'].some((modality) => value.includes(modality) !== first.includes(modality))
    )
  )
    return null;
  return first;
}
