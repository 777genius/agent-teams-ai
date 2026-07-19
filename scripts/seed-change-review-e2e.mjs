import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const requestedRoot = process.env.AGENT_TEAMS_CHANGES_E2E_ROOT;
const root = requestedRoot
  ? path.resolve(requestedRoot)
  : await mkdtemp(path.join(os.tmpdir(), 'agent-teams-changes-e2e-'));
const claudeRoot = path.join(root, '.claude');
const userDataRoot = path.join(root, 'user-data');
const workspaceRoot = path.join(root, 'workspace');
const encodedProjectName = workspaceRoot.replace(/[/\\]/g, '-');
const projectLogRoot = path.join(claudeRoot, 'projects', encodedProjectName);
const teamName = 'changes-e2e';
const taskId = 'changes-history-e2e';
const memberName = 'reviewer';
const changedFile = path.join(workspaceRoot, 'src', 'review-history.ts');
const timestamp = '2026-07-17T12:00:00.000Z';

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function buildContent(label) {
  return Array.from({ length: 12 }, (_, index) => {
    const unchanged = Array.from(
      { length: 12 },
      (__, line) => `export const spacer_${index}_${line} = ${index * 100 + line};`
    ).join('\n');
    return [
      `export const reviewed_${index} = '${label}-${index}';`,
      unchanged,
      `export function stable_${index}() { return reviewed_${index}; }`,
    ].join('\n');
  }).join('\n\n');
}

async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

if (requestedRoot) {
  await rm(root, { recursive: true, force: true });
}

const beforeContent = `${buildContent('before')}\n`;
const afterContent = `${buildContent('after')}\n`;
const beforeHash = sha256(beforeContent);
const afterHash = sha256(afterContent);
const ledgerRoot = path.join(projectLogRoot, '.board-task-changes');

await mkdir(path.dirname(changedFile), { recursive: true });
await writeFile(changedFile, afterContent, 'utf8');
await mkdir(path.join(ledgerRoot, 'blobs', 'sha256'), { recursive: true });
await writeFile(path.join(ledgerRoot, 'blobs', 'sha256', beforeHash), beforeContent, 'utf8');
await writeFile(path.join(ledgerRoot, 'blobs', 'sha256', afterHash), afterContent, 'utf8');

const event = {
  schemaVersion: 1,
  taskId,
  taskRef: taskId,
  taskRefKind: 'canonical',
  phase: 'work',
  executionSeq: 1,
  sessionId: 'changes-history-e2e-session',
  agentId: `${memberName}@${teamName}`,
  memberName,
  toolUseId: 'changes-history-e2e-edit',
  source: 'file_edit',
  operation: 'modify',
  confidence: 'exact',
  workspaceRoot,
  filePath: changedFile,
  relativePath: path.relative(workspaceRoot, changedFile),
  timestamp,
  toolStatus: 'succeeded',
  before: {
    sha256: beforeHash,
    sizeBytes: Buffer.byteLength(beforeContent),
    blobRef: `sha256/${beforeHash}`,
  },
  after: {
    sha256: afterHash,
    sizeBytes: Buffer.byteLength(afterContent),
    blobRef: `sha256/${afterHash}`,
  },
  beforeState: {
    exists: true,
    sha256: beforeHash,
    sizeBytes: Buffer.byteLength(beforeContent),
  },
  afterState: {
    exists: true,
    sha256: afterHash,
    sizeBytes: Buffer.byteLength(afterContent),
  },
  linesAdded: 12,
  linesRemoved: 12,
  eventId: sha256(`${taskId}\0${changedFile}\0${beforeHash}\0${afterHash}`),
};
await mkdir(path.join(ledgerRoot, 'events'), { recursive: true });
await writeFile(
  path.join(ledgerRoot, 'events', `${encodeURIComponent(taskId)}.jsonl`),
  `${JSON.stringify(event)}\n`,
  'utf8'
);

await writeJson(path.join(claudeRoot, 'agent-teams-config.json'), {
  general: { appLocale: 'en', agentLanguage: 'en', theme: 'dark', defaultTab: 'dashboard' },
});
await writeJson(path.join(claudeRoot, 'teams', teamName, 'config.json'), {
  name: teamName,
  description: 'Isolated Changes history E2E fixture',
  createdAt: Date.parse(timestamp),
  leadAgentId: `${memberName}@${teamName}`,
  members: [
    {
      agentId: `${memberName}@${teamName}`,
      name: memberName,
      agentType: 'team-lead',
      role: 'Reviewer',
      model: 'test-only',
      color: 'blue',
      joinedAt: Date.parse(timestamp),
      cwd: workspaceRoot,
      subscriptions: [],
    },
  ],
  projectPath: workspaceRoot,
  projectPathHistory: [workspaceRoot],
  language: 'en',
});

const task = {
  id: taskId,
  displayId: 'E2E-101',
  subject: 'Verify durable Changes history',
  description: 'Synthetic offline task with twelve independent review hunks.',
  owner: memberName,
  createdBy: memberName,
  status: 'completed',
  createdAt: timestamp,
  updatedAt: timestamp,
  completedAt: timestamp,
  blocks: [],
  blockedBy: [],
  related: [],
  projectPath: workspaceRoot,
  comments: [],
  reviewState: 'review',
};
await writeJson(path.join(claudeRoot, 'tasks', teamName, `${taskId}.json`), task);
await writeJson(path.join(claudeRoot, 'teams', teamName, 'kanban-state.json'), {
  teamName,
  reviewers: [memberName],
  tasks: {
    [taskId]: { column: 'review', reviewer: memberName, movedAt: timestamp },
  },
  columnOrder: { todo: [], in_progress: [], review: [taskId], done: [], approved: [] },
});

console.log(
  JSON.stringify(
    {
      root,
      claudeRoot,
      userDataRoot,
      workspaceRoot,
      projectLogRoot,
      changedFile,
      beforeHash,
      afterHash,
      teamName,
      taskId,
    },
    null,
    2
  )
);
