export const filesystemAdapterFixtureSource = [
  "import { readFile } from 'node:fs/promises';",
  'export class FixtureReader {',
  '  constructor(readonly rootPath: string) {}',
  '  read() { return readFile(this.rootPath); }',
  '}',
].join('\n');
