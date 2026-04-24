const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const TASK_ATTACHMENTS_DIR = 'task-attachments';
const MAX_TASK_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const TEAM_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,127}$/;
const LEAD_AGENT_TYPES = new Set(['team-lead', 'lead', 'orchestrator']);
const CROSS_TEAM_TOOL_RECIPIENT_NAMES = new Set([
  'cross_team_send',
  'cross_team_list_targets',
  'cross_team_get_outbox',
]);

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

function looksLikeQualifiedExternalRecipient(name) {
  const trimmed = String(name || '').trim();
  const dot = trimmed.indexOf('.');
  if (dot <= 0 || dot === trimmed.length - 1) return false;
  const teamName = trimmed.slice(0, dot).trim();
  const memberName = trimmed.slice(dot + 1).trim();
  return TEAM_NAME_PATTERN.test(teamName) && memberName.length > 0;
}

function looksLikeCrossTeamPseudoRecipient(name) {
  const trimmed = String(name || '').trim();
  const prefixes = [
    'cross_team::',
    'cross_team--',
    'cross-team:',
    'cross-team-',
    'cross_team:',
    'cross_team-',
  ];
  for (const prefix of prefixes) {
    if (!trimmed.startsWith(prefix)) continue;
    const teamName = trimmed.slice(prefix.length).trim();
    if (TEAM_NAME_PATTERN.test(teamName)) {
      return true;
    }
  }
  return false;
}

function looksLikeCrossTeamToolRecipient(name) {
  return CROSS_TEAM_TOOL_RECIPIENT_NAMES.has(String(name || '').trim());
}

function looksLikeCrossTeamRecipient(name) {
  return looksLikeQualifiedExternalRecipient(name) || looksLikeCrossTeamPseudoRecipient(name);
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

function isCanonicalLeadMember(member) {
  if (!member || typeof member !== 'object') return false;
  const agentType = typeof member.agentType === 'string' ? member.agentType.trim().toLowerCase() : '';
  const role = typeof member.role === 'string' ? member.role.trim().toLowerCase() : '';
  const name = typeof member.name === 'string' ? member.name.trim().toLowerCase() : '';
  return (
    LEAD_AGENT_TYPES.has(agentType) ||
    name === 'team-lead' ||
    role === 'team-lead' ||
    role === 'team lead' ||
    role === 'lead'
  );
}

function normalizeMemberKey(value) {
  return typeof value === 'string' && value.trim() ? value.trim().toLowerCase() : '';
}

function collectExplicitTeamMembers(paths) {
  const config = readTeamConfig(paths) || {};
  const configMembers = Array.isArray(config.members) ? config.members : [];
  const metaMembers = readMembersMeta(paths);
  const membersByKey = new Map();
  const removedNames = new Set();

  for (const rawMember of configMembers) {
    const normalized = normalizeMemberRecord(rawMember);
    if (!normalized) continue;
    membersByKey.set(normalizeMemberKey(normalized.name), normalized);
  }

  for (const rawMember of metaMembers) {
    const normalized = normalizeMemberRecord(rawMember);
    if (!normalized) continue;
    const key = normalizeMemberKey(normalized.name);
    if (normalized.removedAt != null) {
      membersByKey.delete(key);
      removedNames.add(key);
      continue;
    }
    removedNames.delete(key);
    membersByKey.set(key, mergeResolvedMember(membersByKey.get(key) || { name: normalized.name }, normalized));
  }

  return { membersByKey, removedNames };
}

function inferLeadName(paths) {
  const resolved = resolveTeamMembers(paths);
  const members = resolved.members || [];
  const lead =
    members.find((member) => {
      const agentType = typeof member?.agentType === 'string' ? member.agentType.trim().toLowerCase() : '';
      return LEAD_AGENT_TYPES.has(agentType);
    }) ||
    members.find((member) => String((member && member.name) || '').trim().toLowerCase() === 'team-lead') ||
    members.find(
      (member) => {
        const role = typeof member.role === 'string' ? member.role.trim().toLowerCase() : '';
        return role === 'team-lead' || role === 'team lead' || role === 'lead';
      }
    );
  if (lead) {
    return String(lead.name);
  }
  const config = resolved.config;
  if (config && Array.isArray(config.members) && config.members[0]) {
    return String(config.members[0].name);
  }
  return 'team-lead';
}

function resolveExplicitTeamMemberName(paths, candidate, options = {}) {
  const normalized = typeof candidate === 'string' && candidate.trim() ? candidate.trim() : '';
  const key = normalizeMemberKey(normalized);
  if (!key) return null;

  const explicit = collectExplicitTeamMembers(paths);
  if (explicit.removedNames.has(key)) return null;
  const directMember = explicit.membersByKey.get(key);
  if (directMember) {
    return directMember.name;
  }

  if (options.allowLeadAliases !== false) {
    const leadName = inferLeadName(paths);
    const leadKey = normalizeMemberKey(leadName);
    if (key === 'lead' || key === 'team-lead' || (leadKey && key === leadKey)) {
      const leadMember = leadKey ? explicit.membersByKey.get(leadKey) : null;
      return leadMember ? leadMember.name : null;
    }
  }

  return null;
}

function assertExplicitTeamMemberName(paths, candidate, label = 'member', options = {}) {
  const resolved = resolveExplicitTeamMemberName(paths, candidate, options);
  if (!resolved) {
    const value = typeof candidate === 'string' && candidate.trim() ? candidate.trim() : String(candidate || '');
    throw new Error(`Unknown ${label}: ${value}. Use a configured team member name.`);
  }
  return resolved;
}

function readTeamConfig(paths) {
  return readJson(path.join(paths.teamDir, 'config.json'), null);
}

function readMembersMeta(paths) {
  let parsed;
  try {
    parsed = readJson(path.join(paths.teamDir, 'members.meta.json'), null);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.members)) {
    return [];
  }
  return parsed.members.filter((member) => member && typeof member === 'object');
}

function listInboxMemberNames(paths) {
  const inboxDir = path.join(paths.teamDir, 'inboxes');
  let entries;
  try {
    entries = fs.readdirSync(inboxDir, { withFileTypes: true });
  } catch {
    return [];
  }

  return entries
    .filter((entry) => entry && entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => entry.name.slice(0, -5))
    .map((name) => String(name || '').trim())
    .filter((name) => name && name !== 'user')
    .filter((name) => !looksLikeCrossTeamPseudoRecipient(name))
    .filter((name) => !looksLikeCrossTeamToolRecipient(name));
}

function normalizeMemberRecord(member) {
  if (!member || typeof member !== 'object') return null;
  const name = typeof member.name === 'string' ? member.name.trim() : '';
  if (!name) return null;
  const copyTrimmedString = (key) =>
    typeof member[key] === 'string' && member[key].trim()
      ? { [key]: member[key].trim() }
      : {};
  return {
    name,
    ...(typeof member.role === 'string' && member.role.trim() ? { role: member.role.trim() } : {}),
    ...(typeof member.workflow === 'string' && member.workflow.trim()
      ? { workflow: member.workflow.trim() }
      : {}),
    ...(typeof member.agentType === 'string' && member.agentType.trim()
      ? { agentType: member.agentType.trim() }
      : {}),
    ...(typeof member.color === 'string' && member.color.trim() ? { color: member.color.trim() } : {}),
    ...(typeof member.cwd === 'string' && member.cwd.trim() ? { cwd: member.cwd.trim() } : {}),
    ...copyTrimmedString('providerId'),
    ...copyTrimmedString('providerBackendId'),
    ...copyTrimmedString('provider'),
    ...copyTrimmedString('model'),
    ...copyTrimmedString('effort'),
    ...copyTrimmedString('fastMode'),
    ...(typeof member.removedAt === 'number' ? { removedAt: member.removedAt } : {}),
  };
}

function mergeResolvedMember(target, source) {
  if (!source) return target;
  return {
    ...target,
    ...(source.name ? { name: source.name } : {}),
    ...(source.role ? { role: source.role } : {}),
    ...(source.workflow ? { workflow: source.workflow } : {}),
    ...(source.agentType ? { agentType: source.agentType } : {}),
    ...(source.color ? { color: source.color } : {}),
    ...(source.cwd ? { cwd: source.cwd } : {}),
    ...(source.providerId ? { providerId: source.providerId } : {}),
    ...(source.providerBackendId ? { providerBackendId: source.providerBackendId } : {}),
    ...(source.provider ? { provider: source.provider } : {}),
    ...(source.model ? { model: source.model } : {}),
    ...(source.effort ? { effort: source.effort } : {}),
    ...(source.fastMode ? { fastMode: source.fastMode } : {}),
    ...(source.removedAt != null ? { removedAt: source.removedAt } : {}),
  };
}

function resolveTeamMembers(paths) {
  const config = readTeamConfig(paths) || {};
  const configMembers = Array.isArray(config.members) ? config.members : [];
  const metaMembers = readMembersMeta(paths);
  const inboxNames = listInboxMemberNames(paths);
  const memberMap = new Map();
  const removedNames = new Set();

  for (const rawMember of configMembers) {
    const normalized = normalizeMemberRecord(rawMember);
    if (!normalized) continue;
    memberMap.set(normalized.name.toLowerCase(), normalized);
  }

  for (const rawMember of metaMembers) {
    const normalized = normalizeMemberRecord(rawMember);
    if (!normalized) continue;
    const key = normalized.name.toLowerCase();
    if (normalized.removedAt != null) {
      memberMap.delete(key);
      removedNames.add(key);
      continue;
    }
    removedNames.delete(key);
    memberMap.set(key, mergeResolvedMember(memberMap.get(key) || { name: normalized.name }, normalized));
  }

  for (const inboxName of inboxNames) {
    const normalized = String(inboxName || '').trim();
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (!memberMap.has(key) && looksLikeQualifiedExternalRecipient(normalized)) continue;
    if (removedNames.has(key) || memberMap.has(key)) continue;
    memberMap.set(key, { name: normalized });
  }

  return {
    config,
    members: Array.from(memberMap.values()).sort((a, b) => a.name.localeCompare(b.name)),
    removedNames,
    inboxNames,
  };
}

function getCurrentRuntimeMemberIdentity() {
  const args = Array.isArray(process.argv) ? process.argv.slice(2) : [];
  let agentName = '';
  let agentId = '';
  let teamName = '';

  for (let i = 0; i < args.length; i += 1) {
    const arg = typeof args[i] === 'string' ? args[i] : '';
    const next = typeof args[i + 1] === 'string' ? args[i + 1].trim() : '';
    if (!next) continue;
    if (arg === '--agent-name') {
      agentName = next;
      continue;
    }
    if (arg === '--agent-id') {
      agentId = next;
      continue;
    }
    if (arg === '--team-name') {
      teamName = next;
    }
  }

  const normalizedAgentName = typeof agentName === 'string' ? agentName.trim() : '';
  const normalizedAgentId = typeof agentId === 'string' ? agentId.trim() : '';
  const normalizedTeamName = typeof teamName === 'string' ? teamName.trim() : '';
  if (!normalizedAgentName && !normalizedAgentId) {
    return null;
  }

  return {
    agentName: normalizedAgentName,
    agentId: normalizedAgentId,
    teamName: normalizedTeamName,
  };
}

function resolveLeadSessionId(paths) {
  const config = readTeamConfig(paths);
  return config && typeof config.leadSessionId === 'string' && config.leadSessionId.trim()
    ? config.leadSessionId.trim()
    : undefined;
}

function resolveCanonicalLeadSessionId(paths, candidate) {
  const configured = resolveLeadSessionId(paths);
  const explicit = typeof candidate === 'string' ? candidate.trim() : '';

  if (!explicit) {
    return configured;
  }

  // The team config is the canonical source of the current lead runtime session.
  // If a caller passes a placeholder like "team-lead" or any other mismatched value,
  // prefer the configured session id instead of persisting dirty metadata into inbox rows.
  if (configured) {
    return explicit === configured ? explicit : configured;
  }

  return explicit;
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
    filePath: destPath,
  };

  return {
    meta,
    storedPath: destPath,
    storageMode: result.mode,
    fallbackUsed: result.fallbackUsed,
  };
}

module.exports = {
  assertExplicitTeamMemberName,
  collectExplicitTeamMembers,
  getPaths,
  inferLeadName,
  isCanonicalLeadMember,
  looksLikeCrossTeamRecipient,
  looksLikeCrossTeamToolRecipient,
  isProcessAlive,
  listInboxMemberNames,
  readMembersMeta,
  readTeamConfig,
  resolveExplicitTeamMemberName,
  resolveTeamMembers,
  getCurrentRuntimeMemberIdentity,
  resolveCanonicalLeadSessionId,
  resolveLeadSessionId,
  saveTaskAttachmentFile,
};
