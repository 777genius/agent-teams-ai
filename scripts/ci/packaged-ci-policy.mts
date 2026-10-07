export type PackagedScope = 'full' | 'app';
export interface PackagedDecision {
  scope: PackagedScope;
  run: boolean;
  reason: string;
}
export interface PullRequestInput {
  action: string;
  draft: boolean;
  labels: string[];
  baseSha: string;
  headSha: string;
  changes: unknown;
}

const SHA = /^[a-f0-9]{40}$/i;
const ACTIONS = new Set([
  'opened',
  'synchronize',
  'reopened',
  'ready_for_review',
  'labeled',
  'unlabeled',
  'edited',
]);
const SOURCE_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.css',
  '.html',
  '.svg',
]);
const FULL_PATHS = new Set(
  [
    'src/shared/utils/posthogBuildPolicy.ts',
    'src/shared/utils/sentryBuildPolicy.ts',
    'src/shared/utils/sentryArtifactInventory.ts',
  ].map((path) => path.toLowerCase())
);
const REGULAR_MODES = new Set(['100644', '100755']);
const ZERO_OID = '0'.repeat(40);

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function readPullRequest(eventName: string, event: unknown): PullRequestInput | undefined {
  const payload = record(event);
  const pr = record(payload?.pull_request);
  const base = record(pr?.base);
  const head = record(pr?.head);
  if (
    eventName !== 'pull_request' ||
    typeof payload?.action !== 'string' ||
    !ACTIONS.has(payload.action) ||
    typeof pr?.draft !== 'boolean' ||
    !Array.isArray(pr.labels) ||
    typeof base?.sha !== 'string' ||
    !SHA.test(base.sha) ||
    typeof head?.sha !== 'string' ||
    !SHA.test(head.sha)
  )
    return undefined;
  const labels: string[] = [];
  for (const label of pr.labels) {
    const name = record(label)?.name;
    if (typeof name !== 'string') return undefined;
    labels.push(name);
  }
  return {
    action: payload.action,
    draft: pr.draft,
    labels,
    baseSha: base.sha,
    headSha: head.sha,
    changes: payload.changes,
  };
}

export function isMetadataOnlyEdit(input: PullRequestInput): boolean {
  const changes = record(input.changes);
  if (input.action !== 'edited' || !changes) return false;
  const keys = Object.keys(changes);
  return (
    keys.length > 0 &&
    keys.every((key) => {
      const previous = record(changes[key])?.from;
      return (
        (key === 'title' || key === 'body') &&
        (typeof previous === 'string' || (key === 'body' && previous === null))
      );
    })
  );
}

function isGitPath(path: string): boolean {
  return (
    !/[\p{Cc}\p{Cf}\\]/u.test(path) &&
    path.split('/').every((part) => part !== '' && part !== '.' && part !== '..')
  );
}

function isOrdinarySource(path: string): boolean {
  const foldedPath = path.toLowerCase();
  return (
    (path.startsWith('src/') || path.startsWith('test/')) &&
    SOURCE_EXTENSIONS.has(path.slice(path.lastIndexOf('.'))) &&
    !FULL_PATHS.has(foldedPath) &&
    !foldedPath.startsWith('src/renderer/assets/participant-avatars/') &&
    !foldedPath
      .split('/')
      .some((part) => part === 'config' || part === 'resources' || part === 'scripts') &&
    !/(?:^|\/)(?:[^/]+\.)?(?:config|manifest|lock)\.[^/]+$/i.test(path)
  );
}

/** Raw NUL diff carries file types at the merge-base and head, including both rename paths. */
export function readRawDiff(diff: string):
  | {
      oldMode: string;
      newMode: string;
      status: string;
      paths: string[];
    }[]
  | undefined {
  if (!diff || !diff.endsWith('\0')) return undefined;
  const fields = diff.slice(0, -1).split('\0');
  const files: { oldMode: string; newMode: string; status: string; paths: string[] }[] = [];
  const seenPaths = new Set<string>();
  for (let index = 0; index < fields.length; ) {
    const header = /^:(\d{6}) (\d{6}) ([a-fA-F0-9]{40}) ([a-fA-F0-9]{40}) (A|D|M|R\d{3})$/.exec(
      fields[index++] ?? ''
    );
    if (!header) return undefined;
    const oldMode = header[1]!;
    const newMode = header[2]!;
    const oldOid = header[3]!;
    const newOid = header[4]!;
    const status = header[5]!;
    if (status.startsWith('R') && Number(status.slice(1)) > 100) return undefined;
    if (
      status === 'A'
        ? oldMode !== '000000' || oldOid !== ZERO_OID
        : !REGULAR_MODES.has(oldMode) || oldOid === ZERO_OID
    )
      return undefined;
    if (
      status === 'D'
        ? newMode !== '000000' || newOid !== ZERO_OID
        : !REGULAR_MODES.has(newMode) || newOid === ZERO_OID
    )
      return undefined;
    const count = status.startsWith('R') ? 2 : 1;
    const paths = fields.slice(index, index + count);
    if (paths.length !== count || paths.some((path) => !isGitPath(path))) return undefined;
    for (const path of paths) {
      if (seenPaths.has(path)) return undefined;
      seenPaths.add(path);
    }
    files.push({ oldMode, newMode, status, paths });
    index += count;
  }
  return files.length ? files : undefined;
}

export function classifyPackagedPr(
  eventName: string,
  event: unknown,
  diff?: string
): PackagedDecision {
  const full = (reason: string): PackagedDecision => ({ scope: 'full', run: true, reason });
  const input = readPullRequest(eventName, event);
  if (!input) return full('missing or malformed pull request event');
  if (isMetadataOnlyEdit(input))
    return { scope: 'full', run: false, reason: 'title/body edit only' };
  if (!input.draft) return full('ready pull request');
  if (input.action === 'ready_for_review' || input.action === 'edited')
    return full('review/base change');
  if (input.labels.includes('ci:full')) return full('ci:full requested');
  const files = diff === undefined ? undefined : readRawDiff(diff);
  if (!files) return full('missing, empty, malformed or unsupported git diff');
  if (files.some(({ paths }) => paths.some((path) => !isOrdinarySource(path)))) {
    return full('change outside app-only allowlist');
  }
  return { scope: 'app', run: true, reason: 'draft regular source/test changes' };
}

export function assertFullPackagedGate(input: {
  scope: string | undefined;
  scopeResult: string | undefined;
  packagedResult: string | undefined;
}): void {
  if (
    input.scope !== 'full' ||
    input.scopeResult !== 'success' ||
    input.packagedResult !== 'success'
  ) {
    throw new Error(
      'Full packaged gate requires FULL scope and successful classification and all five platforms'
    );
  }
}
