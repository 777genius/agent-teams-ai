interface FixtureChild {
  pid: number;
  birth: string;
}
interface FixtureOutput {
  readonly root: FixtureChild | undefined;
  readonly children: readonly FixtureChild[];
  readonly childrenOf: (pid: number) => readonly FixtureChild[];
  readonly push: (chunk: Buffer) => void;
  readonly hasFinal: () => boolean;
}

// Native CRT text output uses CRLF. Retain raw chunks/bounds; interpret complete records only.
export function createFixtureOutputCollector(): FixtureOutput {
  let output = '';
  let final = false;
  const children: FixtureChild[] = [];
  const families = new Map<number, FixtureChild[]>();
  let root: FixtureChild | undefined;
  function collectRecord(record: string): void {
    const line = record.endsWith('\r') ? record.slice(0, -1) : record;
    if (line.startsWith('{"root"') && line.endsWith('}'))
      root = (JSON.parse(line) as { root: FixtureChild }).root;
    if (line.startsWith('{"children"') && line.endsWith('}')) {
      const parsed = JSON.parse(line) as { children: FixtureChild[]; parent?: number };
      if (parsed.parent !== undefined) families.set(parsed.parent, parsed.children);
      for (const entry of parsed.children)
        if (!children.some((value) => value.pid === entry.pid)) children.push(entry);
    }
    if (line === '{"final":true}') final = true;
  }
  return {
    get root() { return root; },
    children,
    childrenOf: (pid) => families.get(pid) ?? [],
    push: (chunk) => {
      if (output.length + chunk.length > 65536)
        throw new Error('Fixture output exceeds bounded JSON-tail gate');
      output += chunk.toString();
      const records = output.split('\n');
      records.pop(); // The last fragment lacks LF, including a split CR|LF or incomplete EOF.
      for (const record of records) collectRecord(record);
    },
    hasFinal: () => final,
  };
}
