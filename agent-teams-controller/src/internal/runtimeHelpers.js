const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const TASK_ATTACHMENTS_DIR = 'task-attachments';
const MAX_TASK_ATTACHMENT_BYTES = 20 * 1024 * 1024;

function nowIso() {
  return new Date().toISOString();
}

function makeId() {
  return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJson(filePath, fallbackValue) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return fallbackValue;
    }
    throw error;
  }
}

function isSafePathSegment(value) {
  const normalized = String(value == null ? '' : value);
  if (normalized.length === 0 || normalized.trim().length === 0) return false;
  if (normalized === '.' || normalized === '..') return false;
  if (normalized.includes('/') || normalized.includes('\\')) return false;
  if (normalized.includes('..')) return false;
  if (normalized.includes('\0')) return false;
  return true;
}

function assertSafePathSegment(label, value) {
  const normalized = String(value == null ? '' : value);
  if (!isSafePathSegment(normalized)) {
    throw new Error(`Invalid ${String(label)}`);
  }
  return normalized;
}

function getHomeDir() {
  if (process.env.HOME) return process.env.HOME;
  if (process.env.USERPROFILE) return process.env.USERPROFILE;
  if (process.env.HOMEDRIVE && process.env.HOMEPATH) {
    return process.env.HOMEDRIVE + process.env.HOMEPATH;
  }
  try {
    return require('os').homedir();
  } catch {
    return '';
  }
}

function getClaudeDir(flags) {
  const explicit =
    (typeof flags['claude-dir'] === 'string' && flags['claude-dir']) ||
    (typeof flags.claudeDir === 'string' && flags.claudeDir) ||
    (typeof flags.claude_path === 'string' && flags.claude_path) ||
    '';
  if (explicit) {
    return path.resolve(explicit);
  }
  const home = getHomeDir();
  if (!home) {
    throw new Error('HOME/USERPROFILE is not set');
  }
  return path.join(home, '.claude');
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
  const config = readTeamConfig(paths);
  if (!config || !Array.isArray(config.members)) {
    return 'team-lead';
  }
  const lead = config.members.find(
    (member) => member && member.role && String(member.role).toLowerCase().includes('lead')
  );
  if (lead) {
    return String(lead.name);
  }
  return config.members[0] ? String(config.members[0].name) : 'team-lead';
}

function readTeamConfig(paths) {
  return readJson(path.join(paths.teamDir, 'config.json'), null);
}

function resolveLeadSessionId(paths) {
  const config = readTeamConfig(paths);
  return config && typeof config.leadSessionId === 'string' && config.leadSessionId.trim()
    ? config.leadSessionId.trim()
    : undefined;
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error && error.code === 'EPERM') {
      return true;
    }
    return false;
  }
}

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
    const buffer = Buffer.alloc(maxBytes);
    const bytes = fs.readSync(fd, buffer, 0, maxBytes, 0);
    return buffer.slice(0, bytes);
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      // ignore
    }
  }
}

function startsWithBytes(buffer, bytes) {
  if (!buffer || buffer.length < bytes.length) return false;
  for (let i = 0; i < bytes.length; i += 1) {
    if (buffer[i] !== bytes[i]) return false;
  }
  return true;
}

function detectMimeTypeFromPathAndHeader(filePath, filename) {
  const name = String(filename || '').toLowerCase();
  const ext = path.extname(name);

  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.pdf') return 'application/pdf';
  if (ext === '.txt') return 'text/plain';
  if (ext === '.md') return 'text/markdown';
  if (ext === '.json') return 'application/json';
  if (ext === '.zip') return 'application/zip';

  let header;
  try {
    header = readFileHeader(filePath, 16);
  } catch {
    return 'application/octet-stream';
  }

  if (startsWithBytes(header, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWithBytes(header, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (header.length >= 6) {
    const signature6 = header.slice(0, 6).toString('ascii');
    if (signature6 === 'GIF87a' || signature6 === 'GIF89a') return 'image/gif';
  }
  if (header.length >= 12) {
    const riff = header.slice(0, 4).toString('ascii');
    const webp = header.slice(8, 12).toString('ascii');
    if (riff === 'RIFF' && webp === 'WEBP') return 'image/webp';
  }
  if (header.length >= 5 && header.slice(0, 5).toString('ascii') === '%PDF-') {
    return 'application/pdf';
  }
  if (startsWithBytes(header, [0x50, 0x4b, 0x03, 0x04])) return 'application/zip';

  return 'application/octet-stream';
}

function getTaskAttachmentsDir(paths, taskId) {
  const safeTaskId = assertSafePathSegment('taskId', taskId);
  return path.join(paths.teamDir, TASK_ATTACHMENTS_DIR, safeTaskId);
}

function getStoredAttachmentPath(paths, taskId, attachmentId, filename) {
  const safeFilename = sanitizeFilename(filename);
  return path.join(
    getTaskAttachmentsDir(paths, taskId),
    `${String(attachmentId)}--${safeFilename}`
  );
}

function ensureSourceFileReadable(srcPath) {
  const stats = fs.statSync(srcPath);
  if (!stats.isFile()) {
    throw new Error(`Not a file: ${String(srcPath)}`);
  }
  if (stats.size > MAX_TASK_ATTACHMENT_BYTES) {
    throw new Error(
      `Attachment too large: ${(stats.size / (1024 * 1024)).toFixed(1)} MB (max ${String(
        MAX_TASK_ATTACHMENT_BYTES / (1024 * 1024)
      )} MB)`
    );
  }
  return stats;
}

function copyOrLinkFile(srcPath, destPath, mode, allowFallback) {
  const normalizedMode = String(mode || 'copy').toLowerCase();
  if (normalizedMode === 'link') {
    try {
      fs.linkSync(srcPath, destPath);
      return { mode: 'link', fallbackUsed: false };
    } catch (error) {
      if (!allowFallback) throw error;
      try {
        fs.copyFileSync(srcPath, destPath);
        return { mode: 'copy', fallbackUsed: true };
      } catch (copyError) {
        throw copyError || error;
      }
    }
  }

  fs.copyFileSync(srcPath, destPath);
  return { mode: 'copy', fallbackUsed: false };
}

function saveTaskAttachmentFile(paths, taskId, flags) {
  const rawFile =
    (typeof flags.file === 'string' && flags.file.trim()) ||
    (typeof flags.path === 'string' && flags.path.trim()) ||
    '';
  if (!rawFile) {
    throw new Error('Missing --file <path>');
  }

  const srcPath = path.resolve(rawFile);
  ensureSourceFileReadable(srcPath);

  const filename =
    (typeof flags.filename === 'string' && flags.filename.trim()) || path.basename(srcPath);
  const mimeType =
    (typeof flags['mime-type'] === 'string' && flags['mime-type'].trim()) ||
    (typeof flags.mimeType === 'string' && flags.mimeType.trim()) ||
    detectMimeTypeFromPathAndHeader(srcPath, filename);

  const attachmentId = makeId();
  const dir = getTaskAttachmentsDir(paths, taskId);
  ensureDir(dir);
  const destPath = getStoredAttachmentPath(paths, taskId, attachmentId, filename);
  const allowFallback = !(flags['no-fallback'] === true);

  if (fs.existsSync(destPath)) {
    throw new Error('Attachment destination already exists');
  }

  const result = copyOrLinkFile(srcPath, destPath, flags.mode, allowFallback);
  const stats = fs.statSync(destPath);
  if (!stats.isFile() || stats.size < 0) {
    throw new Error('Attachment write verification failed');
  }

  const meta = {
    id: attachmentId,
    filename,
    mimeType,
    size: stats.size,
    addedAt: nowIso(),
  };

  return {
    meta,
    storedPath: destPath,
    storageMode: result.mode,
    fallbackUsed: result.fallbackUsed,
  };
}

module.exports = {
  getPaths,
  inferLeadName,
  isProcessAlive,
  readTeamConfig,
  resolveLeadSessionId,
  saveTaskAttachmentFile,
};
