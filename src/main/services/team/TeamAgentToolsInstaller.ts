import { getToolsBasePath } from '@main/utils/pathDecoder';
import * as fs from 'fs';
import * as path from 'path';

import { atomicWriteAsync } from './atomicWrite';

const TOOL_FILE_NAME = 'teamctl.js';
const TOOL_VERSION = 5;

function buildTeamCtlScript(): string {
  const script = String.raw`#!/usr/bin/env node
'use strict';

// Team tools (v${TOOL_VERSION})

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const TOOL_VERSION = ${TOOL_VERSION};

function nowIso() {
  return new Date().toISOString();
}

function formatError(err) {
  if (!err) return 'Unknown error';
  if (typeof err === 'string') return err;
  if (err instanceof Error) return err.message || String(err);
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

function die(message, code = 1) {
  process.stderr.write(String(message).trimEnd() + '\n');
  process.exit(code);
}

function parseArgs(argv) {
  const out = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--') {
      out._.push(...argv.slice(i + 1));
      break;
    }
    if (token === '-h' || token === '--help') {
      out.flags.help = true;
      continue;
    }
    if (token.startsWith('--')) {
      const eq = token.indexOf('=');
      if (eq !== -1) {
        const key = token.slice(2, eq);
        const value = token.slice(eq + 1);
        out.flags[key] = value;
        continue;
      }
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next != null && !String(next).startsWith('-')) {
        out.flags[key] = next;
        i++;
      } else {
        out.flags[key] = true;
      }
      continue;
    }
    if (token.startsWith('-') && token.length > 1) {
      // minimal short-flag support
      for (const ch of token.slice(1)) {
        if (ch === 'h') out.flags.help = true;
      }
      continue;
    }
    out._.push(token);
  }
  return out;
}

function getHomeDir() {
  return process.env.HOME || process.env.USERPROFILE || '';
}

function getClaudeDir(flags) {
  const raw =
    (typeof flags['claude-dir'] === 'string' && flags['claude-dir']) ||
    (typeof flags['claudeDir'] === 'string' && flags['claudeDir']) ||
    (typeof flags['claude_path'] === 'string' && flags['claude_path']) ||
    '';
  if (raw) return path.resolve(raw);
  const inferred = inferClaudeDirFromScriptPath();
  if (inferred) return inferred;
  const home = getHomeDir();
  if (!home) die('HOME is not set');
  return path.join(home, '.claude');
}

function inferClaudeDirFromScriptPath() {
  // Expected: <claudeDir>/tools/teamctl.js
  const toolsDir = path.dirname(__filename);
  if (path.basename(toolsDir) !== 'tools') return null;
  return path.dirname(toolsDir) || null;
}

function inferTeamNameFromScriptPath() {
  // From ~/.claude/tools/ the team name cannot be inferred — --team is required
  return null;
}

function getTeamName(flags) {
  const explicit =
    (typeof flags.team === 'string' && flags.team.trim()) ||
    (typeof flags['teamName'] === 'string' && flags['teamName'].trim()) ||
    '';
  if (explicit) return explicit;
  const inferred = inferTeamNameFromScriptPath();
  if (inferred) return inferred;
  die('Missing --team (and could not infer team name from script path)');
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJson(filePath, fallback) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    if (err && err.code === 'ENOENT') return fallback;
    throw err;
  }
}

function atomicWrite(filePath, data) {
  ensureDir(path.dirname(filePath));
  const tmp =
    String(filePath) +
    '.tmp.' +
    String(process.pid) +
    '.' +
    String(Math.random().toString(16).slice(2));
  fs.writeFileSync(tmp, data, 'utf8');
  fs.renameSync(tmp, filePath);
}

function normalizeStatus(value) {
  const v = String(value || '').trim();
  if (v === 'pending' || v === 'in_progress' || v === 'completed' || v === 'deleted') return v;
  return null;
}

function normalizeColumn(value) {
  const v = String(value || '').trim();
  if (v === 'review' || v === 'approved') return v;
  return null;
}

function getPaths(flags, teamName) {
  const claudeDir = getClaudeDir(flags);
  const teamDir = path.join(claudeDir, 'teams', teamName);
  const tasksDir = path.join(claudeDir, 'tasks', teamName);
  const kanbanPath = path.join(teamDir, 'kanban-state.json');
  return { claudeDir, teamDir, tasksDir, kanbanPath };
}

function readTask(paths, taskId) {
  const taskPath = path.join(paths.tasksDir, String(taskId) + '.json');
  const task = readJson(taskPath, null);
  if (!task) die('Task not found: ' + String(taskId));
  return { taskPath, task };
}

function writeTask(taskPath, task) {
  atomicWrite(taskPath, JSON.stringify(task, null, 2));
  const verify = readJson(taskPath, null);
  if (!verify) die('Task write verification failed');
  return verify;
}

function setTaskStatus(paths, taskId, status) {
  const normalized = normalizeStatus(status);
  if (!normalized) die('Invalid status: ' + String(status));
  const { taskPath, task } = readTask(paths, taskId);
  task.status = normalized;
  writeTask(taskPath, task);
}

function addTaskComment(paths, taskId, flags) {
  var text = typeof flags.text === 'string' ? flags.text.trim() : '';
  if (!text) die('Missing --text');
  var from = typeof flags.from === 'string' && flags.from.trim() ? flags.from.trim() : 'agent';

  var ref = readTask(paths, taskId);
  var task = ref.task;
  var taskPath = ref.taskPath;

  var existing = Array.isArray(task.comments) ? task.comments : [];
  var commentId = crypto.randomUUID
    ? crypto.randomUUID()
    : String(Date.now()) + '-' + String(Math.random());
  var comment = {
    id: commentId,
    author: from,
    text: text,
    createdAt: nowIso(),
  };
  task.comments = existing.concat([comment]);
  writeTask(taskPath, task);

  return { commentId: commentId, taskId: String(taskId), subject: task.subject, owner: task.owner };
}

function listTaskIds(tasksDir) {
  let entries = [];
  try {
    entries = fs.readdirSync(tasksDir);
  } catch (err) {
    if (err && err.code === 'ENOENT') return [];
    throw err;
  }
  const ids = [];
  for (const file of entries) {
    if (!file.endsWith('.json')) continue;
    if (file.startsWith('.')) continue;
    const num = Number(file.replace(/\.json$/, ''));
    if (!Number.isFinite(num)) continue;
    ids.push(String(num));
  }
  ids.sort((a, b) => Number(a) - Number(b));
  return ids;
}

function getNextTaskId(paths) {
  const ids = listTaskIds(paths.tasksDir);
  const maxFromFiles = ids.length ? Number(ids[ids.length - 1]) : 0;
  const hwmPath = path.join(paths.tasksDir, '.highwatermark');
  const hwmRaw = readJson(hwmPath, null);
  const maxFromHwm = typeof hwmRaw === 'number' ? hwmRaw : Number(String(hwmRaw || '0').trim());
  const max = Math.max(maxFromFiles, Number.isFinite(maxFromHwm) ? maxFromHwm : 0);
  return String(max + 1);
}

function updateHighwatermark(paths, taskId) {
  const hwmPath = path.join(paths.tasksDir, '.highwatermark');
  atomicWrite(hwmPath, String(taskId));
}

function createTask(paths, flags) {
  const subject = typeof flags.subject === 'string' ? flags.subject.trim() : '';
  if (!subject) die('Missing --subject');
  const description =
    typeof flags.description === 'string'
      ? flags.description
      : typeof flags.desc === 'string'
        ? flags.desc
        : '';
  const owner = typeof flags.owner === 'string' && flags.owner.trim() ? flags.owner.trim() : undefined;
  const explicitStatus = typeof flags.status === 'string' ? flags.status : '';
  const status = normalizeStatus(explicitStatus) || (owner ? 'in_progress' : 'pending');
  const activeForm =
    typeof flags.activeForm === 'string'
      ? flags.activeForm
      : typeof flags['active-form'] === 'string'
        ? flags['active-form']
        : undefined;

  ensureDir(paths.tasksDir);
  const nextId = getNextTaskId(paths);
  const taskPath = path.join(paths.tasksDir, String(nextId) + '.json');
  if (fs.existsSync(taskPath)) die('Task already exists: ' + String(nextId));

  const task = {
    id: nextId,
    subject,
    description: String(description || subject),
    activeForm: activeForm ? String(activeForm) : undefined,
    owner,
    status,
    blocks: [],
    blockedBy: [],
  };

  writeTask(taskPath, task);
  updateHighwatermark(paths, nextId);
  return task;
}

function readKanbanState(paths, teamName) {
  const fallback = { teamName, reviewers: [], tasks: {} };
  const parsed = readJson(paths.kanbanPath, fallback);
  if (!parsed || typeof parsed !== 'object') return fallback;
  const reviewers = Array.isArray(parsed.reviewers)
    ? parsed.reviewers.filter((r) => typeof r === 'string' && r.trim())
    : [];
  const tasks = parsed.tasks && typeof parsed.tasks === 'object' ? parsed.tasks : {};
  return { teamName, reviewers, tasks };
}

function writeKanbanState(paths, state) {
  atomicWrite(paths.kanbanPath, JSON.stringify(state, null, 2));
}

function setKanbanColumn(paths, teamName, taskId, column) {
  const normalized = normalizeColumn(column);
  if (!normalized) die('Invalid column: ' + String(column));
  const state = readKanbanState(paths, teamName);
  if (normalized === 'review') {
    state.tasks[String(taskId)] = {
      column: 'review',
      reviewer: null,
      movedAt: nowIso(),
    };
  } else {
    state.tasks[String(taskId)] = {
      column: 'approved',
      movedAt: nowIso(),
    };
  }
  writeKanbanState(paths, state);
}

function clearKanban(paths, teamName, taskId) {
  const state = readKanbanState(paths, teamName);
  delete state.tasks[String(taskId)];
  writeKanbanState(paths, state);
}

function sendInboxMessage(paths, teamName, flags) {
  const to = typeof flags.to === 'string' ? flags.to.trim() : '';
  if (!to) die('Missing --to');
  const text = typeof flags.text === 'string' ? flags.text : '';
  if (!text) die('Missing --text');
  const summary = typeof flags.summary === 'string' ? flags.summary : undefined;
  const from = typeof flags.from === 'string' && flags.from.trim() ? flags.from.trim() : 'user';

  const inboxPath = path.join(paths.teamDir, 'inboxes', String(to) + '.json');
  ensureDir(path.dirname(inboxPath));

  const messageId = crypto.randomUUID
    ? crypto.randomUUID()
    : String(Date.now()) + '-' + String(Math.random());
  const payload = {
    from,
    text,
    timestamp: nowIso(),
    read: false,
    summary,
    messageId,
  };

  const existing = readJson(inboxPath, []);
  const list = Array.isArray(existing) ? existing : [];
  list.push(payload);
  atomicWrite(inboxPath, JSON.stringify(list, null, 2));
  const verify = readJson(inboxPath, []);
  if (!Array.isArray(verify) || !verify.some((m) => m && m.messageId === messageId)) {
    die('Inbox write verification failed');
  }
  return { deliveredToInbox: true, messageId };
}

function reviewApprove(paths, teamName, taskId, flags) {
  setKanbanColumn(paths, teamName, taskId, 'approved');
  const notify = flags.notify === true || flags['notify-owner'] === true;
  if (!notify) return;
  const { task } = readTask(paths, taskId);
  if (!task.owner) return;
  const from = typeof flags.from === 'string' && flags.from.trim() ? flags.from.trim() : 'user';
  const note = typeof flags.note === 'string' ? flags.note.trim() : '';
  const text = note
    ? 'Task #' + String(taskId) + ' approved.\n\n' + note
    : 'Task #' + String(taskId) + ' approved.';
  sendInboxMessage(paths, teamName, {
    to: task.owner,
    text,
    summary: 'Approved #' + String(taskId),
    from,
  });
}

function reviewRequestChanges(paths, teamName, taskId, flags) {
  const comment = typeof flags.comment === 'string' ? flags.comment.trim() : '';
  const { taskPath, task } = readTask(paths, taskId);
  if (!task.owner) die('No owner found for task ' + String(taskId));

  clearKanban(paths, teamName, taskId);
  task.status = 'in_progress';
  writeTask(taskPath, task);

  const from = typeof flags.from === 'string' && flags.from.trim() ? flags.from.trim() : 'user';
  const text =
    'Task #' +
    String(taskId) +
    ' needs fixes.\n\n' +
    (comment || 'Reviewer requested changes.') +
    '\n\n' +
    'Please fix and mark it as completed when ready.';
  sendInboxMessage(paths, teamName, {
    to: task.owner,
    text,
    summary: 'Fix request for #' + String(taskId),
    from,
  });
}

function printHelp() {
  const inferred = inferTeamNameFromScriptPath();
  const teamHint = inferred ? ' (inferred team: ' + String(inferred) + ')' : '';
  process.stdout.write(
    [
      'teamctl.js v' + String(TOOL_VERSION) + teamHint,
      '',
      'Usage:',
      '  node teamctl.js task set-status <id> <pending|in_progress|completed|deleted> [--team <team>]',
      '  node teamctl.js task complete <id> [--team <team>]',
      '  node teamctl.js task start <id> [--team <team>]',
      '  node teamctl.js task create --subject "..." [--description "..."] [--prompt "..."] [--owner "member"] [--notify --from "member"] [--team <team>]',
      '  node teamctl.js task comment <id> --text "..." [--from "member"] [--team <team>]',
      '  node teamctl.js kanban set-column <id> <review|approved> [--team <team>]',
      '  node teamctl.js kanban clear <id> [--team <team>]',
      '  node teamctl.js review approve <id> [--notify-owner --from "member" --note "..."] [--team <team>]',
      '  node teamctl.js review request-changes <id> --comment "..." [--from "member"] [--team <team>]',
      '  node teamctl.js message send --to "member" --text "..." [--summary "..."] [--from "member"] [--team <team>]',
      '',
      'Options:',
      '  --team <name>           Team name (if not under ~/.claude/teams/<team>/tools)',
      '  --claude-dir <path>     Override ~/.claude location',
      '',
    ].join('\n')
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.flags.help || args._.length === 0) {
    printHelp();
    return;
  }

  const domain = args._[0];
  const action = args._[1];
  const rest = args._.slice(2);

  const teamName = getTeamName(args.flags);
  const paths = getPaths(args.flags, teamName);

  if (domain === 'task') {
    if (action === 'set-status') {
      const id = rest[0] || args.flags.id;
      const status = rest[1] || args.flags.status;
      if (!id || !status) die('Usage: task set-status <id> <status>');
      setTaskStatus(paths, String(id), status);
      process.stdout.write('OK task #' + String(id) + ' status=' + String(status) + '\n');
      return;
    }
    if (action === 'complete' || action === 'done') {
      const id = rest[0] || args.flags.id;
      if (!id) die('Usage: task complete <id>');
      setTaskStatus(paths, String(id), 'completed');
      process.stdout.write('OK task #' + String(id) + ' status=completed\n');
      return;
    }
    if (action === 'start') {
      const id = rest[0] || args.flags.id;
      if (!id) die('Usage: task start <id>');
      setTaskStatus(paths, String(id), 'in_progress');
      process.stdout.write('OK task #' + String(id) + ' status=in_progress\n');
      return;
    }
    if (action === 'create') {
      const task = createTask(paths, args.flags);
      const notify = args.flags.notify === true || args.flags['notify-owner'] === true;
      if (notify && task.owner) {
        const from =
          typeof args.flags.from === 'string' && args.flags.from.trim() ? args.flags.from.trim() : 'user';
        const parts = ['New task assigned to you: #' + String(task.id) + ' "' + String(task.subject) + '".'];
        const rawDesc = typeof args.flags.description === 'string' ? args.flags.description.trim()
          : typeof args.flags.desc === 'string' ? args.flags.desc.trim() : '';
        if (rawDesc && rawDesc !== task.subject) {
          parts.push('\nDescription:\n' + rawDesc);
        }
        const prompt = typeof args.flags.prompt === 'string' ? args.flags.prompt.trim() : '';
        if (prompt) {
          parts.push('\nInstructions:\n' + prompt);
        }
        parts.push(
          '\n${'```'}info_for_agent',
          'Update task status using:',
          'node "$HOME/.claude/tools/${TOOL_FILE_NAME}" --team ' + String(teamName) + ' task start ' + String(task.id),
          'node "$HOME/.claude/tools/${TOOL_FILE_NAME}" --team ' + String(teamName) + ' task complete ' + String(task.id),
          '${'```'}'
        );
        sendInboxMessage(paths, teamName, {
          to: task.owner,
          text: parts.join('\n'),
          summary: 'New task #' + String(task.id) + ' assigned',
          from,
        });
      }
      process.stdout.write(JSON.stringify(task, null, 2) + '\n');
      return;
    }
    if (action === 'get') {
      const id = rest[0] || args.flags.id;
      if (!id) die('Usage: task get <id>');
      const { task } = readTask(paths, String(id));
      process.stdout.write(JSON.stringify(task, null, 2) + '\n');
      return;
    }
    if (action === 'list') {
      const ids = listTaskIds(paths.tasksDir);
      const tasks = [];
      for (const id of ids) {
        try {
          tasks.push(readJson(path.join(paths.tasksDir, String(id) + '.json'), null));
        } catch {}
      }
      process.stdout.write(JSON.stringify(tasks.filter(Boolean), null, 2) + '\n');
      return;
    }
    if (action === 'comment') {
      const id = rest[0] || args.flags.id;
      if (!id) die('Usage: task comment <id> --text "..."');
      const result = addTaskComment(paths, String(id), args.flags);
      const from = typeof args.flags.from === 'string' && args.flags.from.trim() ? args.flags.from.trim() : 'agent';
      // Notify task owner via inbox — but SKIP self-notification to prevent loop
      if (result.owner && result.owner !== from) {
        try {
          sendInboxMessage(paths, teamName, {
            to: result.owner,
            text: 'Comment on task #' + String(result.taskId) + ' "' + String(result.subject) + '":\n\n' + (typeof args.flags.text === 'string' ? args.flags.text.trim() : ''),
            summary: 'Comment on #' + String(result.taskId),
            from: from,
          });
        } catch (e) { /* best-effort */ }
      }
      process.stdout.write('OK comment added to task #' + String(id) + '\n');
      return;
    }
    die('Unknown task action: ' + String(action));
  }

  if (domain === 'kanban') {
    if (action === 'set-column') {
      const id = rest[0] || args.flags.id;
      const column = rest[1] || args.flags.column;
      if (!id || !column) die('Usage: kanban set-column <id> <review|approved>');
      setKanbanColumn(paths, teamName, String(id), column);
      process.stdout.write(
        'OK kanban #' + String(id) + ' column=' + String(column) + '\n'
      );
      return;
    }
    if (action === 'clear' || action === 'remove') {
      const id = rest[0] || args.flags.id;
      if (!id) die('Usage: kanban clear <id>');
      clearKanban(paths, teamName, String(id));
      process.stdout.write('OK kanban #' + String(id) + ' cleared\n');
      return;
    }
    if (action === 'reviewers') {
      const sub = rest[0];
      const name = rest[1];
      const state = readKanbanState(paths, teamName);
      if (sub === 'list') {
        process.stdout.write(JSON.stringify(state.reviewers, null, 2) + '\n');
        return;
      }
      if ((sub === 'add' || sub === 'remove') && (!name || !String(name).trim())) {
        die('Usage: kanban reviewers add|remove <name>');
      }
      const trimmed = String(name || '').trim();
      const before = new Set(state.reviewers);
      if (sub === 'add') before.add(trimmed);
      else if (sub === 'remove') before.delete(trimmed);
      else die('Usage: kanban reviewers list|add|remove ...');
      state.reviewers = [...before];
      writeKanbanState(paths, state);
      process.stdout.write('OK reviewers ' + String(sub) + '\n');
      return;
    }
    die('Unknown kanban action: ' + String(action));
  }

  if (domain === 'review') {
    if (action === 'approve') {
      const id = rest[0] || args.flags.id;
      if (!id) die('Usage: review approve <id>');
      reviewApprove(paths, teamName, String(id), args.flags);
      process.stdout.write('OK review #' + String(id) + ' approved\n');
      return;
    }
    if (action === 'request-changes') {
      const id = rest[0] || args.flags.id;
      if (!id) die('Usage: review request-changes <id> --comment "..."');
      reviewRequestChanges(paths, teamName, String(id), args.flags);
      process.stdout.write('OK review #' + String(id) + ' requested changes\n');
      return;
    }
    die('Unknown review action: ' + String(action));
  }

  if (domain === 'message') {
    if (action === 'send') {
      const result = sendInboxMessage(paths, teamName, args.flags);
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
      return;
    }
    die('Unknown message action: ' + String(action));
  }

  die('Unknown domain: ' + String(domain));
}

main().catch((err) => {
  die(formatError(err));
});
`;

  return script.trimStart();
}

export class TeamAgentToolsInstaller {
  async ensureInstalled(): Promise<string> {
    const toolsDir = getToolsBasePath();
    const toolPath = path.join(toolsDir, TOOL_FILE_NAME);
    await fs.promises.mkdir(toolsDir, { recursive: true });

    const desired = buildTeamCtlScript();
    let current: string | null = null;
    try {
      current = await fs.promises.readFile(toolPath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }

    if (current?.includes(`TOOL_VERSION = ${TOOL_VERSION}`)) {
      return toolPath;
    }

    await atomicWriteAsync(toolPath, desired);
    return toolPath;
  }
}
