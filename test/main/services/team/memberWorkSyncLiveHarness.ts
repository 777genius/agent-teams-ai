import { constants as fsConstants, promises as fs } from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';

import { encodePath } from '../../../../src/main/utils/pathDecoder';

import type { MemberWorkSyncReportRequest } from '../../../../src/features/member-work-sync/contracts';
import type { MemberWorkSyncFeatureFacade } from '../../../../src/features/member-work-sync/main';
import type { TeamProvisioningProgress } from '../../../../src/shared/types';

export class FatalWaitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FatalWaitError';
  }
}

export interface MemberWorkSyncLiveControlServer {
  baseUrl: string;
  close(): Promise<void>;
}

export async function startMemberWorkSyncControlServer(
  feature: MemberWorkSyncFeatureFacade
): Promise<MemberWorkSyncLiveControlServer> {
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
      if (
        request.method === 'GET' &&
        parts.length === 5 &&
        parts[0] === 'api' &&
        parts[1] === 'teams' &&
        parts[3] === 'member-work-sync'
      ) {
        const payload = await feature.getStatus({
          teamName: parts[2],
          memberName: parts[4],
        });
        sendJson(response, 200, payload);
        return;
      }
      if (
        request.method === 'POST' &&
        parts.length === 6 &&
        parts[0] === 'api' &&
        parts[1] === 'teams' &&
        parts[3] === 'member-work-sync' &&
        parts[5] === 'refresh'
      ) {
        const payload = await feature.refreshStatus({
          teamName: parts[2],
          memberName: parts[4],
        });
        sendJson(response, 200, payload);
        return;
      }
      if (
        request.method === 'POST' &&
        parts.length === 5 &&
        parts[0] === 'api' &&
        parts[1] === 'teams' &&
        parts[3] === 'member-work-sync' &&
        parts[4] === 'report'
      ) {
        const body = (await readRequestJson(request)) as MemberWorkSyncReportRequest;
        const payload = await feature.report({
          ...body,
          teamName: parts[2],
          source: 'mcp',
        });
        sendJson(
          response,
          payload.accepted ? 200 : 400,
          payload.accepted ? payload : { error: payload.code }
        );
        return;
      }
      sendJson(response, 404, { error: `Unhandled ${request.method} ${url.pathname}` });
    } catch (error) {
      sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Failed to bind member work sync control server');
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

export function restoreEnv(name: string, previous: string | undefined): void {
  if (previous === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = previous;
  }
}

export async function assertExecutable(filePath: string): Promise<void> {
  await fs.access(filePath, fsConstants.X_OK);
}

export async function waitUntil(
  predicate: () => Promise<boolean>,
  timeoutMs: number,
  pollMs = 2_000,
  getDiagnostics?: () => Promise<string>
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      if (await predicate()) {
        return;
      }
    } catch (error) {
      if (error instanceof FatalWaitError) {
        throw error;
      }
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  const suffix =
    lastError instanceof Error && lastError.message ? ` Last error: ${lastError.message}` : '';
  const diagnostics = getDiagnostics ? `\n${await getDiagnostics().catch(String)}` : '';
  throw new Error(`Timed out after ${timeoutMs}ms waiting for condition.${suffix}${diagnostics}`);
}

export function formatProgressDump(progressEvents: TeamProvisioningProgress[]): string {
  return progressEvents
    .map((progress) =>
      [
        progress.state,
        progress.message,
        progress.messageSeverity,
        progress.error,
        progress.cliLogsTail,
      ]
        .filter(Boolean)
        .join(' | ')
    )
    .join('\n');
}

export async function formatMemberWorkSyncDiagnostics(input: {
  feature: MemberWorkSyncFeatureFacade;
  teamName: string;
  memberName: string;
  taskId?: string;
}): Promise<string> {
  const [{ TeamTaskReader }] = await Promise.all([
    import('../../../../src/main/services/team/TeamTaskReader'),
  ]);
  const [status, metrics, tasks] = await Promise.all([
    input.feature.getStatus({ teamName: input.teamName, memberName: input.memberName }),
    input.feature.getMetrics({ teamName: input.teamName }),
    input.taskId ? new TeamTaskReader().getTasks(input.teamName) : Promise.resolve([]),
  ]);
  const task = input.taskId ? tasks.find((candidate) => candidate.id === input.taskId) : undefined;
  return [
    'Member work sync live diagnostics:',
    JSON.stringify(
      {
        state: status.state,
        diagnostics: status.diagnostics,
        agendaFingerprint: status.agenda.fingerprint,
        agendaItems: status.agenda.items.map((item) => ({
          taskId: item.taskId,
          subject: item.subject,
          assignee: item.assignee,
          kind: item.kind,
        })),
        report: status.report,
        shadow: status.shadow,
        queue: input.feature.getQueueDiagnostics(),
        comments: task?.comments?.map((comment) => ({
          author: comment.author,
          text: comment.text,
        })),
        recentEvents: metrics.recentEvents.slice(-12),
      },
      null,
      2
    ),
  ].join('\n');
}

export async function throwIfClaudeTranscriptApiError(input: {
  claudeRoot: string;
  context: string;
  projectPath?: string;
  sinceMs?: number;
}): Promise<void> {
  const transcriptRoots = await resolveClaudeTranscriptRoots(input.claudeRoot, input.projectPath);
  const transcriptFiles = (await Promise.all(transcriptRoots.map(findJsonlFiles))).flat();
  const apiErrors: Array<{ filePath: string; error: string; text: string }> = [];
  for (const filePath of transcriptFiles) {
    const raw = await fs.readFile(filePath, 'utf8').catch(() => '');
    for (const line of raw.split(/\r?\n/)) {
      if (!line.includes('"isApiErrorMessage"') && !line.includes('"error"')) {
        continue;
      }
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(trimmed) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (input.sinceMs !== undefined && isTranscriptRecordBefore(parsed, input.sinceMs)) {
        continue;
      }
      if (parsed.isApiErrorMessage !== true && typeof parsed.error !== 'string') {
        continue;
      }
      const message = parsed.message as Record<string, unknown> | undefined;
      apiErrors.push({
        filePath,
        error: typeof parsed.error === 'string' ? parsed.error : 'api_error',
        text: extractClaudeMessageText(message),
      });
    }
  }

  if (apiErrors.length === 0) {
    return;
  }

  const latest = apiErrors.at(-1)!;
  throw new FatalWaitError(
    [
      `${input.context}: Claude API error detected in live transcript.`,
      `error=${latest.error}`,
      latest.text ? `message=${latest.text}` : undefined,
      `transcript=${latest.filePath}`,
    ]
      .filter(Boolean)
      .join('\n')
  );
}

async function resolveClaudeTranscriptRoots(
  claudeRoot: string,
  projectPath: string | undefined
): Promise<string[]> {
  const projectsRoot = path.join(claudeRoot, 'projects');
  if (!projectPath) {
    return [projectsRoot];
  }

  const candidateRoots = new Set<string>();
  const addCandidate = (candidatePath: string) => {
    candidateRoots.add(path.join(projectsRoot, encodePath(candidatePath)));
  };
  addCandidate(path.resolve(projectPath));
  const realProjectPath = await fs.realpath(projectPath).catch(() => null);
  if (realProjectPath) {
    addCandidate(realProjectPath);
  }

  const existingRoots: string[] = [];
  for (const candidateRoot of candidateRoots) {
    const stats = await fs.stat(candidateRoot).catch(() => null);
    if (stats?.isDirectory()) {
      existingRoots.push(candidateRoot);
    }
  }
  return existingRoots;
}

function isTranscriptRecordBefore(record: Record<string, unknown>, sinceMs: number): boolean {
  const timestamp = record.timestamp;
  const timestampMs =
    typeof timestamp === 'string'
      ? Date.parse(timestamp)
      : typeof timestamp === 'number'
        ? timestamp
        : Number.NaN;
  return Number.isFinite(timestampMs) && timestampMs < sinceMs;
}

export async function readRuntimeTurnSettledProcessedMetas(teamsBasePath: string): Promise<
  Array<{
    filePath: string;
    meta: Record<string, unknown>;
  }>
> {
  const processedDir = path.join(teamsBasePath, '.member-work-sync', 'runtime-hooks', 'processed');
  const entries = await fs.readdir(processedDir, { withFileTypes: true }).catch(() => []);
  const metas = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.meta.json'))
      .map(async (entry) => {
        const filePath = path.join(processedDir, entry.name);
        const raw = await fs.readFile(filePath, 'utf8');
        return { filePath, meta: JSON.parse(raw) as Record<string, unknown> };
      })
  );
  return metas.sort((left, right) => left.filePath.localeCompare(right.filePath));
}

async function findJsonlFiles(rootPath: string): Promise<string[]> {
  const entries = await fs.readdir(rootPath, { withFileTypes: true }).catch(() => []);
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(rootPath, entry.name);
      if (entry.isDirectory()) {
        return findJsonlFiles(entryPath);
      }
      return entry.isFile() && entry.name.endsWith('.jsonl') ? [entryPath] : [];
    })
  );
  return nested.flat().sort((left, right) => left.localeCompare(right));
}

function extractClaudeMessageText(message: Record<string, unknown> | undefined): string {
  const content = message?.content;
  if (!Array.isArray(content)) {
    return '';
  }
  return content
    .map((part) => {
      if (!part || typeof part !== 'object') {
        return '';
      }
      const text = (part as { text?: unknown }).text;
      return typeof text === 'string' ? text : '';
    })
    .filter(Boolean)
    .join('\n');
}

async function readRequestJson(request: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  return raw ? JSON.parse(raw) : {};
}

function sendJson(response: http.ServerResponse, statusCode: number, payload: unknown): void {
  response.writeHead(statusCode, {
    'content-type': 'application/json',
  });
  response.end(JSON.stringify(payload));
}
