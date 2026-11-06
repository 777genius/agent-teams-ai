/** Read-only counts from the map's actual owner. No process probes or repair. */
export function countStoppedImportKeys(keys: Iterable<string>, teamName: string): number {
  const prefixes = [
    `${teamName}:`,
    `${teamName}\0`,
    `opencode:${teamName}:`,
    `opencode-send:${teamName}:`,
  ];
  let count = 0;
  for (const key of keys)
    if (key === teamName || prefixes.some((prefix) => key.startsWith(prefix))) count++;
  return count;
}
export type StoppedImportOwnerFacts = Readonly<Record<string, number>>;
