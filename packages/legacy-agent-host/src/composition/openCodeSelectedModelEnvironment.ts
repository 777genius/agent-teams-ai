type RecordValue = Record<string, unknown>;
const record = (value: unknown): value is RecordValue =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** Preserve the selected model's existing normalization without expanding discarded values. */
export function shadowOpenCodeSelectedModelEnvironment(
  value: unknown,
  environment: Readonly<Record<string, string>>,
  refuse: () => never
): unknown {
  const inspect = (input: unknown): void => {
    if (typeof input === 'string') {
      if (input.includes('{file:')) return refuse();
      for (const match of input.matchAll(/\{env:([A-Za-z_][A-Za-z0-9_]*)\}|\$\{([A-Za-z_][A-Za-z0-9_]*)\}/gu)) {
        const selected = environment[match[1] ?? match[2]!];
        if (selected === undefined || selected.includes('\0')) return refuse();
      }
    } else if (Array.isArray(input)) input.forEach(inspect);
    else if (record(input)) Object.values(input).forEach(inspect);
  };
  const entries = (input: unknown, project: (key: string, item: unknown) => unknown): unknown => {
    if (!record(input)) return input;
    const result: [string, unknown][] = [];
    for (const [key, item] of Object.entries(input)) {
      if (key === '__proto__') inspect(item);
      else result.push([key, project(key, item)]);
    }
    return Object.fromEntries(result);
  };
  const json = (input: unknown): unknown => Array.isArray(input)
    ? input.map(json) : entries(input, (_key, item) => json(item));
  const settings = (input: unknown): unknown => entries(input, (key, item) =>
    key === 'compaction' || key === 'encoding' ? item : json(item));
  const overlays = (input: RecordValue): RecordValue => Object.fromEntries(
    Object.entries(input).map(([key, item]) => [
      key,
      key === 'settings' ? settings(item)
        : key === 'headers' ? entries(item, (_key, header) => header)
          : key === 'body' ? json(item) : item,
    ])
  );
  if (!record(value)) return value;
  const result = overlays(value);
  const modalities = value.modalities, capabilities = value.capabilities;
  if (Object.hasOwn(value, 'modalities') && Object.hasOwn(value, 'capabilities') &&
      record(modalities) && record(capabilities)) {
    const next = { ...capabilities };
    let masked = false;
    for (const key of ['input', 'output'] as const) {
      if (!Object.hasOwn(modalities, key) || !Array.isArray(modalities[key]) ||
          !Object.hasOwn(capabilities, key)) continue;
      inspect(capabilities[key]);
      next[key] = undefined;
      masked = true;
    }
    if (masked) result.capabilities = next;
  }
  if (Object.hasOwn(value, 'variants')) {
    const variants = value.variants;
    if (Array.isArray(variants))
      result.variants = variants.map(item => record(item) ? overlays(item) : item);
    else if (record(variants))
      result.variants = Object.fromEntries(Object.entries(variants).map(([key, item]) => [
        key, settings(item),
      ]));
  }
  return result;
}
