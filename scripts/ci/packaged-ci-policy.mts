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
const APP_ONLY_PATHS = new Set(['src/main/ipc/window.ts']);

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
    keys.every(
      (key) => (key === 'title' || key === 'body') && typeof record(changes[key])?.from === 'string'
    )
  );
}

/** Parse git --name-status -z without trimming or newline splitting filenames. */
export function readNameStatus(diff: string): { status: string; paths: string[] }[] | undefined {
  if (!diff || !diff.endsWith('\0')) return undefined;
  const fields = diff.slice(0, -1).split('\0');
  const files: { status: string; paths: string[] }[] = [];
  const seenPaths = new Set<string>();
  for (let index = 0; index < fields.length; ) {
    const status = fields[index++];
    if (!status || !/^(?:[ADMTUXB]|[RC](?:100|[1-9]?\d))$/.test(status)) return undefined;
    const count = /^[RC]/.test(status) ? 2 : 1;
    const paths = fields.slice(index, index + count);
    if (paths.length !== count || paths.some((path) => !path)) return undefined;
    for (const path of paths) {
      if (seenPaths.has(path)) return undefined;
      seenPaths.add(path);
    }
    files.push({ status, paths });
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
  const files = diff === undefined ? undefined : readNameStatus(diff);
  if (!files) return full('missing, empty or malformed git diff');
  if (files.some(({ status, paths }) => status !== 'M' || !APP_ONLY_PATHS.has(paths[0]!))) {
    return full('change outside app-only allowlist');
  }
  return { scope: 'app', run: true, reason: 'draft modifications confined to window IPC' };
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
