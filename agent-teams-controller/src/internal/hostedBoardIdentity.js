const { createHash } = require('crypto');

// Hosted task-board identities. Product's read source and the hosted task command both derive
// board identity from these functions, so the revision a browser reads is the revision a mutation
// is checked against. Pure: no fs, no side effects on import.

const HOSTED_TASK_FILE_PATTERN = /^([A-Za-z0-9][A-Za-z0-9._-]{0,127})\.json$/;
const HOSTED_REVISION_ROSTER_FILES = Object.freeze(['config.json', 'members.meta.json']);
const MEMBER_ID_PATTERN = /^member_[0-9a-f]{32}$/;

function sha256Hex(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function hostedBoardDigest(value) {
  return sha256Hex(JSON.stringify(value));
}

function hostedTaskBoardTaskId(teamId, rawTaskId) {
  return `task_${hostedBoardDigest({ domain: 'hosted-task-board-task/v1', teamId, rawTaskId }).slice(0, 32)}`;
}

/** Directory identities are decimal `[device, inode]` strings, exact for 64-bit inode numbers. */
function hostedTaskBoardSourceGeneration(input) {
  return `generation_${hostedBoardDigest({
    domain: 'hosted-task-board-source/v2',
    deploymentId: input.deploymentId,
    bootId: input.bootId,
    workspaceId: input.workspaceId,
    mountGeneration: input.mountGeneration,
    teamId: input.teamId,
    teamDirectory: [String(input.teamDirectory[0]), String(input.teamDirectory[1])],
    tasksDirectory: [String(input.tasksDirectory[0]), String(input.tasksDirectory[1])],
  })}`;
}

function validBoardFileName(name) {
  return (
    typeof name === 'string' &&
    name.length > 0 &&
    name !== '.' &&
    name !== '..' &&
    !name.includes('/') &&
    !name.includes('\\')
  );
}

/**
 * Covers every task file text, the kanban state text, and the roster files, so a change by any
 * writer moves the revision. Absent roster files hash as null.
 */
function hostedTaskBoardRevision(input) {
  const taskNames = new Set();
  for (const task of input.taskFiles) {
    if (
      !validBoardFileName(task.name) ||
      typeof task.text !== 'string' ||
      taskNames.has(task.name)
    ) {
      throw new TypeError('hosted-task-board-revision-input-invalid');
    }
    taskNames.add(task.name);
  }
  const rosterFiles = input.rosterFiles || [];
  const rosterNames = new Set();
  for (const file of rosterFiles) {
    if (!validBoardFileName(file.name) || rosterNames.has(file.name)) {
      throw new TypeError('hosted-task-board-revision-input-invalid');
    }
    rosterNames.add(file.name);
  }
  return `revision_${hostedBoardDigest({
    domain: 'hosted-task-board-revision/v3',
    sourceGeneration: input.sourceGeneration,
    taskFiles: [...input.taskFiles]
      .sort((left, right) => left.name.localeCompare(right.name))
      .map(({ name, text }) => [name, sha256Hex(text)]),
    kanban: input.kanbanText === null ? null : sha256Hex(input.kanbanText),
    roster: [...rosterFiles]
      .sort((left, right) => left.name.localeCompare(right.name))
      .map(({ name, text }) => [name, text === null ? null : sha256Hex(text)]),
  })}`;
}

/** Name plus joinedAt, else agentId, else name; null when the record has no usable name. */
function hostedRosterImmutableIdentity(member) {
  if (!member || typeof member.name !== 'string' || member.name.length === 0) return null;
  if (Number.isSafeInteger(member.joinedAt) && member.joinedAt >= 0) {
    return `${member.name}\u0000${member.joinedAt}`;
  }
  if (typeof member.agentId === 'string' && member.agentId.length > 0) return member.agentId;
  return member.name;
}

function hostedRosterMemberIdForIdentity(teamId, immutableIdentity) {
  return `member_${hostedBoardDigest({
    domain: 'hosted-task-board-member/v1',
    teamId,
    rawMemberName: immutableIdentity,
  }).slice(0, 32)}`;
}

/** An explicit roster memberId wins; otherwise the ID derives from the immutable identity. */
function hostedRosterMemberId(teamId, member) {
  if (member && typeof member.memberId === 'string' && MEMBER_ID_PATTERN.test(member.memberId)) {
    return member.memberId;
  }
  const identity = hostedRosterImmutableIdentity(member);
  if (!teamId || identity === null) return null;
  return hostedRosterMemberIdForIdentity(teamId, identity);
}

/**
 * The task ID a hosted create command owns. It has the UUID shape controller task IDs use, so the
 * display ID derives from it the same way as for every other task.
 */
function hostedTaskIdForCommand(teamId, commandId) {
  const hex = sha256Hex(
    JSON.stringify({ domain: 'agent-teams.hosted-task-id/v1', teamId, commandId })
  );
  const version = `5${hex.slice(13, 16)}`;
  const variant = `${((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16)}${hex.slice(17, 20)}`;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${version}-${variant}-${hex.slice(20, 32)}`;
}

module.exports = {
  HOSTED_REVISION_ROSTER_FILES,
  HOSTED_TASK_FILE_PATTERN,
  hostedBoardDigest,
  hostedRosterImmutableIdentity,
  hostedRosterMemberId,
  hostedRosterMemberIdForIdentity,
  hostedTaskBoardRevision,
  hostedTaskBoardSourceGeneration,
  hostedTaskBoardTaskId,
  hostedTaskIdForCommand,
};
