import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const ORGANIZATION_GROUPS = [
  {
    id: 'growth',
    name: 'Growth Org',
    color: '#ff4fb3',
    groups: [
      'Acquisition',
      'Retention',
      'SEO',
      'Lifecycle',
      'Analytics',
      'Campaigns',
      'Community',
      'Conversion',
    ],
    colors: [
      '#f59e0b',
      '#10b981',
      '#fb7185',
      '#a78bfa',
      '#f97316',
      '#f43f5e',
      '#2dd4bf',
      '#84cc16',
    ],
  },
  {
    id: 'product',
    name: 'Product Org',
    color: '#4f8cff',
    groups: [
      'Platform',
      'Integrations',
      'Runtime',
      'Developer Experience',
      'Mobile',
      'Billing',
      'Workspace',
      'Ecosystem',
    ],
    colors: [
      '#38bdf8',
      '#a78bfa',
      '#60a5fa',
      '#818cf8',
      '#22c55e',
      '#fbbf24',
      '#06b6d4',
      '#c084fc',
    ],
  },
  {
    id: 'quality',
    name: 'Quality Org',
    color: '#22d3ee',
    groups: [
      'QA',
      'Release',
      'Security',
      'Observability',
      'Regression',
      'Performance',
      'Review',
      'Reliability',
    ],
    colors: [
      '#06b6d4',
      '#14b8a6',
      '#f59e0b',
      '#22d3ee',
      '#8b5cf6',
      '#eab308',
      '#2dd4bf',
      '#0ea5e9',
    ],
  },
  {
    id: 'operations',
    name: 'Operations Org',
    color: '#94a3b8',
    groups: [
      'Infrastructure',
      'Support',
      'Automation',
      'Research',
      'Onboarding',
      'Tooling',
      'Data Ops',
      'Incident Response',
    ],
    colors: [
      '#64748b',
      '#34d399',
      '#f97316',
      '#a78bfa',
      '#38bdf8',
      '#f472b6',
      '#22c55e',
      '#ef4444',
    ],
  },
];

const SAMPLE_TEAMS = [
  'atlas-hq',
  'beacon-desk',
  'forge-labs',
  'relay-works',
  'signal-ops',
  'vector-room',
  'launchpad',
  'mission-control',
  'super-robots',
  'quality-gate',
  'runtime-watch',
  'growth-loop',
];

const args = new Set(process.argv.slice(2));

function slug(value, fallback = 'item') {
  const normalized = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || fallback;
}

function getAppDataBasePath() {
  if (process.env.AGENT_TEAMS_APP_DATA_DIR) {
    return process.env.AGENT_TEAMS_APP_DATA_DIR;
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'agent-teams-ai');
  }
  if (process.platform === 'win32') {
    return path.join(
      process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'),
      'agent-teams-ai'
    );
  }
  return path.join(
    process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'),
    'agent-teams-ai'
  );
}

async function pathExists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readTeamNames() {
  const teamsDir = path.join(os.homedir(), '.claude', 'teams');
  const entries = await readdir(teamsDir, { withFileTypes: true }).catch(() => []);
  const teamNames = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const fallbackName = entry.name;
    const configPath = path.join(teamsDir, entry.name, 'config.json');
    const rawConfig = await readFile(configPath, 'utf8').catch(() => null);
    if (!rawConfig) {
      teamNames.push(fallbackName);
      continue;
    }
    try {
      const config = JSON.parse(rawConfig);
      const teamName = typeof config.teamName === 'string' ? config.teamName : fallbackName;
      teamNames.push(teamName);
    } catch {
      teamNames.push(fallbackName);
    }
  }

  return [...new Set(teamNames)].sort((left, right) => left.localeCompare(right));
}

async function restoreDemoMap(mapPath, backupPath) {
  const backup = await readFile(backupPath, 'utf8').catch(() => null);
  if (backup === null) {
    console.log('No organization demo backup found.');
    return;
  }
  if (backup.length === 0) {
    await rm(mapPath, { force: true });
    await rm(backupPath, { force: true });
    console.log('Removed demo organization map and empty backup marker.');
    return;
  }
  await writeFile(mapPath, backup, 'utf8');
  await rm(backupPath, { force: true });
  console.log('Restored organization map backup.');
}

async function seedDemoMap(mapPath, backupPath) {
  await mkdir(path.dirname(mapPath), { recursive: true });
  if (!(await pathExists(backupPath))) {
    const current = await readFile(mapPath, 'utf8').catch(() => '');
    await writeFile(backupPath, current, 'utf8');
  }

  const discoveredTeamNames = await readTeamNames();
  const teamNames = discoveredTeamNames.length > 0 ? discoveredTeamNames : SAMPLE_TEAMS;
  const unassignedCount = Math.min(4, Math.max(0, teamNames.length - 1));
  const assignedTeamNames = teamNames.slice(0, teamNames.length - unassignedCount);
  const now = new Date().toISOString();

  const organizations = ORGANIZATION_GROUPS.map((organization) => ({
    id: organization.id,
    name: organization.name,
    rootNodeId: `${organization.id}:root`,
    updatedAt: now,
  }));

  const units = [];
  const groupTargets = [];
  for (const organization of ORGANIZATION_GROUPS) {
    units.push({
      id: `${organization.id}:root`,
      organizationId: organization.id,
      parentId: null,
      kind: 'organization',
      label: organization.name,
      color: organization.color,
    });

    organization.groups.forEach((groupName, index) => {
      const groupId = `${organization.id}:${slug(groupName)}`;
      units.push({
        id: groupId,
        organizationId: organization.id,
        parentId: `${organization.id}:root`,
        kind: 'container',
        label: `${groupName} Group`,
        color: organization.colors[index % organization.colors.length],
      });
      groupTargets.push({ organizationId: organization.id, groupId });
    });
  }

  assignedTeamNames.forEach((teamName, index) => {
    const target = groupTargets[index % groupTargets.length];
    units.push({
      id: `team:${slug(teamName, 'team')}`,
      organizationId: target.organizationId,
      parentId: target.groupId,
      kind: 'team',
      label: teamName,
      teamName,
    });
  });

  const relationTeams = assignedTeamNames.slice(0, 5);
  const relations = relationTeams.slice(0, -1).map((teamName, index) => ({
    id: `demo-relation-${index + 1}`,
    organizationId: ORGANIZATION_GROUPS[index % ORGANIZATION_GROUPS.length].id,
    sourceNodeId: `team:${slug(teamName, 'team')}`,
    targetNodeId: `team:${slug(relationTeams[index + 1], 'team')}`,
    kind: index % 2 === 0 ? 'handoff' : 'review',
    label: index % 2 === 0 ? 'Demo handoff' : 'Demo review',
    weight: index + 1,
  }));

  await writeFile(
    mapPath,
    JSON.stringify(
      {
        schemaVersion: 1,
        organizations,
        units,
        relations,
        activeOrganizationId: ORGANIZATION_GROUPS[0].id,
        updatedAt: now,
      },
      null,
      2
    ),
    'utf8'
  );

  console.log(
    `Seeded organization demo map: ${organizations.length} orgs, ${assignedTeamNames.length} placed teams, ${unassignedCount} left unassigned.`
  );
}

const mapPath = path.join(getAppDataBasePath(), 'data', 'organizations', 'map.json');
const backupPath = path.join(path.dirname(mapPath), 'map.demo-backup.json');

if (args.has('--restore')) {
  await restoreDemoMap(mapPath, backupPath);
} else {
  await seedDemoMap(mapPath, backupPath);
}
