import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

const DEFAULT_PROJECT_ROOT_TOKEN = '__PROJECT_ROOT__';
const FIXTURE_ROOT = path.join(process.cwd(), 'test', 'fixtures', 'team', 'task-change-ledger');

export type TaskChangeLedgerFixtureManifest = {
  schemaVersion: number;
  name: string;
  taskId: string;
  description: string;
  projectRootToken?: string;
  expected?: {
    totalFiles?: number;
    warnings?: string[];
    relativePaths?: string[];
    relationKinds?: Array<'rename' | 'copy'>;
  };
};

export type MaterializedTaskChangeLedgerFixture = {
  rootDir: string;
  projectDir: string;
  manifest: TaskChangeLedgerFixtureManifest;
  cleanup: () => Promise<void>;
};

function replaceTokenInValue<T>(value: T, token: string, replacement: string): T {
  if (typeof value === 'string') {
    return value.split(token).join(replacement) as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => replaceTokenInValue(item, token, replacement)) as T;
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        replaceTokenInValue(item, token, replacement),
      ])
    ) as T;
  }
  return value;
}

async function rewriteProjectRootTokens(rootDir: string, token: string, projectDir: string): Promise<void> {
  const jsonStringReplacement = JSON.stringify(projectDir).slice(1, -1);
  const entries = await fs.readdir(rootDir, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      await rewriteProjectRootTokens(entryPath, token, projectDir);
      continue;
    }
    if (!['.json', '.jsonl'].includes(path.extname(entry.name))) {
      continue;
    }
    const raw = await fs.readFile(entryPath, 'utf8');
    await fs.writeFile(entryPath, raw.split(token).join(jsonStringReplacement), 'utf8');
  }
}

function shouldNormalizeLfFixtureFile(filePath: string): boolean {
  const normalizedPath = filePath.replace(/\\/g, '/');
  return (
    /\.(json|jsonl|md|txt|ts|tsx|js|jsx)$/.test(normalizedPath) ||
    normalizedPath.includes('/.board-task-changes/blobs/sha256/')
  );
}

function looksBinary(buffer: Buffer): boolean {
  for (const byte of buffer) {
    if (byte === 0) return true;
    if (byte < 9 || (byte > 13 && byte < 32)) return true;
  }
  return false;
}

async function normalizeFixtureTextLineEndings(rootDir: string): Promise<void> {
  const entries = await fs.readdir(rootDir, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      await normalizeFixtureTextLineEndings(entryPath);
      continue;
    }
    if (!shouldNormalizeLfFixtureFile(entryPath)) {
      continue;
    }
    const raw = await fs.readFile(entryPath);
    if (!raw.includes(13) || looksBinary(raw)) {
      continue;
    }
    await fs.writeFile(entryPath, raw.toString('utf8').replace(/\r\n?/g, '\n'), 'utf8');
  }
}

export async function materializeTaskChangeLedgerFixture(
  fixtureName: string
): Promise<MaterializedTaskChangeLedgerFixture> {
  const sourceDir = path.join(FIXTURE_ROOT, fixtureName);
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), `task-change-ledger-${fixtureName}-`));
  await fs.cp(sourceDir, rootDir, { recursive: true });

  const manifestPath = path.join(rootDir, 'manifest.json');
  const manifest = JSON.parse(
    await fs.readFile(manifestPath, 'utf8')
  ) as TaskChangeLedgerFixtureManifest;
  const projectDir = path.join(rootDir, 'project');
  const token = manifest.projectRootToken ?? DEFAULT_PROJECT_ROOT_TOKEN;

  await rewriteProjectRootTokens(rootDir, token, projectDir);
  await normalizeFixtureTextLineEndings(rootDir);

  return {
    rootDir,
    projectDir,
    manifest: replaceTokenInValue(manifest, token, projectDir),
    cleanup: async () => {
      await fs.rm(rootDir, { recursive: true, force: true });
    },
  };
}
