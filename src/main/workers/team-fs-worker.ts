import * as fs from 'node:fs';
import * as path from 'node:path';
import { parentPort } from 'node:worker_threads';

interface ListTeamsPayload {
  teamsDir: string;
  largeConfigBytes: number;
  configHeadBytes: number;
  maxConfigBytes: number;
  maxConfigReadMs: number;
  maxMembersMetaBytes: number;
  maxSessionHistoryInSummary: number;
  maxProjectPathHistoryInSummary: number;
  concurrency: number;
}

interface GetAllTasksPayload {
  tasksBase: string;
  maxTaskBytes: number;
  maxTaskReadMs: number;
  concurrency: number;
}

type WorkerRequest =
  | { id: string; op: 'listTeams'; payload: ListTeamsPayload }
  | { id: string; op: 'getAllTasks'; payload: GetAllTasksPayload };

type WorkerResponse =
  | { id: string; ok: true; result: unknown; diag?: unknown }
  | { id: string; ok: false; error: string };

function isAbortError(error: unknown): boolean {
  return (
    !!error &&
    typeof error === 'object' &&
    'name' in error &&
    (error as { name?: unknown }).name === 'AbortError'
  );
}

async function readFileUtf8WithTimeout(filePath: string, timeoutMs: number): Promise<string> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fs.promises.readFile(filePath, { encoding: 'utf8', signal: controller.signal });
  } catch (error) {
    if (isAbortError(error)) {
      const err = new Error('READ_TIMEOUT');
      (err as NodeJS.ErrnoException).code = 'READ_TIMEOUT';
      throw err;
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function readFileHeadUtf8(filePath: string, maxBytes: number): Promise<string> {
  const handle = await fs.promises.open(filePath, 'r');
  try {
    const stat = await handle.stat();
    const bytesToRead = Math.max(0, Math.min(stat.size, maxBytes));
    if (bytesToRead === 0) return '';
    const buffer = Buffer.alloc(bytesToRead);
    await handle.read(buffer, 0, bytesToRead, 0);
    return buffer.toString('utf8');
  } finally {
    await handle.close();
  }
}

function extractQuotedString(head: string, key: string): string | null {
  const re = new RegExp(`"${key}"\\s*:\\s*("(?:\\\\.|[^"\\\\])*")`);
  const match = head.match(re);
  if (!match?.[1]) return null;
  try {
    const value = JSON.parse(match[1]) as unknown;
    return typeof value === 'string' ? value : null;
  } catch {
    return null;
  }
}

async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let index = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));
  const workers = new Array(workerCount).fill(0).map(async () => {
    while (true) {
      const i = index++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}

function nowMs(): number {
  return Date.now();
}

async function listTeams(payload: ListTeamsPayload): Promise<{ teams: unknown[]; diag: unknown }> {
  const startedAt = nowMs();
  const diag: any = {
    op: 'listTeams',
    startedAt,
    teamsDir: payload.teamsDir,
    totalDirs: 0,
    returned: 0,
    skipped: 0,
    skipReasons: {},
    slowest: [],
    totalMs: 0,
  };

  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(payload.teamsDir, { withFileTypes: true });
  } catch {
    diag.totalMs = nowMs() - startedAt;
    return { teams: [], diag };
  }

  const teamDirs = entries.filter((e) => e.isDirectory());
  diag.totalDirs = teamDirs.length;

  const perTeam = await mapLimit(teamDirs, payload.concurrency, async (entry) => {
    const teamName = entry.name;
    const t0 = nowMs();
    const configPath = path.join(payload.teamsDir, teamName, 'config.json');

    const skip = (reason: string): null => {
      diag.skipped++;
      diag.skipReasons[reason] = (diag.skipReasons[reason] || 0) + 1;
      return null;
    };

    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(configPath);
    } catch {
      return skip('config_stat_failed');
    }
    if (!stat.isFile()) return skip('config_not_file');
    if (stat.size > payload.maxConfigBytes) return skip('config_too_large');

    let config: any = null;
    let displayName: string | null = null;
    let description = '';
    let color: string | undefined;
    let projectPath: string | undefined;
    let leadSessionId: string | undefined;
    let deletedAt: string | undefined;
    let projectPathHistory: string[] | undefined;
    let sessionHistory: string[] | undefined;

    try {
      if (stat.size > payload.largeConfigBytes) {
        const head = await readFileHeadUtf8(configPath, payload.configHeadBytes);
        displayName = extractQuotedString(head, 'name');
        const desc = extractQuotedString(head, 'description');
        description = typeof desc === 'string' ? desc : '';
        const c = extractQuotedString(head, 'color');
        color = typeof c === 'string' && c.trim().length > 0 ? c : undefined;
        const pp = extractQuotedString(head, 'projectPath');
        projectPath = typeof pp === 'string' && pp.trim().length > 0 ? pp : undefined;
        const lead = extractQuotedString(head, 'leadSessionId');
        leadSessionId = typeof lead === 'string' && lead.trim().length > 0 ? lead : undefined;
        const del = extractQuotedString(head, 'deletedAt');
        deletedAt = typeof del === 'string' ? del : undefined;
      } else {
        const raw = await readFileUtf8WithTimeout(configPath, payload.maxConfigReadMs);
        config = JSON.parse(raw);
        displayName = typeof config.name === 'string' ? config.name : null;
        description = typeof config.description === 'string' ? config.description : '';
        color =
          typeof config.color === 'string' && config.color.trim().length > 0
            ? config.color
            : undefined;
        projectPath =
          typeof config.projectPath === 'string' && config.projectPath.trim().length > 0
            ? config.projectPath
            : undefined;
        leadSessionId =
          typeof config.leadSessionId === 'string' && config.leadSessionId.trim().length > 0
            ? config.leadSessionId
            : undefined;
        projectPathHistory = Array.isArray(config.projectPathHistory)
          ? config.projectPathHistory.slice(-payload.maxProjectPathHistoryInSummary)
          : undefined;
        sessionHistory = Array.isArray(config.sessionHistory)
          ? config.sessionHistory.slice(-payload.maxSessionHistoryInSummary)
          : undefined;
        deletedAt = typeof config.deletedAt === 'string' ? config.deletedAt : undefined;
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'READ_TIMEOUT') return skip('config_read_timeout');
      return skip('config_parse_failed');
    }

    if (typeof displayName !== 'string' || displayName.trim() === '') {
      return skip('invalid_display_name');
    }

    const memberMap = new Map<string, { name: string; role?: string; color?: string }>();
    const mergeMember = (m: any): void => {
      const name = typeof m?.name === 'string' ? m.name.trim() : '';
      if (!name) return;
      const key = name.toLowerCase();
      const existing = memberMap.get(key);
      memberMap.set(key, {
        name: existing?.name ?? name,
        role: (typeof m.role === 'string' && m.role.trim()) || existing?.role,
        color: (typeof m.color === 'string' && m.color.trim()) || existing?.color,
      });
    };

    if (config && Array.isArray(config.members)) {
      for (const member of config.members) {
        mergeMember(member);
      }
    }

    try {
      const metaPath = path.join(payload.teamsDir, teamName, 'members.meta.json');
      const metaStat = await fs.promises.stat(metaPath);
      if (metaStat.isFile() && metaStat.size <= payload.maxMembersMetaBytes) {
        const raw = await readFileUtf8WithTimeout(metaPath, payload.maxConfigReadMs);
        const parsed = JSON.parse(raw);
        const members: any[] = Array.isArray(parsed?.members) ? parsed.members : [];
        for (const member of members) {
          if (member && typeof member === 'object' && !member.removedAt) {
            mergeMember(member);
          }
        }
      }
    } catch {
      // ignore
    }

    const members = Array.from(memberMap.values());
    const summary = {
      teamName,
      displayName,
      description,
      memberCount: memberMap.size,
      taskCount: 0,
      lastActivity: null,
      ...(members.length > 0 ? { members } : {}),
      ...(color ? { color } : {}),
      ...(projectPath ? { projectPath } : {}),
      ...(leadSessionId ? { leadSessionId } : {}),
      ...(projectPathHistory ? { projectPathHistory } : {}),
      ...(sessionHistory ? { sessionHistory } : {}),
      ...(deletedAt ? { deletedAt } : {}),
    };

    const ms = nowMs() - t0;
    if (ms >= 250) {
      diag.slowest.push({ teamName, ms });
      diag.slowest.sort((a: any, b: any) => b.ms - a.ms);
      if (diag.slowest.length > 10) diag.slowest.length = 10;
    }
    return summary;
  });

  const teams = perTeam.filter((t): t is NonNullable<typeof t> => t !== null);
  diag.returned = teams.length;
  diag.totalMs = nowMs() - startedAt;
  return { teams, diag };
}

function normalizeWorkIntervals(
  parsed: any
): { startedAt: string; completedAt?: string }[] | undefined {
  if (!Array.isArray(parsed?.workIntervals)) return undefined;
  return (parsed.workIntervals as unknown[])
    .filter(
      (i): i is { startedAt: string; completedAt?: string } =>
        Boolean(i) &&
        typeof i === 'object' &&
        typeof (i as any).startedAt === 'string' &&
        ((i as any).completedAt === undefined || typeof (i as any).completedAt === 'string')
    )
    .map((i) => ({ startedAt: i.startedAt, completedAt: i.completedAt }));
}

function normalizeComments(parsed: any): unknown[] | undefined {
  if (!Array.isArray(parsed?.comments)) return undefined;
  return (parsed.comments as unknown[])
    .filter(
      (c) =>
        c &&
        typeof c === 'object' &&
        typeof (c as any).id === 'string' &&
        typeof (c as any).author === 'string' &&
        typeof (c as any).text === 'string' &&
        typeof (c as any).createdAt === 'string'
    )
    .map((c) => ({
      id: (c as any).id,
      author: (c as any).author,
      text: (c as any).text,
      createdAt: (c as any).createdAt,
      type:
        (c as any).type === 'regular' ||
        (c as any).type === 'review_request' ||
        (c as any).type === 'review_approved'
          ? (c as any).type
          : 'regular',
    }));
}

async function readTasksDirForTeam(
  tasksDir: string,
  teamName: string,
  payload: GetAllTasksPayload,
  diag: any
): Promise<unknown[]> {
  let entries: string[];
  try {
    entries = await fs.promises.readdir(tasksDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }

  const tasks: unknown[] = [];
  for (const file of entries) {
    if (
      !file.endsWith('.json') ||
      file.startsWith('.') ||
      file === '.lock' ||
      file === '.highwatermark'
    ) {
      continue;
    }

    const taskPath = path.join(tasksDir, file);
    try {
      const stat = await fs.promises.stat(taskPath);
      if (!stat.isFile() || stat.size > payload.maxTaskBytes) {
        diag.skipped++;
        diag.skipReasons.task_not_file_or_large =
          (diag.skipReasons.task_not_file_or_large || 0) + 1;
        continue;
      }

      const raw = await readFileUtf8WithTimeout(taskPath, payload.maxTaskReadMs);
      const parsed = JSON.parse(raw);
      const metadata = parsed?.metadata;
      if (metadata?._internal === true) {
        diag.skipped++;
        diag.skipReasons.task_internal = (diag.skipReasons.task_internal || 0) + 1;
        continue;
      }
      if (parsed?.status === 'deleted') {
        diag.skipped++;
        diag.skipReasons.task_deleted = (diag.skipReasons.task_deleted || 0) + 1;
        continue;
      }

      const subject =
        typeof parsed.subject === 'string'
          ? parsed.subject
          : typeof parsed.title === 'string'
            ? parsed.title
            : '';

      let createdAt: string | undefined =
        typeof parsed.createdAt === 'string' ? parsed.createdAt : undefined;
      let updatedAt: string | undefined;
      try {
        if (!createdAt) {
          const bt = stat.birthtime.getTime();
          createdAt = (bt > 0 ? stat.birthtime : stat.mtime).toISOString();
        }
        updatedAt = stat.mtime.toISOString();
      } catch {
        /* ignore */
      }

      const needsClarification =
        parsed.needsClarification === 'lead' || parsed.needsClarification === 'user'
          ? parsed.needsClarification
          : undefined;

      tasks.push({
        id: typeof parsed.id === 'string' || typeof parsed.id === 'number' ? String(parsed.id) : '',
        subject,
        description: typeof parsed.description === 'string' ? parsed.description : undefined,
        activeForm: typeof parsed.activeForm === 'string' ? parsed.activeForm : undefined,
        owner: typeof parsed.owner === 'string' ? parsed.owner : undefined,
        createdBy: typeof parsed.createdBy === 'string' ? parsed.createdBy : undefined,
        status:
          parsed.status === 'pending' ||
          parsed.status === 'in_progress' ||
          parsed.status === 'completed' ||
          parsed.status === 'deleted'
            ? parsed.status
            : 'pending',
        workIntervals: normalizeWorkIntervals(parsed),
        blocks: Array.isArray(parsed.blocks) ? (parsed.blocks as unknown[]) : undefined,
        blockedBy: Array.isArray(parsed.blockedBy) ? (parsed.blockedBy as unknown[]) : undefined,
        related: Array.isArray(parsed.related)
          ? (parsed.related as unknown[]).filter((id): id is string => typeof id === 'string')
          : undefined,
        createdAt,
        updatedAt,
        projectPath: typeof parsed.projectPath === 'string' ? parsed.projectPath : undefined,
        comments: normalizeComments(parsed),
        needsClarification,
        deletedAt: undefined,
        teamName,
      });
    } catch (error) {
      diag.skipped++;
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'READ_TIMEOUT') {
        diag.skipReasons.task_read_timeout = (diag.skipReasons.task_read_timeout || 0) + 1;
      } else {
        diag.skipReasons.task_parse_failed = (diag.skipReasons.task_parse_failed || 0) + 1;
      }
    }
  }
  return tasks;
}

async function getAllTasks(
  payload: GetAllTasksPayload
): Promise<{ tasks: unknown[]; diag: unknown }> {
  const startedAt = nowMs();
  const diag: any = {
    op: 'getAllTasks',
    startedAt,
    tasksBase: payload.tasksBase,
    teamDirs: 0,
    returned: 0,
    skipped: 0,
    skipReasons: {},
    slowestTeams: [],
    totalMs: 0,
  };

  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(payload.tasksBase, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      diag.totalMs = nowMs() - startedAt;
      return { tasks: [], diag };
    }
    throw error;
  }

  const dirs = entries.filter((e) => e.isDirectory());
  diag.teamDirs = dirs.length;

  const chunks = await mapLimit(dirs, payload.concurrency, async (entry) => {
    const teamName = entry.name;
    const t0 = nowMs();
    try {
      const tasksDir = path.join(payload.tasksBase, teamName);
      const tasks = await readTasksDirForTeam(tasksDir, teamName, payload, diag);
      const ms = nowMs() - t0;
      if (ms >= 250) {
        diag.slowestTeams.push({ teamName, ms });
        diag.slowestTeams.sort((a: any, b: any) => b.ms - a.ms);
        if (diag.slowestTeams.length > 10) diag.slowestTeams.length = 10;
      }
      return tasks;
    } catch {
      diag.skipped++;
      diag.skipReasons.team_dir_failed = (diag.skipReasons.team_dir_failed || 0) + 1;
      return [];
    }
  });

  const tasks = chunks.flat();
  diag.returned = tasks.length;
  diag.totalMs = nowMs() - startedAt;
  return { tasks, diag };
}

function post(msg: WorkerResponse): void {
  parentPort?.postMessage(msg);
}

parentPort?.on('message', async (msg: WorkerRequest) => {
  const { id, op } = msg;
  try {
    if (op === 'listTeams') {
      const { teams, diag } = await listTeams(msg.payload);
      post({ id, ok: true, result: teams, diag });
      return;
    }
    if (op === 'getAllTasks') {
      const { tasks, diag } = await getAllTasks(msg.payload);
      post({ id, ok: true, result: tasks, diag });
      return;
    }
    post({ id, ok: false, error: `Unknown op: ${String((msg as any).op)}` });
  } catch (error) {
    post({ id, ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});
