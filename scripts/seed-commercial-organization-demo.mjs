import { mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const DEMO_ROOT = path.resolve(
  process.env.AGENT_TEAMS_COMMERCIAL_DEMO_ROOT ??
    path.join(os.tmpdir(), 'agent-teams-commercial-organization-demo')
);
const CLAUDE_ROOT = path.join(DEMO_ROOT, '.claude');
const USER_DATA_ROOT = path.join(DEMO_ROOT, 'user-data');
const PROJECT_PATH = path.resolve(process.cwd());
const ORGANIZATION_ID = 'commercial-organizations';
const NOW = '2026-07-14T14:00:00.000Z';

const teams = [
  {
    name: 'general-partnerships',
    label: 'Полные товарищества',
    parentId: 'commercial:business-partnerships',
    color: '#38bdf8',
  },
  {
    name: 'limited-partnerships',
    label: 'Товарищества на вере',
    parentId: 'commercial:business-partnerships',
    color: '#38bdf8',
  },
  {
    name: 'limited-liability-companies',
    label: 'Общества с ограниченной ответственностью',
    parentId: 'commercial:business-companies',
    color: '#22c55e',
  },
  {
    name: 'additional-liability-companies',
    label: 'Общества с дополнительной ответственностью',
    parentId: 'commercial:business-companies',
    color: '#22c55e',
  },
  {
    name: 'public-joint-stock-companies',
    label: 'Открытые акционерные общества',
    parentId: 'commercial:joint-stock-companies',
    color: '#a78bfa',
  },
  {
    name: 'private-joint-stock-companies',
    label: 'Закрытые акционерные общества',
    parentId: 'commercial:joint-stock-companies',
    color: '#a78bfa',
  },
  {
    name: 'production-cooperatives',
    label: 'Производственные кооперативы',
    parentId: 'commercial:root',
    color: '#f59e0b',
  },
  {
    name: 'federal-state-enterprises',
    label: 'Предприятия на праве оперативного управления',
    parentId: 'commercial:state-enterprises',
    color: '#fb7185',
  },
  {
    name: 'municipal-enterprises',
    label: 'Предприятия на праве хозяйственного ведения',
    parentId: 'commercial:municipal-enterprises',
    color: '#2dd4bf',
  },
];

const containers = [
  {
    id: 'commercial:partnerships-and-companies',
    parentId: 'commercial:root',
    label: 'Хозяйственные товарищества и общества',
    color: '#38bdf8',
  },
  {
    id: 'commercial:business-partnerships',
    parentId: 'commercial:partnerships-and-companies',
    label: 'Хозяйственные товарищества',
    color: '#38bdf8',
  },
  {
    id: 'commercial:business-companies',
    parentId: 'commercial:partnerships-and-companies',
    label: 'Хозяйственные общества',
    color: '#22c55e',
  },
  {
    id: 'commercial:joint-stock-companies',
    parentId: 'commercial:business-companies',
    label: 'Акционерные общества',
    color: '#a78bfa',
  },
  {
    id: 'commercial:unitary-enterprises',
    parentId: 'commercial:root',
    label: 'Унитарные предприятия',
    color: '#fb7185',
  },
  {
    id: 'commercial:state-enterprises',
    parentId: 'commercial:unitary-enterprises',
    label: 'Государственные предприятия',
    color: '#fb7185',
  },
  {
    id: 'commercial:municipal-enterprises',
    parentId: 'commercial:unitary-enterprises',
    label: 'Муниципальные предприятия',
    color: '#2dd4bf',
  },
];

function buildTeamConfig(team, index) {
  const lead = `lead-${index + 1}`;
  const specialist = `specialist-${index + 1}`;
  return {
    name: team.name,
    description: `Тестовая команда: ${team.label}`,
    createdAt: Date.parse(NOW) + index * 1000,
    leadAgentId: `${lead}@${team.name}`,
    members: [
      {
        agentId: `${lead}@${team.name}`,
        name: lead,
        agentType: 'team-lead',
        role: 'Руководитель команды',
        model: 'demo-model',
        color: 'blue',
        joinedAt: Date.parse(NOW) + index * 1000,
        cwd: PROJECT_PATH,
        subscriptions: [],
      },
      {
        agentId: `${specialist}@${team.name}`,
        name: specialist,
        agentType: 'general-purpose',
        role: 'Специалист',
        model: 'demo-model',
        color: 'green',
        joinedAt: Date.parse(NOW) + index * 1000 + 100,
        cwd: PROJECT_PATH,
        subscriptions: [],
      },
    ],
    projectPath: PROJECT_PATH,
    projectPathHistory: [PROJECT_PATH],
    language: 'ru',
  };
}

function buildTasks(team, index) {
  const baseTime = Date.parse(NOW) + index * 60_000;
  return [
    {
      id: `${team.name}-active`,
      displayId: `${index + 1}A`,
      subject: `Выполнить текущую работу: ${team.label}`,
      description: 'Тестовая активная задача для проверки ближнего semantic zoom.',
      owner: `lead-${index + 1}`,
      status: 'in_progress',
      createdAt: new Date(baseTime).toISOString(),
      updatedAt: new Date(baseTime + 30_000).toISOString(),
      blocks: [],
      blockedBy: [],
      reviewState: 'none',
    },
    {
      id: `${team.name}-pending`,
      displayId: `${index + 1}P`,
      subject: `Подготовить план развития: ${team.label}`,
      description: 'Тестовая запланированная задача.',
      owner: `specialist-${index + 1}`,
      status: 'pending',
      createdAt: new Date(baseTime + 1_000).toISOString(),
      updatedAt: new Date(baseTime + 1_000).toISOString(),
      blocks: [],
      blockedBy: [],
      reviewState: 'none',
    },
    {
      id: `${team.name}-completed`,
      displayId: `${index + 1}C`,
      subject: `Проверить регламент: ${team.label}`,
      description: 'Тестовая завершённая задача.',
      owner: `specialist-${index + 1}`,
      status: 'completed',
      createdAt: new Date(baseTime - 86_400_000).toISOString(),
      updatedAt: new Date(baseTime - 3_600_000).toISOString(),
      blocks: [],
      blockedBy: [],
      reviewState: 'none',
    },
  ];
}

function buildOrganizationMap() {
  const root = {
    id: 'commercial:root',
    organizationId: ORGANIZATION_ID,
    parentId: null,
    kind: 'organization',
    label: 'Коммерческие организации',
    description: 'Тестовая иерархия по образцу организационно-правовых форм.',
    color: '#4f8cff',
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
    description: `Тестовая команда: ${team.label}`,
    color: team.color,
    teamName: team.name,
  }));

  return {
    schemaVersion: 1,
    organizations: [
      {
        id: ORGANIZATION_ID,
        name: 'Коммерческие организации',
        description: 'Тестовая организация для проверки классической иерархии.',
        rootNodeId: root.id,
        updatedAt: NOW,
      },
    ],
    units: [root, ...containerUnits, ...teamUnits],
    relations: [],
    updatedAt: NOW,
  };
}

async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function seed() {
  await rm(DEMO_ROOT, { recursive: true, force: true });

  for (const [index, team] of teams.entries()) {
    await writeJson(
      path.join(CLAUDE_ROOT, 'teams', team.name, 'config.json'),
      buildTeamConfig(team, index)
    );
    const tasks = buildTasks(team, index);
    for (const task of tasks) {
      await writeJson(path.join(CLAUDE_ROOT, 'tasks', team.name, `${task.id}.json`), task);
    }
  }

  await writeJson(
    path.join(USER_DATA_ROOT, 'data', 'organizations', 'map.json'),
    buildOrganizationMap()
  );

  console.log(`Created commercial organization demo at ${DEMO_ROOT}`);
  console.log(`Teams: ${teams.length}; groups: ${containers.length}; organizations: 1`);
  console.log(`AGENT_TEAMS_ELECTRON_CLAUDE_ROOT=${CLAUDE_ROOT}`);
  console.log(`AGENT_TEAMS_ELECTRON_USER_DATA_DIR=${USER_DATA_ROOT}`);
}

await seed();
