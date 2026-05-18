import { getTeamsBasePath } from '@main/utils/pathDecoder';
import { createLogger } from '@shared/utils/logger';
import * as fs from 'fs';
import * as path from 'path';

import { atomicWriteAsync } from './atomicWrite';
import { getTeamBootstrapStatePath } from './TeamBootstrapStateReader';
import { getTeamLaunchStatePath, getTeamLaunchSummaryPath } from './TeamLaunchStateStore';

import type {
  MemberSpawnStatusEntry,
  PersistedTeamLaunchSnapshot,
  TeamLaunchDiagnosticItem,
  TeamLaunchFailureDiagnosticsBundle,
  TeamMember,
  TeamProviderBackendId,
  TeamProviderId,
  TeamProvisioningProgress,
} from '@shared/types';

const logger = createLogger('Service:TeamLaunchFailureArtifactPack');

const ARTIFACTS_DIR_NAME = 'launch-failure-artifacts';
const LATEST_ARTIFACT_FILE = 'latest.json';
const MAX_CLI_LOG_CHARS = 256_000;
const MAX_TRACE_CHARS = 128_000;
const MAX_COPIED_FILE_BYTES = 256 * 1024;
const MAX_DIAGNOSTICS_COPY_FILE_BYTES = 128 * 1024;

type JsonRecord = Record<string, unknown>;

export interface TeamLaunchFailureArtifactPackInput {
  teamName: string;
  runId: string;
  reason: string;
  startedAt?: string;
  cwd?: string;
  pid?: number | null;
  providerId?: TeamProviderId;
  providerBackendId?: TeamProviderBackendId;
  model?: string;
  expectedMembers?: readonly string[];
  effectiveMembers?: readonly TeamMember[];
  progress?: TeamProvisioningProgress | null;
  launchSnapshot?: PersistedTeamLaunchSnapshot | null;
  launchDiagnostics?: readonly TeamLaunchDiagnosticItem[];
  memberSpawnStatuses?: Record<string, MemberSpawnStatusEntry>;
  cliLogs?: string | null;
  progressTraceLines?: readonly string[];
  runtimeAdapterTraceLines?: readonly string[];
  flags?: JsonRecord;
}

export interface TeamLaunchFailureArtifactPackResult {
  directory: string;
  manifestPath: string;
  files: string[];
}

export type LaunchFailureArtifactClassificationCode =
  | 'workspace_trust_required'
  | 'transport_rejected'
  | 'stdin_missing'
  | 'provider_quota'
  | 'provider_auth'
  | 'model_no_bootstrap'
  | 'process_exited'
  | 'opencode_protocol'
  | 'unknown';

export interface LaunchFailureArtifactClassification {
  code: LaunchFailureArtifactClassificationCode;
  confidence: number;
  evidence: string[];
}

export interface LaunchBootstrapTransportBreadcrumb {
  lastTransportStage: string | null;
  submitRejected: boolean;
  retryable: boolean | null;
  noStdinWarning: boolean;
  bootstrapSubmitted: boolean;
  evidence: string[];
}

interface CopiedArtifactFile {
  sourcePath: string;
  artifactName: string;
  issue?: string;
}

function sanitizeArtifactNamePart(value: string): string {
  const sanitized = value
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return sanitized || 'unknown';
}

function artifactTimestamp(now: Date): string {
  return now.toISOString().replace(/[:.]/g, '-');
}

function assertPathWithin(root: string, target: string): void {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Launch artifact path escaped teams root: ${target}`);
  }
}

function truncateTail(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `[truncated to last ${maxChars} chars]\n${text.slice(text.length - maxChars)}`;
}

export function redactLaunchFailureArtifactText(text: string): string {
  return (
    text
      .replace(/sk-ant-[A-Za-z0-9_-]{20,}/g, '[REDACTED_ANTHROPIC_API_KEY]')
      .replace(/sk-proj-[A-Za-z0-9_-]{20,}/g, '[REDACTED_OPENAI_API_KEY]')
      .replace(/sk-[A-Za-z0-9_-]{20,}/g, '[REDACTED_API_KEY]')
      .replace(
        /\b(ANTHROPIC_API_KEY|OPENAI_API_KEY|CODEX_API_KEY|OPENROUTER_API_KEY|GEMINI_API_KEY)=([^\s"'`]+)/gi,
        '$1=[REDACTED]'
      )
      // eslint-disable-next-line sonarjs/duplicates-in-character-class -- URL-safe token alphabet intentionally includes these literal characters.
      .replace(/\b(authorization:\s*bearer\s+)([A-Za-z0-9._~+/=-]{20,})/gi, '$1[REDACTED]')
      .replace(
        // eslint-disable-next-line sonarjs/regex-complexity, sonarjs/duplicates-in-character-class -- Secret redaction regex intentionally covers common token field spellings.
        /\b(api[_-]?key|token|access[_-]?token|refresh[_-]?token)(["']?\s*[:=]\s*["']?)([A-Za-z0-9._~+/=-]{20,})/gi,
        '$1$2[REDACTED]'
      )
  );
}

function redactJsonLike<T>(value: T): T {
  return redactJsonValue(value) as T;
}

function isSecretJsonKey(key: string): boolean {
  return /^(api[_-]?key|token|access[_-]?token|refresh[_-]?token|authorization)$/i.test(key);
}

function redactJsonValue(value: unknown, key = ''): unknown {
  if (isSecretJsonKey(key)) {
    return '[REDACTED]';
  }
  if (typeof value === 'string') {
    return redactLaunchFailureArtifactText(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactJsonValue(item));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as JsonRecord).map(([entryKey, entryValue]) => [
        entryKey,
        redactJsonValue(entryValue, entryKey),
      ])
    );
  }
  return value;
}

function appendIfString(parts: string[], value: unknown): void {
  if (typeof value === 'string' && value.trim()) {
    parts.push(value.trim());
  }
}

function collectLaunchFailureSearchParts(input: TeamLaunchFailureArtifactPackInput): string[] {
  const parts: string[] = [];
  appendIfString(parts, input.reason);
  appendIfString(parts, input.cliLogs);
  for (const line of input.progressTraceLines ?? []) appendIfString(parts, line);
  for (const line of input.runtimeAdapterTraceLines ?? []) appendIfString(parts, line);
  appendIfString(parts, input.progress?.message);
  appendIfString(parts, input.progress?.error);
  appendIfString(parts, input.progress?.cliLogsTail);
  for (const warning of input.progress?.warnings ?? []) appendIfString(parts, warning);
  for (const diagnostic of input.launchDiagnostics ?? input.progress?.launchDiagnostics ?? []) {
    appendIfString(parts, diagnostic.code);
    appendIfString(parts, diagnostic.label);
    appendIfString(parts, diagnostic.detail);
  }
  for (const [memberName, entry] of Object.entries(input.memberSpawnStatuses ?? {})) {
    appendIfString(parts, memberName);
    appendIfString(parts, entry.status);
    appendIfString(parts, entry.launchState);
    appendIfString(parts, entry.error);
    appendIfString(parts, entry.hardFailureReason);
    appendIfString(parts, entry.runtimeDiagnostic);
  }
  if (input.launchSnapshot) {
    appendIfString(parts, input.launchSnapshot.launchPhase);
    appendIfString(parts, input.launchSnapshot.teamLaunchState);
    for (const [memberName, member] of Object.entries(input.launchSnapshot.members)) {
      appendIfString(parts, memberName);
      appendIfString(parts, member.launchState);
      appendIfString(parts, member.hardFailureReason);
      appendIfString(parts, member.runtimeDiagnostic);
      for (const diagnostic of member.diagnostics ?? []) appendIfString(parts, diagnostic);
    }
  }
  return parts;
}

function firstEvidence(parts: readonly string[], pattern: RegExp): string[] {
  const evidence: string[] = [];
  for (const part of parts) {
    if (pattern.test(part)) {
      evidence.push(truncateTail(part, 600));
      if (evidence.length >= 3) break;
    }
  }
  return evidence;
}

const WORKSPACE_TRUST_FAILURE_PATTERN =
  /workspace trust is not accepted|cannot start in headless process runtime because workspace trust|open that workspace once interactively and accept trust|workspace_trust_preflight_not_confirmed|workspace trust was not confirmed|workspace trust preflight blocked launch/i;

export function isWorkspaceTrustLaunchFailureText(value: string): boolean {
  return WORKSPACE_TRUST_FAILURE_PATTERN.test(value);
}

export function classifyLaunchFailureArtifact(
  input: TeamLaunchFailureArtifactPackInput
): LaunchFailureArtifactClassification {
  const parts = collectLaunchFailureSearchParts(input);
  const text = parts.join('\n').toLowerCase();
  const candidates: {
    code: LaunchFailureArtifactClassificationCode;
    confidence: number;
    pattern: RegExp;
  }[] = [
    {
      code: 'workspace_trust_required',
      confidence: 0.96,
      pattern: WORKSPACE_TRUST_FAILURE_PATTERN,
    },
    {
      code: 'transport_rejected',
      confidence: 0.95,
      pattern: /bootstrap_submit_rejected|submit rejected by local prompt handler/i,
    },
    {
      code: 'stdin_missing',
      confidence: 0.9,
      pattern: /no stdin data received|proceeding without it/i,
    },
    {
      code: 'provider_quota',
      confidence: 0.92,
      pattern: /quota exhausted|insufficient credits|key limit exceeded|total limit|rate limit/i,
    },
    {
      code: 'provider_auth',
      confidence: 0.88,
      pattern:
        /401 unauthorized|not_logged_in|login required|auth(?:entication)? failed|api key.*(?:missing|invalid)|token refresh failed/i,
    },
    {
      code: 'opencode_protocol',
      confidence: 0.84,
      pattern:
        /visible_reply_still_required|non_visible_tool_without_task_progress|empty_assistant_turn|runtime_bootstrap_checkin/i,
    },
    {
      code: 'model_no_bootstrap',
      confidence: 0.82,
      pattern:
        /did not bootstrap-confirm|bootstrap unconfirmed|bootstrap-confirm before timeout|bootstrap was not confirmed|bootstrap not confirmed|check-in not yet received|bootstrap_stalled/i,
    },
    {
      code: 'process_exited',
      confidence: 0.78,
      pattern: /process exited|pid is not alive|pid was not found|stale_metadata|exited before/i,
    },
  ];

  for (const candidate of candidates) {
    if (candidate.pattern.test(text)) {
      return {
        code: candidate.code,
        confidence: candidate.confidence,
        evidence: firstEvidence(parts, candidate.pattern).map(redactLaunchFailureArtifactText),
      };
    }
  }
  return {
    code: 'unknown',
    confidence: 0.2,
    evidence: firstEvidence(parts, /failed|error|timeout/i).map(redactLaunchFailureArtifactText),
  };
}

export function extractLaunchBootstrapTransportBreadcrumb(
  input: TeamLaunchFailureArtifactPackInput
): LaunchBootstrapTransportBreadcrumb {
  const parts = collectLaunchFailureSearchParts(input);
  const combined = parts.join('\n');
  const lastStageMatches = [...combined.matchAll(/last transport stage:\s*([^;\n]+)/gi)];
  const retryableMatches = [
    ...combined.matchAll(/bootstrap_submit_rejected[^\n]*(?:retryable[=:]\s*(true|false))/gi),
  ];
  const evidence = firstEvidence(
    parts,
    /bootstrap_submit_|last transport stage|no stdin data received|local prompt handler/i
  ).map(redactLaunchFailureArtifactText);
  const retryableRaw = retryableMatches.at(-1)?.[1]?.toLowerCase();
  return {
    lastTransportStage: lastStageMatches.at(-1)?.[1]?.trim() ?? null,
    submitRejected: /bootstrap_submit_rejected|submit rejected by local prompt handler/i.test(
      combined
    ),
    retryable: retryableRaw === 'true' ? true : retryableRaw === 'false' ? false : null,
    noStdinWarning: /no stdin data received|proceeding without it/i.test(combined),
    bootstrapSubmitted:
      /(?:event["']?\s*:\s*["']bootstrap_submitted["']|bootstrap_submit_accepted|bootstrap submitted)/i.test(
        combined
      ),
    evidence,
  };
}

async function readBoundedTextFile(sourcePath: string): Promise<{ text?: string; issue?: string }> {
  try {
    const stat = await fs.promises.stat(sourcePath);
    if (!stat.isFile()) {
      return { issue: 'not_regular_file' };
    }
    const handle = await fs.promises.open(sourcePath, 'r');
    try {
      const start = Math.max(0, stat.size - MAX_COPIED_FILE_BYTES);
      const buffer = Buffer.alloc(stat.size - start);
      if (buffer.length > 0) {
        await handle.read(buffer, 0, buffer.length, start);
      }
      const prefix = start > 0 ? `[truncated to last ${MAX_COPIED_FILE_BYTES} bytes]\n` : '';
      return { text: `${prefix}${buffer.toString('utf8')}` };
    } finally {
      await handle.close().catch(() => undefined);
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { issue: code === 'ENOENT' ? 'missing' : 'unreadable' };
  }
}

async function readDiagnosticsCopyFile(
  label: string,
  sourcePath: string
): Promise<TeamLaunchFailureDiagnosticsBundle['files'][number]> {
  const read = await readBoundedTextFile(sourcePath);
  if (read.text === undefined) {
    return {
      label,
      path: sourcePath,
      issue: read.issue ?? 'unreadable',
    };
  }

  const text =
    read.text.length > MAX_DIAGNOSTICS_COPY_FILE_BYTES
      ? `[truncated to last ${MAX_DIAGNOSTICS_COPY_FILE_BYTES} chars]\n${read.text.slice(
          read.text.length - MAX_DIAGNOSTICS_COPY_FILE_BYTES
        )}`
      : read.text;

  return {
    label,
    path: sourcePath,
    content: redactLaunchFailureArtifactText(text).trimEnd(),
  };
}

function parseJsonObject(text: string | undefined): JsonRecord | null {
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as JsonRecord)
      : null;
  } catch {
    return null;
  }
}

function getString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function getRecord(value: unknown): JsonRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : null;
}

function resolveArtifactManifestPath(
  teamDir: string,
  latestJson: JsonRecord | null,
  runId?: string
): { path?: string; issue?: string } {
  if (!latestJson) {
    return { issue: 'latest_json_unavailable' };
  }
  const latestRunId = getString(latestJson.runId);
  if (runId && latestRunId && latestRunId !== runId) {
    return { issue: `latest_run_mismatch:${latestRunId}` };
  }

  const manifestPath = getString(latestJson.manifestPath);
  if (!manifestPath) {
    return { issue: 'manifest_path_missing' };
  }

  try {
    assertPathWithin(path.join(teamDir, ARTIFACTS_DIR_NAME), manifestPath);
  } catch {
    return { issue: 'manifest_path_outside_artifacts_dir' };
  }
  return { path: manifestPath };
}

export async function readTeamLaunchFailureDiagnosticsBundle(
  teamName: string,
  runId?: string
): Promise<TeamLaunchFailureDiagnosticsBundle> {
  const teamDir = path.join(getTeamsBasePath(), teamName);
  const latestPath = path.join(teamDir, ARTIFACTS_DIR_NAME, LATEST_ARTIFACT_FILE);
  const latestFile = await readDiagnosticsCopyFile(
    'launch-failure-artifacts/latest.json',
    latestPath
  );
  const latestJson = parseJsonObject(latestFile.content);
  const resolvedManifest = resolveArtifactManifestPath(teamDir, latestJson, runId);
  const files: TeamLaunchFailureDiagnosticsBundle['files'] = [latestFile];

  let manifestJson: JsonRecord | null = null;
  if (resolvedManifest.path) {
    const manifestFile = await readDiagnosticsCopyFile(
      'launch-failure-artifacts/manifest.json',
      resolvedManifest.path
    );
    files.push(manifestFile);
    manifestJson = parseJsonObject(manifestFile.content);
  } else {
    files.push({
      label: 'launch-failure-artifacts/manifest.json',
      path:
        getString(latestJson?.manifestPath) ??
        path.join(teamDir, ARTIFACTS_DIR_NAME, 'manifest.json'),
      issue: resolvedManifest.issue ?? 'manifest_unavailable',
    });
  }

  files.push(
    await readDiagnosticsCopyFile(
      'bootstrap-journal.jsonl',
      path.join(teamDir, 'bootstrap-journal.jsonl')
    ),
    await readDiagnosticsCopyFile('launch-state.json', getTeamLaunchStatePath(teamName))
  );

  const classification = getRecord(manifestJson?.classification);
  const bootstrapTransportBreadcrumb = getRecord(manifestJson?.bootstrapTransportBreadcrumb);

  return {
    teamName,
    ...(runId
      ? { runId }
      : getString(latestJson?.runId)
        ? { runId: getString(latestJson?.runId) }
        : {}),
    latestPath,
    ...(getString(latestJson?.directory)
      ? { artifactDirectory: getString(latestJson?.directory) }
      : {}),
    ...(resolvedManifest.path ? { manifestPath: resolvedManifest.path } : {}),
    classification: classification
      ? {
          code: getString(classification.code),
          confidence:
            typeof classification.confidence === 'number' ? classification.confidence : undefined,
          evidence: Array.isArray(classification.evidence)
            ? classification.evidence.filter((item): item is string => typeof item === 'string')
            : undefined,
        }
      : null,
    bootstrapTransportBreadcrumb: bootstrapTransportBreadcrumb
      ? {
          lastTransportStage:
            typeof bootstrapTransportBreadcrumb.lastTransportStage === 'string'
              ? bootstrapTransportBreadcrumb.lastTransportStage
              : bootstrapTransportBreadcrumb.lastTransportStage === null
                ? null
                : undefined,
          submitRejected:
            typeof bootstrapTransportBreadcrumb.submitRejected === 'boolean'
              ? bootstrapTransportBreadcrumb.submitRejected
              : undefined,
          retryable:
            typeof bootstrapTransportBreadcrumb.retryable === 'boolean'
              ? bootstrapTransportBreadcrumb.retryable
              : bootstrapTransportBreadcrumb.retryable === null
                ? null
                : undefined,
          noStdinWarning:
            typeof bootstrapTransportBreadcrumb.noStdinWarning === 'boolean'
              ? bootstrapTransportBreadcrumb.noStdinWarning
              : undefined,
          bootstrapSubmitted:
            typeof bootstrapTransportBreadcrumb.bootstrapSubmitted === 'boolean'
              ? bootstrapTransportBreadcrumb.bootstrapSubmitted
              : undefined,
          evidence: Array.isArray(bootstrapTransportBreadcrumb.evidence)
            ? bootstrapTransportBreadcrumb.evidence.filter(
                (item): item is string => typeof item === 'string'
              )
            : undefined,
        }
      : null,
    files,
  };
}

function getKnownLaunchArtifactSourceFiles(teamName: string): CopiedArtifactFile[] {
  const bootstrapStatePath = getTeamBootstrapStatePath(teamName);
  const teamDir = path.dirname(bootstrapStatePath);
  return [
    {
      sourcePath: getTeamLaunchStatePath(teamName),
      artifactName: 'launch-state.json',
    },
    {
      sourcePath: getTeamLaunchSummaryPath(teamName),
      artifactName: 'launch-summary.json',
    },
    {
      sourcePath: bootstrapStatePath,
      artifactName: 'bootstrap-state.json',
    },
    {
      sourcePath: path.join(teamDir, 'bootstrap-journal.jsonl'),
      artifactName: 'bootstrap-journal.tail.jsonl',
    },
    {
      sourcePath: path.join(teamDir, '.bootstrap.lock', 'metadata.json'),
      artifactName: 'bootstrap-lock-metadata.json',
    },
  ];
}

async function writeArtifactTextFile(
  directory: string,
  artifactName: string,
  rawText: string,
  files: string[]
): Promise<void> {
  const targetPath = path.join(directory, artifactName);
  await atomicWriteAsync(targetPath, `${redactLaunchFailureArtifactText(rawText).trimEnd()}\n`);
  files.push(artifactName);
}

export async function writeTeamLaunchFailureArtifactPack(
  input: TeamLaunchFailureArtifactPackInput
): Promise<TeamLaunchFailureArtifactPackResult> {
  const teamsRoot = getTeamsBasePath();
  const teamDir = path.join(teamsRoot, input.teamName);
  const artifactsRoot = path.join(teamDir, ARTIFACTS_DIR_NAME);
  const createdAt = new Date();
  const directory = path.join(
    artifactsRoot,
    `${artifactTimestamp(createdAt)}-${sanitizeArtifactNamePart(input.runId)}`
  );
  assertPathWithin(teamsRoot, directory);
  await fs.promises.mkdir(directory, { recursive: true });

  const files: string[] = [];
  const copiedFiles: CopiedArtifactFile[] = [];

  if (input.cliLogs?.trim()) {
    await writeArtifactTextFile(
      directory,
      'cli-logs-tail.txt',
      truncateTail(input.cliLogs, MAX_CLI_LOG_CHARS),
      files
    );
  }
  if (input.progressTraceLines?.length) {
    await writeArtifactTextFile(
      directory,
      'progress-trace.txt',
      truncateTail(input.progressTraceLines.join('\n'), MAX_TRACE_CHARS),
      files
    );
  }
  if (input.runtimeAdapterTraceLines?.length) {
    await writeArtifactTextFile(
      directory,
      'runtime-adapter-trace.txt',
      truncateTail(input.runtimeAdapterTraceLines.join('\n'), MAX_TRACE_CHARS),
      files
    );
  }

  for (const source of getKnownLaunchArtifactSourceFiles(input.teamName)) {
    const read = await readBoundedTextFile(source.sourcePath);
    if (read.text !== undefined) {
      await writeArtifactTextFile(directory, source.artifactName, read.text, files);
      copiedFiles.push(source);
    } else {
      copiedFiles.push({ ...source, issue: read.issue ?? 'unreadable' });
    }
  }

  const classification = classifyLaunchFailureArtifact(input);
  const bootstrapTransportBreadcrumb = extractLaunchBootstrapTransportBreadcrumb(input);
  const manifest = redactJsonLike({
    version: 1,
    createdAt: createdAt.toISOString(),
    reason: input.reason,
    classification,
    bootstrapTransportBreadcrumb,
    teamName: input.teamName,
    runId: input.runId,
    startedAt: input.startedAt,
    cwd: input.cwd,
    pid: input.pid ?? null,
    providerId: input.providerId,
    providerBackendId: input.providerBackendId,
    model: input.model,
    expectedMembers: input.expectedMembers ?? [],
    effectiveMembers: (input.effectiveMembers ?? []).map((member) => ({
      name: member.name,
      role: member.role,
      providerId: member.providerId,
      providerBackendId: member.providerBackendId,
      model: member.model,
      agentType: member.agentType,
      removedAt: member.removedAt,
    })),
    progress: input.progress ?? null,
    launchDiagnostics: input.launchDiagnostics ?? input.progress?.launchDiagnostics ?? [],
    memberSpawnStatuses: input.memberSpawnStatuses ?? {},
    launchSnapshot: input.launchSnapshot ?? null,
    flags: input.flags ?? {},
    artifactFiles: files,
    copiedFiles,
  });

  const manifestPath = path.join(directory, 'manifest.json');
  await atomicWriteAsync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  files.unshift('manifest.json');

  await fs.promises.mkdir(artifactsRoot, { recursive: true });
  await atomicWriteAsync(
    path.join(artifactsRoot, LATEST_ARTIFACT_FILE),
    `${JSON.stringify(
      redactJsonLike({
        version: 1,
        createdAt: createdAt.toISOString(),
        teamName: input.teamName,
        runId: input.runId,
        reason: input.reason,
        directory,
        manifestPath,
      }),
      null,
      2
    )}\n`
  );

  logger.info(`[${input.teamName}] Wrote launch failure artifact pack`, {
    runId: input.runId,
    reason: input.reason,
    directory,
  });

  return { directory, manifestPath, files };
}
