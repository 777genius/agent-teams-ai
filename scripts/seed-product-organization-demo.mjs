import { mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const DEMO_ROOT = path.resolve(
  process.env.AGENT_TEAMS_PRODUCT_ORG_DEMO_ROOT ??
    path.join(os.tmpdir(), 'agent-teams-product-organization-demo')
);
const CLAUDE_ROOT = path.join(DEMO_ROOT, '.claude');
const USER_DATA_ROOT = path.join(DEMO_ROOT, 'user-data');
const WORKSPACE_ROOT = path.join(DEMO_ROOT, 'workspace');
const ORGANIZATION_ID = 'atlas-ai';
const NOW = Date.parse('2026-07-15T16:30:00.000Z');

const projectFolders = {
  platform: 'atlas-ai-platform',
  experience: 'customer-workspace',
  intelligence: 'model-intelligence-suite',
  operations: 'production-operations',
};

function getProjectPath(team) {
  return path.join(WORKSPACE_ROOT, projectFolders[team.project]);
}

const containers = [
  {
    id: 'atlas-ai:product-platform',
    parentId: 'atlas-ai:root',
    label: 'Product & Platform',
    description: 'Builds the customer experience and the agent execution platform.',
    color: '#8b5cf6',
  },
  {
    id: 'atlas-ai:agent-platform',
    parentId: 'atlas-ai:product-platform',
    label: 'Agent Platform',
    description: 'Owns orchestration, provider connectivity, and runtime foundations.',
    color: '#3b82f6',
  },
  {
    id: 'atlas-ai:runtime-systems',
    parentId: 'atlas-ai:agent-platform',
    label: 'Runtime Systems',
    description: 'Runs reliable multi-agent workloads across supported providers.',
    color: '#0ea5e9',
  },
  {
    id: 'atlas-ai:product-experience',
    parentId: 'atlas-ai:agent-platform',
    label: 'Product Experience',
    description: 'Turns runtime capabilities into clear product workflows.',
    color: '#a855f7',
  },
  {
    id: 'atlas-ai:trust-operations',
    parentId: 'atlas-ai:root',
    label: 'Trust & Operations',
    description: 'Keeps the product observable, secure, and continuously improving.',
    color: '#10b981',
  },
  {
    id: 'atlas-ai:intelligence',
    parentId: 'atlas-ai:trust-operations',
    label: 'Intelligence',
    description: 'Improves retrieval quality and evaluates model behavior.',
    color: '#14b8a6',
  },
  {
    id: 'atlas-ai:knowledge-systems',
    parentId: 'atlas-ai:intelligence',
    label: 'Knowledge Systems',
    description: 'Maintains grounded project context and model quality signals.',
    color: '#2dd4bf',
  },
  {
    id: 'atlas-ai:reliability',
    parentId: 'atlas-ai:trust-operations',
    label: 'Reliability',
    description: 'Protects production availability and operational integrity.',
    color: '#22c55e',
  },
  {
    id: 'atlas-ai:production-systems',
    parentId: 'atlas-ai:reliability',
    label: 'Production Systems',
    description: 'Owns runtime health, incident response, and security controls.',
    color: '#16a34a',
  },
];

const teams = [
  {
    name: 'runtime-orchestration',
    code: 'RUN',
    label: 'Runtime Orchestration',
    project: 'platform',
    parentId: 'atlas-ai:runtime-systems',
    color: '#38bdf8',
    inProgress: [
      'Restore interrupted runs from durable checkpoints',
      'Instrument provider bootstrap latency',
      'Validate concurrent task handoff ordering',
      'Reduce cold-start time below two seconds',
      'Add idempotent inbox delivery receipts',
      'Harden process cleanup after host restart',
    ],
    pending: [
      'Document scheduler ownership boundaries',
      'Plan the next 200-agent load test',
      'Define runtime compatibility guarantees',
      'Prototype resumable task leases',
    ],
    review: [
      'Verify graceful shutdown across all providers',
      'Review bounded retry policy telemetry',
      'Validate task lifecycle event ordering',
      'Audit recovery checkpoint redaction',
    ],
    completed: [
      'Measure orchestration queue latency',
      'Normalize runtime capability discovery',
      'Add process ownership diagnostics',
      'Document bootstrap state transitions',
      'Remove stale recovery lock files',
    ],
    approved: [
      'Ship provider-aware retry budgets',
      'Add structured launch failure artifacts',
      'Persist task work intervals',
    ],
  },
  {
    name: 'provider-integrations',
    code: 'PRV',
    label: 'Provider Integrations',
    project: 'platform',
    parentId: 'atlas-ai:runtime-systems',
    color: '#60a5fa',
    inProgress: ['Complete OpenCode runtime health checks', 'Add provider failover telemetry'],
    pending: ['Review OAuth recovery flows', 'Publish provider capability matrix'],
    review: ['Validate managed binary repair flow'],
    completed: [
      'Harden Codex account discovery',
      'Add Anthropic readiness probes',
      'Normalize provider error messages',
    ],
    approved: ['Verify managed binary resolution'],
  },
  {
    name: 'workspace-experience',
    code: 'WSP',
    label: 'Workspace Experience',
    project: 'experience',
    parentId: 'atlas-ai:product-experience',
    color: '#c084fc',
    inProgress: ['Polish team creation workflow', 'Improve model picker density'],
    pending: ['Prototype compact workspace navigation', 'Review empty project states'],
    review: ['Check responsive roster layout'],
    completed: ['Add project path validation', 'Improve light theme contrast'],
    approved: ['Simplify member editor layout'],
  },
  {
    name: 'collaboration-tools',
    code: 'COL',
    label: 'Collaboration Tools',
    project: 'experience',
    parentId: 'atlas-ai:product-experience',
    color: '#e879f9',
    inProgress: ['Add approval thread summaries'],
    pending: ['Design shared decision history', 'Add reviewer notification controls'],
    review: ['Review cross-team message grouping'],
    completed: ['Improve task handoff visibility', 'Add structured review outcomes'],
    approved: ['Ship teammate mention autocomplete'],
  },
  {
    name: 'knowledge-retrieval',
    code: 'KNO',
    label: 'Knowledge & Retrieval',
    project: 'intelligence',
    parentId: 'atlas-ai:knowledge-systems',
    color: '#2dd4bf',
    inProgress: ['Tune semantic project retrieval', 'Add source freshness scoring'],
    pending: [
      'Evaluate hybrid search ranking',
      'Index organization decision records',
      'Define stale context alerts',
    ],
    review: ['Evaluate hybrid search ranking'],
    completed: ['Measure retrieval precision', 'Normalize document metadata'],
    approved: ['Add repository-aware chunking'],
  },
  {
    name: 'model-quality',
    code: 'QLT',
    label: 'Model Quality',
    project: 'intelligence',
    parentId: 'atlas-ai:knowledge-systems',
    color: '#5eead4',
    inProgress: [
      'Run multi-agent regression suite',
      'Calibrate long-context benchmark',
      'Review provider response parity',
    ],
    pending: ['Expand tool-use evaluation set', 'Define release quality thresholds'],
    review: ['Review model routing regressions'],
    completed: [
      'Publish weekly quality baseline',
      'Add workflow completion scoring',
      'Validate multilingual task prompts',
    ],
    approved: ['Calibrate provider response parity baseline'],
  },
  {
    name: 'reliability-engineering',
    code: 'SRE',
    label: 'Reliability Engineering',
    project: 'operations',
    parentId: 'atlas-ai:production-systems',
    color: '#4ade80',
    inProgress: ['Harden runtime watchdog alerts', 'Reduce queue recovery time'],
    pending: ['Exercise regional failover plan', 'Tune resource pressure thresholds'],
    review: ['Review incident escalation thresholds'],
    completed: [
      'Automate stale process cleanup',
      'Improve incident timeline capture',
      'Verify backup restoration flow',
    ],
    approved: ['Add launch failure artifact packs'],
  },
  {
    name: 'security-operations',
    code: 'SEC',
    label: 'Security Operations',
    project: 'operations',
    parentId: 'atlas-ai:production-systems',
    color: '#86efac',
    inProgress: ['Audit runtime credential boundaries'],
    pending: [
      'Review workspace trust escalation',
      'Schedule dependency threat review',
    ],
    review: ['Validate sensitive log redaction'],
    completed: ['Rotate demo environment secrets', 'Review runtime filesystem permissions'],
    approved: ['Harden managed credential storage'],
  },
];

const memberProfiles = [
  { name: 'maya', role: 'Engineering Lead', agentType: 'team-lead', color: 'blue' },
  { name: 'liam', role: 'Senior Engineer', agentType: 'general-purpose', color: 'green' },
  { name: 'sophia', role: 'Product Engineer', agentType: 'general-purpose', color: 'purple' },
  { name: 'noah', role: 'Runtime Engineer', agentType: 'general-purpose', color: 'orange' },
  { name: 'emma', role: 'Quality Engineer', agentType: 'general-purpose', color: 'pink' },
];

function buildTeamConfig(team, teamIndex) {
  const joinedAt = NOW - (teams.length - teamIndex) * 86_400_000;
  const projectPath = getProjectPath(team);
  const profiles = teamIndex === 0 ? memberProfiles : memberProfiles.slice(0, 3);
  return {
    name: team.name,
    description: `${team.label} team for the Atlas AI product platform.`,
    createdAt: joinedAt,
    leadAgentId: `maya@${team.name}`,
    members: profiles.map((profile, memberIndex) => ({
      agentId: `${profile.name}@${team.name}`,
      name: profile.name,
      agentType: profile.agentType,
      role: profile.role,
      model: memberIndex === 0 ? 'claude-sonnet-4-6' : 'gpt-5.3-codex',
      color: profile.color,
      joinedAt: joinedAt + memberIndex * 1000,
      cwd: projectPath,
      subscriptions: [],
    })),
    projectPath,
    projectPathHistory: [projectPath],
    language: 'en',
  };
}

function buildTaskComments(team, subject, category, taskIndex, owner) {
  const baseCount = team.name === 'runtime-orchestration' ? 2 + ((taskIndex + category.length) % 5) : 1;
  const reviewExtra = category === 'review' || category === 'approved' ? 1 : 0;
  const count = baseCount + reviewExtra;
  const authors = ['maya', owner, 'emma', 'sophia', 'liam'];
  const notes = [
    `Scope confirmed for ${subject.toLowerCase()}.`,
    'The focused regression suite is green and the trace output is attached to the task.',
    'I checked the failure path as well as the expected path; both preserve the recovery contract.',
    'Provider-specific behavior is documented in the rollout note.',
    'One edge case remains visible in telemetry, but it does not block this milestone.',
    'Review feedback is addressed and the verification checklist is complete.',
  ];

  return Array.from({ length: count }, (_, commentIndex) => ({
    id: `${team.name}-${category}-${taskIndex + 1}-comment-${commentIndex + 1}`,
    author: authors[(taskIndex + commentIndex) % authors.length],
    text: notes[(taskIndex * 2 + commentIndex) % notes.length],
    createdAt: new Date(NOW - (count - commentIndex) * 21 * 60_000 - taskIndex * 60_000).toISOString(),
    type:
      category === 'approved' && commentIndex === count - 1
        ? 'review_approved'
        : category === 'review' && commentIndex === count - 1
          ? 'review_request'
          : 'regular',
  }));
}

function buildTask(team, teamIndex, subject, category, taskIndex) {
  const status = category === 'pending' || category === 'in_progress' ? category : 'completed';
  const statusOffset = status === 'completed' ? -7 * 86_400_000 : -taskIndex * 3_600_000;
  const createdAt = NOW - (taskIndex + 2) * 86_400_000;
  const availableOwners = teamIndex === 0 ? memberProfiles : memberProfiles.slice(0, 3);
  const owner = availableOwners[taskIndex % availableOwners.length].name;
  const taskNumber = 101 + taskIndex + ['pending', 'in_progress', 'review', 'completed', 'approved'].indexOf(category) * 10;
  return {
    id: `${team.name}-${category}-${taskIndex + 1}`,
    displayId: `${team.code}-${taskNumber}`,
    subject,
    description: `${subject}. Deliver a production-ready result with tests and a concise rollout note.`,
    owner,
    createdBy: 'maya',
    status,
    createdAt: new Date(createdAt).toISOString(),
    updatedAt: new Date(NOW + statusOffset - teamIndex * 60_000).toISOString(),
    ...(status === 'completed'
      ? { completedAt: new Date(NOW + statusOffset - teamIndex * 60_000).toISOString() }
      : {}),
    blocks: [],
    blockedBy: [],
    related: [],
    projectPath: getProjectPath(team),
    comments: buildTaskComments(team, subject, category, taskIndex, owner),
    reviewState:
      category === 'review' ? 'review' : category === 'approved' ? 'approved' : 'none',
    ...(status === 'in_progress'
      ? {
          workIntervals: [
            {
              startedAt: new Date(NOW - (taskIndex + 2) * 3_600_000).toISOString(),
            },
          ],
        }
      : {}),
  };
}

function buildTasks(team, teamIndex) {
  const tasks = [
    ...team.inProgress.map((subject, index) =>
      buildTask(team, teamIndex, subject, 'in_progress', index)
    ),
    ...team.pending.map((subject, index) => buildTask(team, teamIndex, subject, 'pending', index)),
    ...team.review.map((subject, index) => buildTask(team, teamIndex, subject, 'review', index)),
    ...team.completed.map((subject, index) =>
      buildTask(team, teamIndex, subject, 'completed', index)
    ),
    ...team.approved.map((subject, index) =>
      buildTask(team, teamIndex, subject, 'approved', index)
    ),
  ];

  if (team.name === 'runtime-orchestration') {
    const active = tasks.filter((task) => task.status === 'in_progress');
    const review = tasks.filter((task) => task.reviewState === 'review');
    active[1].blockedBy = [active[0].id];
    active[0].blocks = [active[1].id];
    active[2].related = [review[0].id];
    review[0].related = [active[2].id];
    active[5].needsClarification = 'user';
  }

  return tasks;
}

function buildKanbanState(team, tasks) {
  const reviewTasks = tasks.filter((task) => task.reviewState === 'review');
  const approvedTasks = tasks.filter((task) => task.reviewState === 'approved');
  return {
    teamName: team.name,
    reviewers: ['emma', 'sophia'],
    tasks: Object.fromEntries([
      ...reviewTasks.map((task, index) => [
        task.id,
        {
          column: 'review',
          reviewer: index % 2 === 0 ? 'emma' : 'sophia',
          movedAt: new Date(NOW - (index + 1) * 43 * 60_000).toISOString(),
        },
      ]),
      ...approvedTasks.map((task, index) => [
        task.id,
        {
          column: 'approved',
          movedAt: new Date(NOW - (index + 1) * 5 * 3_600_000).toISOString(),
        },
      ]),
    ]),
    columnOrder: {
      todo: tasks.filter((task) => task.status === 'pending').map((task) => task.id),
      in_progress: tasks.filter((task) => task.status === 'in_progress').map((task) => task.id),
      review: reviewTasks.map((task) => task.id),
      done: tasks
        .filter((task) => task.status === 'completed' && task.reviewState === 'none')
        .map((task) => task.id),
      approved: approvedTasks.map((task) => task.id),
    },
  };
}

function buildRuntimeMessages(tasks) {
  const activeTasks = tasks.filter((task) => task.status === 'in_progress');
  const reviewTasks = tasks.filter((task) => task.reviewState === 'review');
  const threads = [
    {
      member: 'liam',
      task: activeTasks[0],
      user: 'Please keep checkpoint recovery scoped to interrupted provider sessions and share the benchmark before review.',
      reply: 'Recovery now resumes from the last durable checkpoint on Anthropic, Codex, and OpenCode. The 50-run benchmark is green with no duplicate task transitions.',
    },
    {
      member: 'sophia',
      task: activeTasks[2],
      user: 'Validate ordering with two teammates completing and handing off tasks at the same time.',
      reply: 'The concurrent handoff matrix is complete. Ownership, status, and review events remain deterministic across all six interleavings.',
    },
    {
      member: 'noah',
      task: activeTasks[3],
      user: 'Focus on startup work that affects the first useful response, not background diagnostics.',
      reply: 'Cold start is down to 1.74 seconds at p95. Deferred diagnostics no longer block the first useful response.',
    },
    {
      member: 'emma',
      task: reviewTasks[0],
      user: 'Run the shutdown suite against all provider adapters and call out any platform-specific behavior.',
      reply: 'Shutdown verification passed on all three providers. Windows requires one additional process-tree assertion, already documented in the review notes.',
    },
    {
      member: 'liam',
      task: activeTasks[4],
      user: 'Make delivery receipts idempotent across retries and renderer refreshes.',
      reply: 'Receipts now use the durable message identity. Replay, reconnect, and renderer refresh scenarios all preserve a single visible delivery event.',
    },
    {
      member: 'noah',
      task: activeTasks[5],
      user: 'Document the remaining host-restart uncertainty before escalating it.',
      reply: 'The uncertainty is isolated to orphan detection during a narrow macOS restart window. I added a user clarification with the two safe policy options.',
    },
  ];
  const sent = [];
  const inbox = [];

  threads.forEach((thread, index) => {
    const taskRef = {
      taskId: thread.task.id,
      displayId: thread.task.displayId,
      teamName: 'runtime-orchestration',
    };
    const sentAt = new Date(NOW - (threads.length - index) * 48 * 60_000).toISOString();
    const replyAt = new Date(Date.parse(sentAt) + 17 * 60_000).toISOString();
    sent.push({
      from: 'user',
      to: thread.member,
      text: thread.user,
      timestamp: sentAt,
      read: true,
      taskRefs: [taskRef],
      actionMode: index % 3 === 0 ? 'delegate' : 'do',
      messageId: `runtime-demo-sent-${index + 1}`,
      source: 'user_sent',
    });
    inbox.push({
      from: thread.member,
      to: 'user',
      text: thread.reply,
      timestamp: replyAt,
      read: index < 2,
      taskRefs: [taskRef],
      summary: `Progress update for ${thread.task.displayId}`,
      color: memberProfiles.find((profile) => profile.name === thread.member)?.color,
      messageId: `runtime-demo-inbox-${index + 1}`,
      source: 'inbox',
      toolSummary: index % 2 === 0 ? '4 tools (Read, Bash, Edit, Test)' : '3 tools (Read, Search, Test)',
      toolCalls: [
        { name: 'Read', preview: 'Inspect implementation and focused tests' },
        { name: 'Test', preview: `Verify ${thread.task.displayId}` },
      ],
    });
  });

  const updates = [
    ['sophia', activeTasks[2], 'I added a deterministic sequence diagram to the task notes and linked the review case.'],
    ['emma', reviewTasks[1], 'The retry telemetry review found one naming inconsistency; the patch is ready for a final pass.'],
    ['liam', activeTasks[0], 'Checkpoint corruption now fails closed and preserves the original artifact for diagnosis.'],
    ['noah', activeTasks[3], 'The latest trace removes 420 ms of synchronous provider discovery from startup.'],
    ['maya', reviewTasks[2], 'Lifecycle ordering is ready for review. Please verify the reconnect path before approval.'],
    ['emma', reviewTasks[3], 'Redaction coverage includes paths, tokens, environment values, and command previews.'],
    ['sophia', activeTasks[4], 'The receipt cache survives renderer reload without producing duplicate message rows.'],
    ['liam', activeTasks[1], 'Bootstrap latency telemetry is now segmented by provider, binary source, and repair attempt.'],
  ];
  updates.forEach(([member, task, text], index) => {
    inbox.push({
      from: member,
      to: 'user',
      text,
      timestamp: new Date(NOW - (updates.length - index) * 19 * 60_000).toISOString(),
      read: false,
      taskRefs: [{ taskId: task.id, displayId: task.displayId, teamName: 'runtime-orchestration' }],
      summary: `${task.displayId} implementation update`,
      color: memberProfiles.find((profile) => profile.name === member)?.color,
      messageId: `runtime-demo-update-${index + 1}`,
      source: 'inbox',
    });
  });

  return { sent, inbox };
}

function buildOrganizationMap() {
  const root = {
    id: 'atlas-ai:root',
    organizationId: ORGANIZATION_ID,
    parentId: null,
    kind: 'organization',
    label: 'Atlas AI',
    description: 'Product organization building a reliable multi-agent collaboration platform.',
    color: '#6366f1',
  };
  const containerUnits = containers.map((container) => ({
    ...container,
    organizationId: ORGANIZATION_ID,
    kind: 'container',
  }));
  const teamUnits = teams.map((team) => ({
    id: `team:${team.name}`,
    organizationId: ORGANIZATION_ID,
    parentId: team.parentId,
    kind: 'team',
    label: team.label,
    description: `${team.label} delivery team.`,
    color: team.color,
    teamName: team.name,
  }));

  return {
    schemaVersion: 1,
    organizations: [
      {
        id: ORGANIZATION_ID,
        name: 'Atlas AI',
        description: 'A focused product organization with eight autonomous delivery teams.',
        rootNodeId: root.id,
        updatedAt: new Date(NOW).toISOString(),
      },
    ],
    units: [root, ...containerUnits, ...teamUnits],
    relations: [
      {
        id: 'runtime-to-reliability',
        sourceNodeId: 'runtime-orchestration',
        targetNodeId: 'reliability-engineering',
        kind: 'communicates',
        sourceKind: 'manual',
        label: 'runtime health signals',
        weight: 3,
      },
      {
        id: 'workspace-to-quality',
        sourceNodeId: 'workspace-experience',
        targetNodeId: 'model-quality',
        kind: 'depends_on',
        sourceKind: 'manual',
        label: 'release quality gate',
        weight: 2,
      },
      {
        id: 'knowledge-to-provider',
        sourceNodeId: 'knowledge-retrieval',
        targetNodeId: 'provider-integrations',
        kind: 'observes',
        sourceKind: 'manual',
        label: 'provider response telemetry',
        weight: 1,
      },
    ],
    availableTeams: teams.map((team) => ({
      teamName: team.name,
      displayName: team.label,
      isOnline: false,
    })),
    source: 'configured',
    activeOrganizationId: ORGANIZATION_ID,
    updatedAt: new Date(NOW).toISOString(),
  };
}

async function writeJson(filePath, value) {
  const serialized = JSON.stringify(value, null, 2);
  if (/[Ѐ-ӿ]/u.test(serialized)) {
    throw new Error(`Screenshot demo must be English-only: ${filePath}`);
  }
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${serialized}\n`, 'utf8');
}

async function seed() {
  await rm(DEMO_ROOT, { recursive: true, force: true });
  await writeJson(path.join(CLAUDE_ROOT, 'agent-teams-config.json'), {
    general: {
      appLocale: 'en',
      agentLanguage: 'en',
      theme: 'dark',
      defaultTab: 'dashboard',
    },
  });
  await mkdir(path.join(CLAUDE_ROOT, 'projects'), { recursive: true });
  for (const folder of Object.values(projectFolders)) {
    const projectPath = path.join(WORKSPACE_ROOT, folder);
    await mkdir(projectPath, { recursive: true });
    await writeFile(
      path.join(projectPath, 'README.md'),
      `# ${folder
        .split('-')
        .map((word) => word[0].toUpperCase() + word.slice(1))
        .join(' ')}\n\nIsolated Atlas AI screenshot project.\n`,
      'utf8'
    );
  }

  for (const [teamIndex, team] of teams.entries()) {
    const tasks = buildTasks(team, teamIndex);
    await writeJson(
      path.join(CLAUDE_ROOT, 'teams', team.name, 'config.json'),
      buildTeamConfig(team, teamIndex)
    );
    await writeJson(
      path.join(CLAUDE_ROOT, 'teams', team.name, 'kanban-state.json'),
      buildKanbanState(team, tasks)
    );
    for (const task of tasks) {
      await writeJson(path.join(CLAUDE_ROOT, 'tasks', team.name, `${task.id}.json`), task);
    }
    if (team.name === 'runtime-orchestration') {
      const messages = buildRuntimeMessages(tasks);
      await writeJson(
        path.join(CLAUDE_ROOT, 'teams', team.name, 'inboxes', 'user.json'),
        messages.inbox
      );
      await writeJson(
        path.join(CLAUDE_ROOT, 'teams', team.name, 'sentMessages.json'),
        messages.sent
      );
    }
  }

  await writeJson(
    path.join(USER_DATA_ROOT, 'data', 'organizations', 'map.json'),
    buildOrganizationMap()
  );

  const activeTaskCount = teams.reduce((total, team) => total + team.inProgress.length, 0);
  const taskCount = teams.reduce(
    (total, team) =>
      total +
      team.inProgress.length +
      team.pending.length +
      team.review.length +
      team.completed.length +
      team.approved.length,
    0
  );
  console.log(`Created Atlas AI organization demo at ${DEMO_ROOT}`);
  console.log(
    `Organization: 1; hierarchy depth: 5; groups: ${containers.length}; teams: ${teams.length}`
  );
  console.log(`Tasks: ${taskCount}; in progress: ${activeTaskCount}`);
  console.log('Primary screenshot team: runtime-orchestration (22 tasks; 14 incoming messages)');
  console.log(`AGENT_TEAMS_ELECTRON_CLAUDE_ROOT=${CLAUDE_ROOT}`);
  console.log(`AGENT_TEAMS_ELECTRON_USER_DATA_DIR=${USER_DATA_ROOT}`);
}

await seed();
