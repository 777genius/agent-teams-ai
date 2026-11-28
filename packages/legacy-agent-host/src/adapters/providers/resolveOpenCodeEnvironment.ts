/** Resolve captured OpenCode strings without materializing an oversized replacement. */
export function resolveOpenCodeEnvironment(
  value: unknown,
  environment: Readonly<Record<string, string>>,
  maximumBytes: number,
  refuse: () => never
): unknown {
  if (typeof value !== 'string') return value;
  if (value.includes('{file:')) return refuse();
  const parts: string[] = [];
  let bytes = 0, pendingHighSurrogate = false;
  const append = (part: string) => {
    if (!part) return;
    let start = 0, end = part.length;
    if (pendingHighSurrogate) {
      const first = part.charCodeAt(0);
      const paired = first >= 0xdc00 && first <= 0xdfff;
      bytes += paired ? 4 : 3;
      if (paired) start = 1;
      pendingHighSurrogate = false;
    }
    if (end > start) {
      const last = part.charCodeAt(end - 1);
      if (last >= 0xd800 && last <= 0xdbff) {
        end--;
        pendingHighSurrogate = true;
      }
    }
    bytes += Buffer.byteLength(part.slice(start, end));
    if (bytes > maximumBytes) return refuse();
    parts.push(part);
  };
  let offset = 0;
  for (const match of value.matchAll(/\{env:([A-Za-z_][A-Za-z0-9_]*)\}|\$\{([A-Za-z_][A-Za-z0-9_]*)\}/gu)) {
    append(value.slice(offset, match.index));
    const selected = environment[match[1] ?? match[2]!];
    if (selected === undefined || selected.includes('\0')) return refuse();
    append(selected);
    offset = match.index + match[0].length;
  }
  append(value.slice(offset));
  if (pendingHighSurrogate) bytes += 3;
  if (bytes > maximumBytes) return refuse();
  return parts.join('');
}
