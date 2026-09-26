const {
  HOSTED_TASK_FILE_PATTERN,
  hostedRosterImmutableIdentity,
  hostedRosterMemberId,
  hostedTaskBoardTaskId,
} = require('./hostedBoardIdentity.js');

// What the hosted task board shows, derived from the same files desktop reads: task parsing,
// visibility, column and in-column order (desktop KanbanBoard), and the active roster. The
// hosted task command and Product's read source both use it. Pure: no fs, no side effects on import.

const HOSTED_BOARD_COLUMNS = Object.freeze(['todo', 'in_progress', 'review', 'approved', 'done']);
const TASK_STATUSES = new Set(['pending', 'in_progress', 'completed', 'deleted']);
const MAX_RELATIONSHIPS = 256;
const MAX_ROSTER_MEMBERS = 512;
const MEMBER_ID_PATTERN = /^member_[0-9a-f]{32}$/;

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalid(code) {
  return new TypeError(code);
}

function readRelationships(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_RELATIONSHIPS) {
    throw invalid('hosted-board-task-relationship-invalid');
  }
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.length === 0 || entry.length > 128) {
      throw invalid('hosted-board-task-relationship-invalid');
    }
  }
  if (new Set(value).size !== value.length) throw invalid('hosted-board-task-relationship-invalid');
  return [...value];
}

/**
 * Parses one task file. Returns null for a file that is not a board task (another name shape or an
 * internal task) and throws for a malformed task, which makes the whole board unreadable.
 */
function parseHostedBoardTask(name, text) {
  const match = HOSTED_TASK_FILE_PATTERN.exec(name);
  if (!match) return null;
  const rawId = match[1];
  const value = JSON.parse(text);
  if (!isRecord(value)) throw invalid('hosted-board-task-invalid');
  if (isRecord(value.metadata) && value.metadata._internal === true) return null;
  const id = typeof value.id === 'number' && Number.isSafeInteger(value.id) ? String(value.id) : value.id;
  const valid =
    id === rawId &&
    typeof value.subject === 'string' &&
    value.subject.length >= 1 &&
    value.subject.length <= 200 &&
    value.subject.trim() === value.subject &&
    (value.description === undefined ||
      (typeof value.description === 'string' && value.description.length <= 20_000)) &&
    TASK_STATUSES.has(value.status) &&
    (value.owner === undefined ||
      (typeof value.owner === 'string' && value.owner.length >= 1 && value.owner.length <= 128));
  if (!valid) throw invalid('hosted-board-task-invalid');
  return {
    rawId,
    name,
    value,
    displayId: typeof value.displayId === 'string' && value.displayId ? value.displayId : rawId,
    subject: value.subject,
    description: typeof value.description === 'string' ? value.description : null,
    status: value.status,
    owner: typeof value.owner === 'string' ? value.owner : null,
    blockedBy: readRelationships(value.blockedBy),
    blocks: readRelationships(value.blocks),
    related: readRelationships(value.related),
  };
}

/** Keeps only edges both sides record, as desktop does; a one-sided edge is dropped, not fatal. */
function withSymmetricRelationships(tasks) {
  const byRawId = new Map(tasks.map((task) => [task.rawId, task]));
  const pairs = [
    ['blockedBy', 'blocks'],
    ['blocks', 'blockedBy'],
    ['related', 'related'],
  ];
  return tasks.map((task) => {
    const next = { ...task };
    for (const [field, inverse] of pairs) {
      next[field] = task[field].filter((otherId) => {
        const other = byRawId.get(otherId);
        return otherId !== task.rawId && Boolean(other) && other[inverse].includes(task.rawId);
      });
    }
    return next;
  });
}

function parseOrSkip(name, text) {
  try {
    return parseHostedBoardTask(name, text);
  } catch {
    // Desktop TeamTaskReader skips an invalid task file instead of failing the board.
    return null;
  }
}

/** Desktop TeamTaskReader order: numeric display IDs first, then natural display ID, then id. */
function compareByDisplayId(left, right) {
  const leftLabel = left.displayId;
  const rightLabel = right.displayId;
  const leftNumeric = /^\d+$/.test(leftLabel);
  const rightNumeric = /^\d+$/.test(rightLabel);
  if (leftNumeric && rightNumeric) return Number(leftLabel) - Number(rightLabel);
  if (leftNumeric) return -1;
  if (rightNumeric) return 1;
  const options = { numeric: true, sensitivity: 'base' };
  return leftLabel.localeCompare(rightLabel, undefined, options) || left.rawId.localeCompare(right.rawId, undefined, options);
}

/**
 * Board tasks by public task ID, in desktop display order: every valid task except deleted ones.
 * Invalid task files are skipped and one-sided relationships dropped, as desktop does. Deleted
 * tasks still count for relationship symmetry.
 */
function hostedBoardTasks(teamId, taskFiles) {
  const parsed = withSymmetricRelationships(
    taskFiles.map(({ name, text }) => parseOrSkip(name, text)).filter(Boolean)
  ).sort(compareByDisplayId);
  const tasks = new Map();
  for (const task of parsed) {
    if (task.status === 'deleted') continue;
    const publicId = hostedTaskBoardTaskId(teamId, task.rawId);
    if (tasks.has(publicId)) continue;
    tasks.set(publicId, { ...task, publicId });
  }
  return tasks;
}

/** The column desktop KanbanBoard shows: a kanban placement wins, otherwise the status decides. */
function hostedBoardColumnFor(kanban, rawId, status) {
  const entry = isRecord(kanban) && isRecord(kanban.tasks) ? kanban.tasks[rawId] : undefined;
  if (isRecord(entry) && HOSTED_BOARD_COLUMNS.includes(entry.column)) return entry.column;
  return status === 'in_progress' ? 'in_progress' : status === 'completed' ? 'done' : 'todo';
}

/**
 * Raw IDs of one column in display order, as desktop KanbanBoard's manual order: the column's
 * explicit `columnOrder` entries that are in the column, then the rest in display ID order.
 */
function hostedBoardColumnOrder(kanban, column, tasks) {
  const members = [...tasks]
    .filter((task) => hostedBoardColumnFor(kanban, task.rawId, task.status) === column)
    .sort(compareByDisplayId);
  const inColumn = new Set(members.map((task) => task.rawId));
  const explicit =
    isRecord(kanban) && isRecord(kanban.columnOrder) && Array.isArray(kanban.columnOrder[column])
      ? kanban.columnOrder[column]
      : [];
  const ordered = [];
  for (const rawId of explicit) {
    if (inColumn.has(rawId) && !ordered.includes(rawId)) ordered.push(rawId);
  }
  for (const task of members) {
    if (!ordered.includes(task.rawId)) ordered.push(task.rawId);
  }
  return ordered;
}

function parseRosterRecord(text, label) {
  const value = JSON.parse(text);
  if (!isRecord(value)) throw invalid(`hosted-board-roster-${label}-invalid`);
  return value;
}

function parseRosterMembers(source) {
  if (source.members !== undefined && !Array.isArray(source.members)) {
    throw invalid('hosted-board-roster-invalid');
  }
  const members = source.members || [];
  if (members.length > MAX_ROSTER_MEMBERS) throw invalid('hosted-board-roster-budget');
  for (const raw of members) {
    const valid =
      isRecord(raw) &&
      typeof raw.name === 'string' &&
      raw.name.length > 0 &&
      raw.name.trim() === raw.name &&
      (raw.removedAt === undefined || (typeof raw.removedAt === 'number' && Number.isFinite(raw.removedAt))) &&
      (raw.joinedAt === undefined || (Number.isSafeInteger(raw.joinedAt) && raw.joinedAt >= 0)) &&
      (raw.agentId === undefined ||
        (typeof raw.agentId === 'string' &&
          raw.agentId.length > 0 &&
          raw.agentId.length <= 256 &&
          raw.agentId.trim() === raw.agentId)) &&
      (raw.memberId === undefined || (typeof raw.memberId === 'string' && MEMBER_ID_PATTERN.test(raw.memberId)));
    if (!valid) throw invalid('hosted-board-roster-member-invalid');
  }
  return members;
}

/**
 * Active members by wire member ID. members.meta.json (version 1) wins over config.json; `user`
 * and removed members are not assignable. Task documents name their owner by member name, and
 * active names are unique, so every ID maps to exactly one name.
 */
function hostedActiveRosterMembers(teamId, { config, meta }) {
  let members = [];
  if (meta !== null) {
    const record = parseRosterRecord(meta, 'meta');
    if (record.version !== 1) throw invalid('hosted-board-roster-meta-version');
    members = parseRosterMembers(record);
  } else if (config !== null) {
    members = parseRosterMembers(parseRosterRecord(config, 'config'));
  }
  const result = new Map();
  const identities = new Set();
  const activeNames = new Set();
  for (const member of members) {
    if (member.name.toLowerCase() === 'user') continue;
    const id = hostedRosterMemberId(teamId, member);
    if (id === null) throw invalid('hosted-board-roster-member-invalid');
    const identityKey =
      typeof member.memberId === 'string'
        ? `member:${id}`
        : `identity:${hostedRosterImmutableIdentity(member)}`;
    const nameKey = member.name.toLowerCase();
    if (identities.has(identityKey) || (member.removedAt === undefined && activeNames.has(nameKey))) {
      throw invalid('hosted-board-roster-ambiguous');
    }
    identities.add(identityKey);
    if (member.removedAt !== undefined) continue;
    activeNames.add(nameKey);
    if (result.has(id)) throw invalid('hosted-board-roster-ambiguous');
    result.set(id, member.name);
  }
  return result;
}

module.exports = {
  HOSTED_BOARD_COLUMNS,
  hostedActiveRosterMembers,
  hostedBoardColumnFor,
  hostedBoardColumnOrder,
  hostedBoardTasks,
  parseHostedBoardTask,
};
