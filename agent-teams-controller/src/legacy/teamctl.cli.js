#!/usr/bin/env node
'use strict';

// Team tools (v1.0.0)

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const TOOL_VERSION = '1.0.0';
const AGENT_BLOCK_TAG = 'info_for_agent';
const AGENT_BLOCK_OPEN = '<' + AGENT_BLOCK_TAG + '>';
const AGENT_BLOCK_CLOSE = '</' + AGENT_BLOCK_TAG + '>';

function nowIso() {
  return new Date().toISOString();
}

function wrapAgentBlock(text) {
  const trimmed = typeof text === 'string' ? text.trim() : '';
  if (!trimmed) return '';
  return AGENT_BLOCK_OPEN + '\n' + trimmed + '\n' + AGENT_BLOCK_CLOSE;
}

function makeId() {
  return crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + '-' + String(Math.random());
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

function isSafePathSegment(value) {
  const v = String(value == null ? '' : value);
  if (v.length === 0 || v.trim().length === 0) return false;
  if (v === '.' || v === '..') return false;
  if (v.includes('/') || v.includes('\\\\')) return false;
  if (v.includes('..')) return false;
  if (v.includes('\0')) return false;
  return true;
}

function assertSafePathSegment(label, value) {
  const v = String(value == null ? '' : value);
  if (!isSafePathSegment(v)) {
    die('Invalid ' + String(label));
  }
  return v;
}

function getTaskJsonPath(paths, taskId) {
  const id = assertSafePathSegment('taskId', taskId);
  return path.join(paths.tasksDir, id + '.json');
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
  if (process.env.HOME) return process.env.HOME;
  if (process.env.USERPROFILE) return process.env.USERPROFILE;
  if (process.env.HOMEDRIVE && process.env.HOMEPATH) {
    return process.env.HOMEDRIVE + process.env.HOMEPATH;
  }
  try { return require('os').homedir(); } catch { return ''; }
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
  if (!home) die('HOME/USERPROFILE is not set');
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
  if (explicit) return assertSafePathSegment('team', explicit);
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
  // On Windows, fs.renameSync can throw EPERM/EACCES when another process
  // is concurrently renaming to the same target. Retry with backoff.
  const maxRetries = process.platform === 'win32' ? 5 : 1;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      fs.renameSync(tmp, filePath);
      return;
    } catch (e) {
      if (attempt < maxRetries - 1 && e && (e.code === 'EPERM' || e.code === 'EACCES')) {
        // Busy wait — small random delay to reduce contention
        const ms = Math.floor(Math.random() * 50) + 10;
        const end = Date.now() + ms;
        while (Date.now() < end) { /* spin */ }
        continue;
      }
      // Clean up temp file on final failure
      try { fs.unlinkSync(tmp); } catch { /* ignore */ }
      throw e;
    }
  }
}

// ---------------------------------------------------------------------------
// Attachments (task + comment)
// ---------------------------------------------------------------------------

const TASK_ATTACHMENTS_DIR = 'task-attachments';
const MAX_TASK_ATTACHMENT_BYTES = 20 * 1024 * 1024; // 20 MB

function sanitizeFilename(original) {
  const raw = String(original == null ? '' : original).trim();
  const parts = raw.split(/[\\/]/);
  const base = (parts.length ? parts[parts.length - 1] : raw).trim();
  const cleaned = base
    .replace(/\0/g, '')
    .replace(/[\r\n\t]/g, ' ')
    .replace(/[\\/]/g, '_')
    .trim();
  if (!cleaned) return 'attachment';
  return cleaned.length > 180 ? cleaned.slice(0, 180) : cleaned;
}

function readFileHeader(filePath, maxBytes) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(maxBytes);
    const bytes = fs.readSync(fd, buf, 0, maxBytes, 0);
    return buf.slice(0, bytes);
  } finally {
    try { fs.closeSync(fd); } catch { /* ignore */ }
  }
}

function startsWithBytes(buf, bytes) {
  if (!buf || buf.length < bytes.length) return false;
  for (let i = 0; i < bytes.length; i++) {
    if (buf[i] !== bytes[i]) return false;
  }
  return true;
}

function detectMimeTypeFromPathAndHeader(filePath, filename) {
  const name = String(filename || '').toLowerCase();
  const ext = path.extname(name);

  // Fast path by extension for common types.
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.pdf') return 'application/pdf';
  if (ext === '.txt') return 'text/plain';
  if (ext === '.md') return 'text/markdown';
  if (ext === '.json') return 'application/json';
  if (ext === '.zip') return 'application/zip';

  // Sniff magic bytes for a few important formats.
  let header;
  try {
    header = readFileHeader(filePath, 16);
  } catch {
    return 'application/octet-stream';
  }
  if (startsWithBytes(header, [0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a])) return 'image/png'; // PNG
  if (startsWithBytes(header, [0xff,0xd8,0xff])) return 'image/jpeg'; // JPEG
  if (header.length >= 6) {
    const sig6 = header.slice(0, 6).toString('ascii');
    if (sig6 === 'GIF87a' || sig6 === 'GIF89a') return 'image/gif';
  }
  if (header.length >= 12) {
    const riff = header.slice(0, 4).toString('ascii');
    const webp = header.slice(8, 12).toString('ascii');
    if (riff === 'RIFF' && webp === 'WEBP') return 'image/webp';
  }
  if (header.length >= 5 && header.slice(0, 5).toString('ascii') === '%PDF-') return 'application/pdf';
  if (startsWithBytes(header, [0x50,0x4b,0x03,0x04])) return 'application/zip';

  return 'application/octet-stream';
}

function getTaskAttachmentsDir(paths, taskId) {
  const id = assertSafePathSegment('taskId', taskId);
  return path.join(paths.teamDir, TASK_ATTACHMENTS_DIR, id);
}

function getStoredAttachmentPath(paths, taskId, attachmentId, filename) {
  const safeName = sanitizeFilename(filename);
  return path.join(getTaskAttachmentsDir(paths, taskId), String(attachmentId) + '--' + safeName);
}

function ensureSourceFileReadable(srcPath) {
  const st = fs.statSync(srcPath);
  if (!st.isFile()) die('Not a file: ' + String(srcPath));
  if (st.size > MAX_TASK_ATTACHMENT_BYTES) {
    die(
      'Attachment too large: ' +
        (st.size / (1024 * 1024)).toFixed(1) +
        ' MB (max ' +
        String(MAX_TASK_ATTACHMENT_BYTES / (1024 * 1024)) +
        ' MB)'
    );
  }
  return st;
}

function copyOrLinkFile(srcPath, destPath, mode, allowFallback) {
  const m = String(mode || 'copy').toLowerCase();
  if (m === 'link') {
    try {
      fs.linkSync(srcPath, destPath);
      return { mode: 'link', fallbackUsed: false };
    } catch (e) {
      if (!allowFallback) throw e;
      // Fall back to copy (cross-device link, permissions, etc.)
      try {
        fs.copyFileSync(srcPath, destPath);
        return { mode: 'copy', fallbackUsed: true };
      } catch (e2) {
        // Bubble up most useful error
        throw e2 || e;
      }
    }
  }
  fs.copyFileSync(srcPath, destPath);
  return { mode: 'copy', fallbackUsed: false };
}

function saveTaskAttachmentFile(paths, taskId, flags) {
  const rawFile = (typeof flags.file === 'string' && flags.file.trim())
    ? flags.file.trim()
    : (typeof flags.path === 'string' && flags.path.trim())
      ? flags.path.trim()
      : '';
  if (!rawFile) die('Missing --file <path>');

  const srcPath = path.resolve(rawFile);
  ensureSourceFileReadable(srcPath);

  const filename = (typeof flags.filename === 'string' && flags.filename.trim())
    ? flags.filename.trim()
    : path.basename(srcPath);
  const mimeType = (typeof flags['mime-type'] === 'string' && flags['mime-type'].trim())
    ? flags['mime-type'].trim()
    : (typeof flags.mimeType === 'string' && flags.mimeType.trim())
      ? flags.mimeType.trim()
      : detectMimeTypeFromPathAndHeader(srcPath, filename);

  const attachmentId = makeId();
  const dir = getTaskAttachmentsDir(paths, taskId);
  ensureDir(dir);
  const destPath = getStoredAttachmentPath(paths, taskId, attachmentId, filename);
  const allowFallback = !(flags['no-fallback'] === true);

  if (fs.existsSync(destPath)) die('Attachment destination already exists');
  const result = copyOrLinkFile(srcPath, destPath, flags.mode, allowFallback);

  // Verify write/link
  const st = fs.statSync(destPath);
  if (!st.isFile() || st.size < 0) die('Attachment write verification failed');

  const meta = {
    id: attachmentId,
    filename: filename,
    mimeType: mimeType,
    size: st.size,
    addedAt: nowIso(),
  };
  return { meta: meta, storedPath: destPath, storageMode: result.mode, fallbackUsed: result.fallbackUsed };
}

function addAttachmentToTask(paths, taskId, meta) {
  var lastErr;
  for (var attempt = 0; attempt < 8; attempt++) {
    try {
      const ref = readTask(paths, taskId);
      const task = ref.task;
      const taskPath = ref.taskPath;
      const existing = Array.isArray(task.attachments) ? task.attachments : [];
      if (existing.some(function(a) { return a && a.id === meta.id; })) return;
      task.attachments = existing.concat([meta]);
      writeTask(taskPath, task);
      // Verify meta persisted (best-effort)
      const verify = readJson(taskPath, null);
      if (verify && Array.isArray(verify.attachments) && verify.attachments.some(function(a) { return a && a.id === meta.id; })) {
        return;
      }
      // Verification failed (concurrent overwrite) — retry
    } catch (e) {
      lastErr = e;
      if (attempt === 7) throw e;
    }
  }
  throw lastErr;
}

function addAttachmentToComment(paths, taskId, commentId, meta) {
  var lastErr;
  for (var attempt = 0; attempt < 8; attempt++) {
    try {
      const ref = readTask(paths, taskId);
      const task = ref.task;
      const taskPath = ref.taskPath;
      const comments = Array.isArray(task.comments) ? task.comments : [];
      const idx = comments.findIndex(function(c) { return c && String(c.id) === String(commentId); });
      if (idx < 0) die('Comment not found: ' + String(commentId));
      const comment = comments[idx];
      const existing = Array.isArray(comment.attachments) ? comment.attachments : [];
      if (!existing.some(function(a) { return a && a.id === meta.id; })) {
        comment.attachments = existing.concat([meta]);
      }
      // Persist update (single atomic write)
      task.comments = comments;
      writeTask(taskPath, task);

      // Verify
      const verify = readJson(taskPath, null);
      if (verify && Array.isArray(verify.comments)) {
        const vc = verify.comments.find(function(c) { return c && String(c.id) === String(commentId); });
        if (vc && Array.isArray(vc.attachments) && vc.attachments.some(function(a) { return a && a.id === meta.id; })) {
          return;
        }
      }
      // Retry on verification failure
    } catch (e) {
      lastErr = e;
      if (attempt === 7) throw e;
    }
  }
  throw lastErr;
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
  const safeTeam = assertSafePathSegment('team', teamName);
  const teamDir = path.join(claudeDir, 'teams', safeTeam);
  const tasksDir = path.join(claudeDir, 'tasks', safeTeam);
  const kanbanPath = path.join(teamDir, 'kanban-state.json');
  const processesPath = path.join(teamDir, 'processes.json');
  return { claudeDir, teamDir, tasksDir, kanbanPath, processesPath };
}

function inferLeadName(paths) {
  const config = readJson(path.join(paths.teamDir, 'config.json'), null);
  if (!config || !Array.isArray(config.members)) return 'team-lead';
  const lead = config.members.find(function (m) {
    return m.role && String(m.role).toLowerCase().includes('lead');
  });
  return lead ? String(lead.name) : (config.members[0] ? String(config.members[0].name) : 'team-lead');
}

function readTask(paths, taskId) {
  const taskPath = getTaskJsonPath(paths, taskId);
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

function applyWorkIntervalsForStatusTransition(task, prevStatus, nextStatus, now) {
  var wasInProgress = prevStatus === 'in_progress';
  var isInProgress = nextStatus === 'in_progress';
  var intervals = Array.isArray(task.workIntervals) ? task.workIntervals.slice() : [];
  var last = intervals.length ? intervals[intervals.length - 1] : null;

  if (!wasInProgress && isInProgress) {
    if (!last || typeof last.completedAt === 'string') {
      intervals.push({ startedAt: now });
    }
  } else if (wasInProgress && !isInProgress) {
    // Close the most recent open interval (if any).
    for (var i = intervals.length - 1; i >= 0; i--) {
      if (intervals[i] && typeof intervals[i].startedAt === 'string' && !intervals[i].completedAt) {
        intervals[i].completedAt = now;
        break;
      }
    }
  }

  if (intervals.length > 0) task.workIntervals = intervals;
  else delete task.workIntervals;
}

function appendStatusTransition(task, fromStatus, toStatus, timestamp, actor) {
  var entry = { from: fromStatus, to: toStatus, timestamp: timestamp };
  if (actor) entry.actor = actor;
  var history = Array.isArray(task.statusHistory) ? task.statusHistory.slice() : [];
  history.push(entry);
  task.statusHistory = history;
}

function setTaskStatus(paths, taskId, status, actor) {
  const normalized = normalizeStatus(status);
  if (!normalized) die('Invalid status: ' + String(status));
  const { taskPath, task } = readTask(paths, taskId);
  var prev = task.status;
  var now = nowIso();
  applyWorkIntervalsForStatusTransition(task, prev, normalized, now);
  appendStatusTransition(task, prev, normalized, now, actor);
  task.status = normalized;
  writeTask(taskPath, task);
}

function setTaskOwner(paths, taskId, owner) {
  const { taskPath, task } = readTask(paths, taskId);
  if (owner) {
    task.owner = owner;
  } else {
    delete task.owner;
  }
  writeTask(taskPath, task);
  return task;
}

function addTaskComment(paths, taskId, flags) {
  var text = typeof flags.text === 'string' ? flags.text.trim() : '';
  if (!text) die('Missing --text');
  var from = typeof flags.from === 'string' && flags.from.trim() ? flags.from.trim() : inferLeadName(paths);

  var ref;
  var task;
  var taskPath;
  var commentId;
  var comment;
  var existing;
  var lastErr;
  for (var attempt = 0; attempt < 8; attempt++) {
    try {
      ref = readTask(paths, taskId);
      task = ref.task;
      taskPath = ref.taskPath;

      if (task.needsClarification === 'lead' && from !== task.owner) {
        delete task.needsClarification;
      }

      existing = Array.isArray(task.comments) ? task.comments : [];
      commentId = makeId();
      comment = {
        id: commentId,
        author: from,
        text: text,
        type: 'regular',
        createdAt: nowIso(),
      };
      task.comments = existing.concat([comment]);
      writeTask(taskPath, task);

      return { commentId: commentId, taskId: String(taskId), subject: task.subject, owner: task.owner };
    } catch (e) {
      lastErr = e;
      if (attempt === 7) throw e;
    }
  }
  throw lastErr;
}

function setNeedsClarification(paths, taskId, value) {
  var allowed = { lead: true, user: true, clear: true };
  if (!allowed[value]) die('Invalid value: ' + value + '. Use: lead, user, clear');
  var ref = readTask(paths, taskId);
  if (value === 'clear') {
    delete ref.task.needsClarification;
  } else {
    ref.task.needsClarification = value;
  }
  writeTask(ref.taskPath, ref.task);
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

function parseIdList(value) {
  if (!value || value === true) return [];
  var ids = String(value).split(',').map(function(s) { return s.trim(); }).filter(Boolean);
  for (var k = 0; k < ids.length; k++) {
    if (!/^\d+$/.test(ids[k])) die('Invalid task ID in list: ' + ids[k]);
  }
  return ids;
}

function taskExists(paths, taskId) {
  try {
    fs.accessSync(getTaskJsonPath(paths, taskId), fs.constants.F_OK);
    return true;
  } catch (e) { return false; }
}

function readTaskObject(paths, taskId) {
  var taskPath = getTaskJsonPath(paths, taskId);
  var t = readJson(taskPath, null);
  if (!t) die('Task not found: #' + taskId);
  return { task: t, taskPath: taskPath };
}

function wouldCreateBlockCycle(paths, sourceId, targetId) {
  var visited = {};
  var stack = [String(targetId)];
  while (stack.length > 0) {
    var current = stack.pop();
    if (current === String(sourceId)) return true;
    if (visited[current]) continue;
    visited[current] = true;
    try {
      if (!isSafePathSegment(current)) continue;
      var t = readJson(getTaskJsonPath(paths, current), null);
      if (t && Array.isArray(t.blockedBy)) {
        for (var i = 0; i < t.blockedBy.length; i++) stack.push(String(t.blockedBy[i]));
      }
    } catch (e) { /* skip */ }
  }
  return false;
}

function linkTasks(paths, taskId, targetId, type) {
  var id = String(taskId), target = String(targetId);
  if (id === target) die('Cannot link a task to itself');
  if (!taskExists(paths, id)) die('Task not found: #' + id);
  if (!taskExists(paths, target)) die('Task not found: #' + target);

  if (type === 'blocked-by') {
    if (wouldCreateBlockCycle(paths, id, target))
      die('Circular dependency: #' + target + ' already depends on #' + id);
    var refA = readTaskObject(paths, id);
    var bb = Array.isArray(refA.task.blockedBy) ? refA.task.blockedBy : [];
    if (!bb.includes(target)) { refA.task.blockedBy = bb.concat([target]); atomicWrite(refA.taskPath, JSON.stringify(refA.task, null, 2)); }
    var refB = readTaskObject(paths, target);
    var bl = Array.isArray(refB.task.blocks) ? refB.task.blocks : [];
    if (!bl.includes(id)) { refB.task.blocks = bl.concat([id]); atomicWrite(refB.taskPath, JSON.stringify(refB.task, null, 2)); }
  } else if (type === 'blocks') {
    linkTasks(paths, target, id, 'blocked-by');
    return;
  } else if (type === 'related') {
    var rA = readTaskObject(paths, id);
    var relA = Array.isArray(rA.task.related) ? rA.task.related : [];
    if (!relA.includes(target)) { rA.task.related = relA.concat([target]); atomicWrite(rA.taskPath, JSON.stringify(rA.task, null, 2)); }
    var rB = readTaskObject(paths, target);
    var relB = Array.isArray(rB.task.related) ? rB.task.related : [];
    if (!relB.includes(id)) { rB.task.related = relB.concat([id]); atomicWrite(rB.taskPath, JSON.stringify(rB.task, null, 2)); }
  }
}

function unlinkTasks(paths, taskId, targetId, type) {
  var id = String(taskId), target = String(targetId);
  if (!taskExists(paths, id)) die('Task not found: #' + id);

  if (type === 'blocked-by') {
    var refA = readTaskObject(paths, id);
    refA.task.blockedBy = (Array.isArray(refA.task.blockedBy) ? refA.task.blockedBy : []).filter(function(x) { return x !== target; });
    atomicWrite(refA.taskPath, JSON.stringify(refA.task, null, 2));
    if (taskExists(paths, target)) {
      var refB = readTaskObject(paths, target);
      refB.task.blocks = (Array.isArray(refB.task.blocks) ? refB.task.blocks : []).filter(function(x) { return x !== id; });
      atomicWrite(refB.taskPath, JSON.stringify(refB.task, null, 2));
    }
  } else if (type === 'blocks') {
    unlinkTasks(paths, target, id, 'blocked-by');
    return;
  } else if (type === 'related') {
    var rA = readTaskObject(paths, id);
    rA.task.related = (Array.isArray(rA.task.related) ? rA.task.related : []).filter(function(x) { return x !== target; });
    atomicWrite(rA.taskPath, JSON.stringify(rA.task, null, 2));
    if (taskExists(paths, target)) {
      var rB = readTaskObject(paths, target);
      rB.task.related = (Array.isArray(rB.task.related) ? rB.task.related : []).filter(function(x) { return x !== id; });
      atomicWrite(rB.taskPath, JSON.stringify(rB.task, null, 2));
    }
  }
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
  const activeForm =
    typeof flags.activeForm === 'string'
      ? flags.activeForm
      : typeof flags['active-form'] === 'string'
        ? flags['active-form']
        : undefined;

  var blockedByIds = parseIdList(flags['blocked-by']);
  var relatedIds = parseIdList(flags.related);
  // Default status rule:
  // - explicit --status always wins
  // - tasks with dependencies should start as pending, even if assigned (owner)
  // - otherwise, assigned tasks default to in_progress, unassigned to pending
  const status =
    normalizeStatus(explicitStatus) ||
    (blockedByIds.length > 0 ? 'pending' : owner ? 'in_progress' : 'pending');
  for (var v = 0; v < blockedByIds.length; v++) { if (!taskExists(paths, blockedByIds[v])) die('Blocked-by task not found: #' + blockedByIds[v]); }
  for (var w = 0; w < relatedIds.length; w++) { if (!taskExists(paths, relatedIds[w])) die('Related task not found: #' + relatedIds[w]); }

  ensureDir(paths.tasksDir);
  const from = typeof flags.from === 'string' && flags.from.trim() ? flags.from.trim() : undefined;
  let nextId;
  let task;
  let taskPath;
  while (true) {
    nextId = getNextTaskId(paths);
    taskPath = getTaskJsonPath(paths, nextId);
    var createdAt = nowIso();
    task = {
      id: nextId,
      subject,
      description: String(description || subject),
      activeForm: activeForm ? String(activeForm) : undefined,
      owner,
      createdBy: from,
      status,
      createdAt: createdAt,
      workIntervals: status === 'in_progress' ? [{ startedAt: createdAt }] : undefined,
      statusHistory: [{ from: null, to: status, timestamp: createdAt, actor: from }],
      blocks: [],
      blockedBy: blockedByIds,
      related: relatedIds.length > 0 ? relatedIds : undefined,
    };
    try {
      const fd = fs.openSync(taskPath, 'wx');
      fs.closeSync(fd);
      atomicWrite(taskPath, JSON.stringify(task, null, 2));
      const verify = readJson(taskPath, null);
      if (!verify) die('Task write verification failed');
      break;
    } catch (e) {
      if (e && e.code === 'EEXIST') continue;
      throw e;
    }
  }
  updateHighwatermark(paths, nextId);

  // Set reverse links for blockedBy (target.blocks += nextId)
  for (var bi = 0; bi < blockedByIds.length; bi++) {
    var dep = readTaskObject(paths, blockedByIds[bi]);
    var depBl = Array.isArray(dep.task.blocks) ? dep.task.blocks : [];
    if (!depBl.includes(nextId)) { dep.task.blocks = depBl.concat([nextId]); atomicWrite(dep.taskPath, JSON.stringify(dep.task, null, 2)); }
  }
  // Set reverse links for related (bidirectional)
  for (var ri = 0; ri < relatedIds.length; ri++) {
    var rel = readTaskObject(paths, relatedIds[ri]);
    var relL = Array.isArray(rel.task.related) ? rel.task.related : [];
    if (!relL.includes(nextId)) { rel.task.related = relL.concat([nextId]); atomicWrite(rel.taskPath, JSON.stringify(rel.task, null, 2)); }
  }

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
  const from = typeof flags.from === 'string' && flags.from.trim() ? flags.from.trim() : inferLeadName(paths);

  const safeTo = assertSafePathSegment('to', to);
  const inboxPath = path.join(paths.teamDir, 'inboxes', safeTo + '.json');
  ensureDir(path.dirname(inboxPath));

  const messageId = makeId();
  const payload = {
    from,
    to,
    text,
    timestamp: nowIso(),
    read: false,
    summary,
    messageId,
  };
  if (flags.source) payload.source = flags.source;

  var lastErr;
  for (var attempt = 0; attempt < 8; attempt++) {
    try {
      var existing = readJson(inboxPath, []);
      var list = Array.isArray(existing) ? existing : [];
      list.push(payload);
      atomicWrite(inboxPath, JSON.stringify(list, null, 2));
      var verify = readJson(inboxPath, []);
      if (Array.isArray(verify) && verify.some(function (m) { return m && m.messageId === messageId; })) {
        return { deliveredToInbox: true, messageId: messageId };
      }
      // Verification failed (concurrent write overwrote us) — retry
    } catch (e) {
      lastErr = e;
      if (attempt === 7) throw e;
    }
  }
  // If all retries exhausted without verification success, die
  die('Inbox write verification failed after retries' + (lastErr ? ': ' + formatError(lastErr) : ''));
}

function reviewApprove(paths, teamName, taskId, flags) {
  setKanbanColumn(paths, teamName, taskId, 'approved');
  const { taskPath, task } = readTask(paths, taskId);
  const from = typeof flags.from === 'string' && flags.from.trim() ? flags.from.trim() : inferLeadName(paths);
  const note = typeof flags.note === 'string' ? flags.note.trim() : '';

  // Record review comment in task.comments
  var existing = Array.isArray(task.comments) ? task.comments : [];
  var reviewCommentId = makeId();
  task.comments = existing.concat([{
    id: reviewCommentId,
    author: from,
    text: note || 'Approved',
    type: 'review_approved',
    createdAt: nowIso(),
  }]);
  writeTask(taskPath, task);

  const notify = flags.notify === true || flags['notify-owner'] === true;
  if (!notify || !task.owner) return;
  const inboxText = note
    ? 'Task #' + String(taskId) + ' approved.\n\n' + note
    : 'Task #' + String(taskId) + ' approved.';
  sendInboxMessage(paths, teamName, {
    to: task.owner,
    text: inboxText,
    summary: 'Approved #' + String(taskId),
    from,
    source: 'system_notification',
  });
}

function reviewRequestChanges(paths, teamName, taskId, flags) {
  const comment = typeof flags.comment === 'string' ? flags.comment.trim() : '';
  const { taskPath, task } = readTask(paths, taskId);
  if (!task.owner) die('No owner found for task ' + String(taskId));

  const from = typeof flags.from === 'string' && flags.from.trim() ? flags.from.trim() : inferLeadName(paths);

  clearKanban(paths, teamName, taskId);
  var now = nowIso();
  var prevStatus = task.status;
  applyWorkIntervalsForStatusTransition(task, prevStatus, 'in_progress', now);
  appendStatusTransition(task, prevStatus, 'in_progress', now, from);
  task.status = 'in_progress';

  // Record review comment in task.comments
  var existing = Array.isArray(task.comments) ? task.comments : [];
  var reviewCommentId = makeId();
  task.comments = existing.concat([{
    id: reviewCommentId,
    author: from,
    text: comment || 'Reviewer requested changes.',
    type: 'review_request',
    createdAt: now,
  }]);

  writeTask(taskPath, task);

  const inboxText =
    'Task #' +
    String(taskId) +
    ' needs fixes.\n\n' +
    (comment || 'Reviewer requested changes.') +
    '\n\n' +
    'Please fix and mark it as completed when ready.';
  sendInboxMessage(paths, teamName, {
    to: task.owner,
    text: inboxText,
    summary: 'Fix request for #' + String(taskId),
    from,
    source: 'system_notification',
  });
}

function readProcessesSafe(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (err && err.code === 'EPERM') return true;
    return false;
  }
}

function processRegister(paths, flags) {
  const pid = Number(flags.pid);
  if (!Number.isInteger(pid) || pid <= 0) die('Invalid --pid (must be > 0)');
  const label = typeof flags.label === 'string' ? flags.label.trim() : '';
  if (!label) die('Missing --label');

  const rawPort = flags.port != null ? Number(flags.port) : undefined;
  const port = rawPort != null && Number.isInteger(rawPort) && rawPort >= 1 && rawPort <= 65535 ? rawPort : undefined;
  const url = typeof flags.url === 'string' && flags.url.trim() ? flags.url.trim() : undefined;

  const claudeProcessId = typeof flags['claude-process-id'] === 'string' ? flags['claude-process-id'].trim() : undefined;
  const from = typeof flags.from === 'string' && flags.from.trim() ? flags.from.trim() : undefined;
  const command = typeof flags.command === 'string' ? flags.command.trim() : undefined;

  const list = readProcessesSafe(paths.processesPath);
  const existingIdx = list.findIndex(function (p) { return p.pid === pid; });

  const entry = {
    id: existingIdx >= 0 ? list[existingIdx].id : makeId(),
    port: port,
    url: url,
    label: label,
    pid: pid,
    claudeProcessId: claudeProcessId,
    registeredBy: from,
    command: command,
    registeredAt: existingIdx >= 0 ? list[existingIdx].registeredAt : nowIso(),
  };

  if (existingIdx >= 0) {
    list[existingIdx] = entry;
  } else {
    list.push(entry);
  }
  atomicWrite(paths.processesPath, JSON.stringify(list, null, 2));
  var portStr = port ? ' port=' + String(port) : '';
  process.stdout.write('OK process registered pid=' + String(pid) + portStr + '\n');
}

function processUnregister(paths, flags) {
  const list = readProcessesSafe(paths.processesPath);
  const pid = flags.pid ? Number(flags.pid) : undefined;
  const id = typeof flags.id === 'string' ? flags.id.trim() : undefined;
  if (!pid && !id) die('Missing --pid or --id');

  const idx = list.findIndex(function (p) {
    if (pid) return p.pid === pid;
    return p.id === id;
  });
  if (idx < 0) die('Process not found');
  const removed = list.splice(idx, 1)[0];
  atomicWrite(paths.processesPath, JSON.stringify(list, null, 2));
  process.stdout.write('OK process unregistered pid=' + String(removed.pid) + '\n');
}

function processList(paths) {
  const list = readProcessesSafe(paths.processesPath);
  const result = list.map(function (p) {
    return Object.assign({}, p, { alive: isProcessAlive(p.pid) });
  });
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

function taskBriefing(paths, teamName, flags) {
  var forMember = typeof flags['for'] === 'string' ? flags['for'].trim() : '';
  if (!forMember) die('Missing --for <member-name>');

  var kanban = readKanbanState(paths, teamName);
  var ids = listTaskIds(paths.tasksDir);

  var allTasks = [];
  for (var i = 0; i < ids.length; i++) {
    try {
      if (!isSafePathSegment(ids[i])) continue;
      var taskPath = getTaskJsonPath(paths, ids[i]);
      var t = readJson(taskPath, null);
      if (t && !String(t.id).startsWith('_internal') && !(t.metadata && t.metadata._internal === true)) {
        try { t._mtime = fs.statSync(taskPath).mtime.toISOString(); } catch (_e) { t._mtime = ''; }
        allTasks.push(t);
      }
    } catch (e) { /* skip unreadable */ }
  }

  function getEffectiveColumn(task) {
    var ks = kanban.tasks[String(task.id)];
    if (ks) return ks.column;
    if (task.status === 'pending') return 'todo';
    if (task.status === 'in_progress') return 'in_progress';
    if (task.status === 'completed') return 'done';
    return task.status;
  }

  var relevant = allTasks.filter(function (t) {
    var col = getEffectiveColumn(t);
    return col !== 'approved' && t.status !== 'deleted';
  });

  var myTasks = { todo: [], in_progress: [], done: [], review: [] };
  var otherTasks = { todo: [], in_progress: [], done: [], review: [] };

  for (var j = 0; j < relevant.length; j++) {
    var task = relevant[j];
    var col = getEffectiveColumn(task);
    var bucket = (task.owner === forMember) ? myTasks : otherTasks;
    if (col === 'todo') bucket.todo.push(task);
    else if (col === 'in_progress') bucket.in_progress.push(task);
    else if (col === 'done') bucket.done.push(task);
    else if (col === 'review') bucket.review.push(task);
  }

  function sortByMtime(arr) {
    return arr.sort(function (a, b) {
      var da = a._mtime || '';
      var db = b._mtime || '';
      return da < db ? 1 : da > db ? -1 : 0;
    });
  }
  myTasks.done = sortByMtime(myTasks.done).slice(0, 15);
  otherTasks.done = sortByMtime(otherTasks.done).slice(0, 15);

  var lines = [];
  lines.push('=== Task Briefing for ' + forMember + ' ===');
  lines.push('');

  function formatTask(t) {
    var parts = [];
    parts.push('#' + t.id + ' [' + getEffectiveColumn(t).toUpperCase() + '] ' + t.subject);
    if (t.owner) parts.push('  Owner: ' + t.owner);
    if (t.description && t.description !== t.subject) {
      parts.push('  Description: ' + t.description.slice(0, 500));
    }
    if (t.blocks && t.blocks.length > 0) {
      parts.push('  Blocks: ' + t.blocks.map(function(id) { return '#' + id; }).join(', '));
    }
    if (t.blockedBy && t.blockedBy.length > 0) {
      parts.push('  Blocked by: ' + t.blockedBy.map(function(id) { return '#' + id; }).join(', '));
    }
    if (t.related && t.related.length > 0) {
      parts.push('  Related: ' + t.related.map(function(id) { return '#' + id; }).join(', '));
    }
    if (t.needsClarification) {
      parts.push('  *** NEEDS CLARIFICATION: from ' + t.needsClarification.toUpperCase() + ' ***');
    }
    if (Array.isArray(t.comments) && t.comments.length > 0) {
      parts.push('  Comments (' + t.comments.length + '):');
      for (var c = 0; c < t.comments.length; c++) {
        var cm = t.comments[c];
        var ts = cm.createdAt ? ' (' + cm.createdAt + ')' : '';
        parts.push('    [' + (cm.author || '?') + ts + '] ' + (cm.text || '').slice(0, 300));
      }
    }
    return parts.join('\n');
  }

  function renderSection(label, tasks) {
    if (tasks.length === 0) return;
    lines.push('--- ' + label + ' (' + tasks.length + ') ---');
    for (var k = 0; k < tasks.length; k++) {
      lines.push(formatTask(tasks[k]));
      lines.push('');
    }
  }

  lines.push('== YOUR TASKS ==');
  renderSection('IN PROGRESS', myTasks.in_progress);
  renderSection('TODO', myTasks.todo);
  renderSection('REVIEW', myTasks.review);
  renderSection('DONE (recent)', myTasks.done);

  if (myTasks.in_progress.length + myTasks.todo.length + myTasks.review.length + myTasks.done.length === 0) {
    lines.push('(no tasks assigned to you)');
    lines.push('');
  }

  lines.push('== TEAM BOARD (others) ==');
  renderSection('IN PROGRESS', otherTasks.in_progress);
  renderSection('TODO', otherTasks.todo);
  renderSection('REVIEW', otherTasks.review);
  renderSection('DONE (recent)', otherTasks.done);

  if (otherTasks.in_progress.length + otherTasks.todo.length + otherTasks.review.length + otherTasks.done.length === 0) {
    lines.push('(no other tasks on the board)');
    lines.push('');
  }

  process.stdout.write(lines.join('\n') + '\n');
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
      '  node teamctl.js task create --subject "..." [--description "..."] [--prompt "..."] [--owner "member"] [--blocked-by 2,3] [--related 5] [--status ...] [--notify --from "member"] [--team <team>]',
      '  node teamctl.js task link <id> --blocked-by <targetId> [--team <team>]',
      '  node teamctl.js task link <id> --blocks <targetId> [--team <team>]',
      '  node teamctl.js task link <id> --related <targetId> [--team <team>]',
      '  node teamctl.js task unlink <id> --blocked-by <targetId> [--team <team>]',
      '  node teamctl.js task unlink <id> --blocks <targetId> [--team <team>]',
      '  node teamctl.js task unlink <id> --related <targetId> [--team <team>]',
      '  node teamctl.js task set-owner <id> <member|clear> [--notify --from "member"] [--team <team>]',
      '  node teamctl.js task comment <id> --text "..." [--from "member"] [--team <team>]',
      '  node teamctl.js task attach <id> --file <path> [--mode copy|link] [--filename <name>] [--mime-type <type>] [--no-fallback] [--team <team>]',
      '  node teamctl.js task comment-attach <id> <commentId> --file <path> [--mode copy|link] [--filename <name>] [--mime-type <type>] [--no-fallback] [--team <team>]',
      '  node teamctl.js task set-clarification <id> <lead|user|clear> [--from "member"] [--team <team>]',
      '  node teamctl.js task briefing --for <member-name> [--team <team>]',
      '  node teamctl.js kanban set-column <id> <review|approved> [--team <team>]',
      '  node teamctl.js kanban clear <id> [--team <team>]',
      '  node teamctl.js review approve <id> [--notify-owner --from "member" --note "..."] [--team <team>]',
      '  node teamctl.js review request-changes <id> --comment "..." [--from "member"] [--team <team>]',
      '  node teamctl.js message send --to "member" --text "..." [--summary "..."] [--from "member"] [--team <team>]',
      '  node teamctl.js process register --pid <pid> --label <label> [--port <port>] [--url <url>] [--claude-process-id <id>] [--from <member>] [--command <cmd>] [--team <team>]',
      '  node teamctl.js process unregister --pid <pid> [--team <team>]',
      '  node teamctl.js process unregister --id <uuid> [--team <team>]',
      '  node teamctl.js process list [--team <team>]',
      '',
      'Options:',
      '  --team <name>           Team name (if not under ~/.claude/teams/<team>/tools)',
      '  --claude-dir <path>     Override ~/.claude location',
      '  --mode <copy|link>      For attachments: copy into storage (default) or try hardlink to avoid duplication',
      '  --no-fallback           For --mode link: fail instead of falling back to copy',
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
  var actor = typeof args.flags.from === 'string' && args.flags.from.trim()
    ? args.flags.from.trim()
    : inferLeadName(paths);

  if (domain === 'task') {
    if (action === 'set-status') {
      const id = rest[0] || args.flags.id;
      const status = rest[1] || args.flags.status;
      if (!id || !status) die('Usage: task set-status <id> <status>');
      setTaskStatus(paths, String(id), status, actor);
      process.stdout.write('OK task #' + String(id) + ' status=' + String(status) + '\n');
      return;
    }
    if (action === 'complete' || action === 'done') {
      const id = rest[0] || args.flags.id;
      if (!id) die('Usage: task complete <id>');
      setTaskStatus(paths, String(id), 'completed', actor);
      process.stdout.write('OK task #' + String(id) + ' status=completed\n');
      return;
    }
    if (action === 'start') {
      const id = rest[0] || args.flags.id;
      if (!id) die('Usage: task start <id>');
      setTaskStatus(paths, String(id), 'in_progress', actor);
      process.stdout.write('OK task #' + String(id) + ' status=in_progress\n');
      return;
    }
    if (action === 'create') {
      const task = createTask(paths, args.flags);
      const notify = args.flags.notify === true || args.flags['notify-owner'] === true;
      if (notify && task.owner) {
        const from =
          typeof args.flags.from === 'string' && args.flags.from.trim() ? args.flags.from.trim() : inferLeadName(paths);
        // Skip inbox notification when lead assigns a task to themselves (solo teams)
        if (task.owner.toLowerCase() !== from.toLowerCase()) {
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
            '\n' +
              wrapAgentBlock(
                [
                  'Update task status using:',
                  'node "' + __filename + '" --team ' + String(teamName) + ' task start ' + String(task.id),
                  'node "' + __filename + '" --team ' + String(teamName) + ' task complete ' + String(task.id),
                ].join('\n')
              )
          );
          sendInboxMessage(paths, teamName, {
            to: task.owner,
            text: parts.join('\n'),
            summary: 'New task #' + String(task.id) + ' assigned',
            from,
            source: 'system_notification',
          });
        }
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
          tasks.push(readJson(getTaskJsonPath(paths, id), null));
        } catch {}
      }
      process.stdout.write(JSON.stringify(tasks.filter(Boolean), null, 2) + '\n');
      return;
    }
    if (action === 'comment') {
      const id = rest[0] || args.flags.id;
      if (!id) die('Usage: task comment <id> --text "..."');
      const result = addTaskComment(paths, String(id), args.flags);
      const from = typeof args.flags.from === 'string' && args.flags.from.trim() ? args.flags.from.trim() : inferLeadName(paths);
      // Notify task owner via inbox — but SKIP self-notification to prevent loop
      if (result.owner && result.owner !== from) {
        try {
          sendInboxMessage(paths, teamName, {
            to: result.owner,
            text: 'Comment on task #' + String(result.taskId) + ' "' + String(result.subject) + '":\n\n' + (typeof args.flags.text === 'string' ? args.flags.text.trim() : ''),
            summary: 'Comment on #' + String(result.taskId),
            from: from,
            source: 'system_notification',
          });
        } catch (e) { /* best-effort */ }
      }
      process.stdout.write('OK comment added to task #' + String(id) + '\n');
      return;
    }
    if (action === 'attach') {
      const id = rest[0] || args.flags.id;
      if (!id) die('Usage: task attach <id> --file <path>');
      // Save file to storage first, then update task metadata
      const saved = saveTaskAttachmentFile(paths, String(id), args.flags);
      try {
        addAttachmentToTask(paths, String(id), saved.meta);
      } catch (e) {
        // Best-effort cleanup of orphaned file on failure
        try { fs.unlinkSync(saved.storedPath); } catch { /* ignore */ }
        throw e;
      }
      if (saved.fallbackUsed) {
        process.stderr.write('WARN: link failed; fell back to copy\n');
      }
      process.stdout.write(JSON.stringify(saved.meta, null, 2) + '\n');
      return;
    }
    if (action === 'comment-attach') {
      const id = rest[0] || args.flags.id;
      const commentId = rest[1] || args.flags['comment-id'] || args.flags.commentId;
      if (!id || !commentId) die('Usage: task comment-attach <id> <commentId> --file <path>');
      const saved = saveTaskAttachmentFile(paths, String(id), args.flags);
      try {
        addAttachmentToComment(paths, String(id), String(commentId), saved.meta);
      } catch (e) {
        // Best-effort cleanup of orphaned file on failure
        try { fs.unlinkSync(saved.storedPath); } catch { /* ignore */ }
        throw e;
      }
      if (saved.fallbackUsed) {
        process.stderr.write('WARN: link failed; fell back to copy\n');
      }
      process.stdout.write(JSON.stringify(saved.meta, null, 2) + '\n');
      return;
    }
    if (action === 'set-clarification') {
      const id = rest[0] || args.flags.id;
      const val = rest[1] || args.flags.value;
      if (!id || !val) die('Usage: task set-clarification <id> <lead|user|clear>');
      setNeedsClarification(paths, String(id), String(val));
      process.stdout.write('OK task #' + String(id) + ' needsClarification=' + (val === 'clear' ? 'cleared' : String(val)) + '\n');
      return;
    }
    if (action === 'set-owner' || action === 'assign') {
      const id = rest[0] || args.flags.id;
      const owner = rest[1] || args.flags.owner;
      if (!id) die('Usage: task set-owner <id> <member|clear>');
      if (!owner) die('Usage: task set-owner <id> <member|clear>');
      const effectiveOwner = owner === 'clear' || owner === 'none' ? null : String(owner);
      const task = setTaskOwner(paths, String(id), effectiveOwner);
      process.stdout.write('OK task #' + String(id) + ' owner=' + (effectiveOwner || 'cleared') + '\n');
      const notify = args.flags.notify === true;
      if (notify && effectiveOwner) {
        const from = typeof args.flags.from === 'string' && args.flags.from.trim() ? args.flags.from.trim() : inferLeadName(paths);
        const parts = ['Task assigned to you: #' + String(task.id) + ' "' + String(task.subject) + '".'];
        if (task.description && task.description !== task.subject) {
          parts.push('\nDescription:\n' + String(task.description).slice(0, 500));
        }
        parts.push(
          '\n' +
            wrapAgentBlock(
              [
                'Update task status using:',
                'node "' + __filename + '" --team ' + String(teamName) + ' task start ' + String(task.id),
                'node "' + __filename + '" --team ' + String(teamName) + ' task complete ' + String(task.id),
              ].join('\n')
            )
        );
        sendInboxMessage(paths, teamName, {
          to: effectiveOwner,
          text: parts.join('\n'),
          summary: 'Task #' + String(task.id) + ' assigned',
          from,
          source: 'system_notification',
        });
      }
      return;
    }
    if (action === 'briefing') {
      taskBriefing(paths, teamName, args.flags);
      return;
    }
    if (action === 'link') {
      var linkId = rest[0] || args.flags.id;
      if (!linkId) die('Usage: task link <id> --blocked-by|--blocks|--related <targetId>');
      var linkBbF = args.flags['blocked-by'], linkBlF = args.flags.blocks, linkRelF = args.flags.related;
      var linkCnt = (linkBbF ? 1 : 0) + (linkBlF ? 1 : 0) + (linkRelF ? 1 : 0);
      if (linkCnt !== 1) die('Specify exactly one: --blocked-by, --blocks, or --related');
      var linkTp = linkBbF ? 'blocked-by' : linkBlF ? 'blocks' : 'related';
      var linkTv = linkBbF || linkBlF || linkRelF;
      linkTasks(paths, String(linkId), String(linkTv), linkTp);
      process.stdout.write('OK task #' + linkId + ' ' + linkTp + ' #' + linkTv + '\n');
      return;
    }
    if (action === 'unlink') {
      var unlinkId = rest[0] || args.flags.id;
      if (!unlinkId) die('Usage: task unlink <id> --blocked-by|--blocks|--related <targetId>');
      var unlinkBbF = args.flags['blocked-by'], unlinkBlF = args.flags.blocks, unlinkRelF = args.flags.related;
      var unlinkCnt = (unlinkBbF ? 1 : 0) + (unlinkBlF ? 1 : 0) + (unlinkRelF ? 1 : 0);
      if (unlinkCnt !== 1) die('Specify exactly one: --blocked-by, --blocks, or --related');
      var unlinkTp = unlinkBbF ? 'blocked-by' : unlinkBlF ? 'blocks' : 'related';
      var unlinkTv = unlinkBbF || unlinkBlF || unlinkRelF;
      unlinkTasks(paths, String(unlinkId), String(unlinkTv), unlinkTp);
      process.stdout.write('OK task #' + unlinkId + ' unlinked ' + unlinkTp + ' #' + unlinkTv + '\n');
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
      // Strip source from agent flags — only internal callers may set it
      var msgFlags = Object.assign({}, args.flags);
      delete msgFlags.source;
      const result = sendInboxMessage(paths, teamName, msgFlags);
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
      return;
    }
    die('Unknown message action: ' + String(action));
  }

  if (domain === 'process') {
    if (action === 'register') {
      processRegister(paths, args.flags);
      return;
    }
    if (action === 'unregister' || action === 'remove') {
      processUnregister(paths, args.flags);
      return;
    }
    if (action === 'list') {
      processList(paths);
      return;
    }
    die('Unknown process action: ' + String(action));
  }

  die('Unknown domain: ' + String(domain) + '. Available domains: task, kanban, review, message, process. Run with --help for usage.');
}

const legacyTeamctl = {
  parseArgs,
  getPaths,
  inferLeadName,
  readTask,
  listTaskIds,
  createTask,
  setTaskStatus,
  setTaskOwner,
  addTaskComment,
  saveTaskAttachmentFile,
  addAttachmentToTask,
  addAttachmentToComment,
  setNeedsClarification,
  linkTasks,
  unlinkTasks,
  taskBriefing,
  readKanbanState,
  writeKanbanState,
  setKanbanColumn,
  clearKanban,
  sendInboxMessage,
  reviewApprove,
  reviewRequestChanges,
  readProcessesSafe,
  isProcessAlive,
  processRegister,
  processUnregister,
  processList,
  printHelp,
  main,
};

if (require.main === module) {
  main().catch((err) => {
    die(formatError(err));
  });
} else {
  module.exports = legacyTeamctl;
}
