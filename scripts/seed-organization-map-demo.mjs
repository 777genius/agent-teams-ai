import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const DEMO_ORGANIZATIONS = [
  {
    id: 'nova-hq',
    name: 'Nova AI Holdings',
    description: 'Executive layer that coordinates an autonomous AI-agent business.',
    color: '#4f8cff',
    groups: [
      {
        id: 'executive-command',
        label: 'Executive Command',
        color: '#60a5fa',
        teams: ['CEO Copilot Office', 'Board Intelligence', 'Strategy Simulation'],
      },
      {
        id: 'capital-and-planning',
        label: 'Capital & Planning',
        color: '#fbbf24',
        teams: ['Finance Forecasting', 'Pricing Council'],
      },
      {
        id: 'people-systems',
        label: 'People Systems',
        color: '#a78bfa',
        teams: ['Talent Marketplace', 'Agent Enablement'],
      },
      {
        id: 'market-intelligence',
        label: 'Market Intelligence',
        color: '#2dd4bf',
        teams: ['Competitive Radar', 'Board Briefing Room', 'Scenario War Room'],
      },
    ],
  },
  {
    id: 'product-platform',
    name: 'Product & Platform Org',
    description: 'Builds the product surface, runtime, connectors, and developer ecosystem.',
    color: '#38bdf8',
    groups: [
      {
        id: 'product-studios',
        label: 'Product Studios',
        color: '#8b5cf6',
        groups: [
          {
            id: 'workbench-studio',
            label: 'Workbench Studio',
            color: '#a78bfa',
            teams: [
              'Command Center UI',
              'Workflow Builder',
              'Team Graph Experience',
              'Inbox & Briefings',
              'Decision Review',
              'Mobile Control Room',
            ],
          },
          {
            id: 'admin-commerce',
            label: 'Admin & Commerce',
            color: '#f59e0b',
            teams: ['Billing Automation', 'Usage Metering', 'Plan Packaging', 'Procurement Portal'],
          },
          {
            id: 'collaboration-layer',
            label: 'Collaboration Layer',
            color: '#22c55e',
            teams: ['Shared Workspaces', 'Comments & Approvals', 'Knowledge Rooms'],
          },
        ],
      },
      {
        id: 'agent-runtime-platform',
        label: 'Agent Runtime Platform',
        color: '#0ea5e9',
        groups: [
          {
            id: 'orchestration-kernel',
            label: 'Orchestration Kernel',
            color: '#38bdf8',
            teams: [
              'Task Router',
              'Agent Scheduler',
              'Run State Machine',
              'Lifecycle Watchdog',
              'Prompt Compiler',
              'Context Window Manager',
              'Tool Call Broker',
              'Execution Sandbox',
            ],
          },
          {
            id: 'provider-connectors',
            label: 'Provider Connectors',
            color: '#818cf8',
            teams: [
              'Anthropic Connector',
              'Codex Connector',
              'OpenCode Connector',
              'Model Routing',
              'Credential Vault',
            ],
          },
          {
            id: 'memory-and-context',
            label: 'Memory & Context',
            color: '#14b8a6',
            teams: [
              'Long-Term Memory',
              'Retrieval Index',
              'Project Context Sync',
              'Artifact Store',
            ],
          },
        ],
      },
      {
        id: 'ecosystem',
        label: 'Ecosystem',
        color: '#c084fc',
        groups: [
          {
            id: 'integration-marketplace',
            label: 'Integration Marketplace',
            color: '#f472b6',
            teams: [
              'GitHub Apps',
              'Linear & Jira Sync',
              'Slack Control Plane',
              'Figma Workflow',
              'Database Connectors',
              'Browser Automation',
              'Calendar Agents',
              'Docs Publishing',
              'CRM Bridge',
              'Webhook Studio',
            ],
          },
          {
            id: 'developer-experience',
            label: 'Developer Experience',
            color: '#60a5fa',
            teams: [
              'SDK & CLI',
              'Plugin Builder',
              'Template Gallery',
              'Local Dev Server',
              'Testing Harness',
              'Docs Examples',
              'Migration Tools',
              'Release Notes',
            ],
          },
        ],
      },
      {
        id: 'data-knowledge-layer',
        label: 'Data & Knowledge Layer',
        color: '#2dd4bf',
        teams: [
          'Knowledge Graph',
          'Semantic Search',
          'Customer Data Hub',
          'Analytics Warehouse',
          'Event Taxonomy',
          'Dataset Curation',
          'Insight Generation',
          'Data Quality Monitor',
        ],
      },
      {
        id: 'design-systems',
        label: 'Design Systems',
        color: '#e879f9',
        teams: [
          'Interface Patterns',
          'Design Tokens',
          'Prototype Lab',
          'Motion Language',
          'Accessibility Systems',
          'Visual QA',
        ],
      },
    ],
  },
  {
    id: 'revenue-customer',
    name: 'Revenue & Customer Org',
    description: 'Turns product capability into pipeline, onboarding, expansion, and support.',
    color: '#ff4fb3',
    groups: [
      {
        id: 'growth-engine',
        label: 'Growth Engine',
        color: '#fb7185',
        teams: [
          'Acquisition Strategy',
          'Landing Page Lab',
          'SEO Intelligence',
          'Paid Media Optimizer',
          'Conversion Research',
          'Lifecycle Campaigns',
          'Email Personalization',
          'Experiment Analysis',
          'Community Growth',
          'Referral Loops',
          'Content Repurposing',
          'Product-Led Growth',
          'Persona Research',
          'Demand Forecasting',
        ],
      },
      {
        id: 'sales-automation',
        label: 'Sales Automation',
        color: '#f97316',
        teams: [
          'Outbound Prospecting',
          'Account Research',
          'Demo Personalization',
          'Proposal Builder',
          'Sales Engineering',
          'Deal Desk',
          'Pipeline Hygiene',
          'Win-Loss Analysis',
        ],
      },
      {
        id: 'customer-success',
        label: 'Customer Success',
        color: '#10b981',
        teams: [
          'Onboarding Concierge',
          'Implementation Guides',
          'Health Score Analysts',
          'Expansion Playbooks',
          'Renewal Desk',
          'Executive Business Review',
          'Customer Education',
          'Use Case Mining',
          'Adoption Nudges',
          'Voice of Customer',
          'Reference Program',
        ],
      },
      {
        id: 'support-operations',
        label: 'Support Operations',
        color: '#06b6d4',
        teams: [
          'Triage Desk',
          'Incident Comms',
          'Knowledge Base',
          'Ticket Summaries',
          'Escalation Routing',
          'Bug Reproduction',
          'Customer Sentiment',
          'Support QA',
        ],
      },
      {
        id: 'partners-and-community',
        label: 'Partners & Community',
        color: '#a3e635',
        teams: [
          'Agency Partners',
          'Solution Templates',
          'Community Moderation',
          'Events Programming',
          'Certification Program',
          'Partner Enablement',
          'Creator Relations',
          'Ambassador Ops',
        ],
      },
    ],
  },
  {
    id: 'trust-research-ops',
    name: 'Trust, Research & Ops Org',
    description: 'Keeps the autonomous business safe, observable, compliant, and improving.',
    color: '#22d3ee',
    groups: [
      {
        id: 'quality-evaluation',
        label: 'Quality & Evaluation',
        color: '#22d3ee',
        teams: [
          'Regression Evaluators',
          'Answer Quality',
          'Task Success Scoring',
          'UX Acceptance',
          'Benchmark Lab',
          'Release Gates',
          'Review Summaries',
          'Localization QA',
          'Performance Profiling',
          'Accessibility Review',
        ],
      },
      {
        id: 'security-compliance',
        label: 'Security & Compliance',
        color: '#f59e0b',
        teams: [
          'Policy Guardrails',
          'Permission Review',
          'Secret Scanning',
          'Audit Evidence',
          'Vendor Risk',
          'Data Retention',
          'Red Team Simulations',
        ],
      },
      {
        id: 'reliability-operations',
        label: 'Reliability Operations',
        color: '#64748b',
        teams: [
          'Runtime Observability',
          'Queue Health',
          'Cost Anomaly Watch',
          'SLA Monitor',
          'Incident Commander',
          'Rollback Automation',
          'Capacity Planning',
          'Postmortem Writer',
        ],
      },
      {
        id: 'applied-research',
        label: 'Applied Research',
        color: '#a78bfa',
        teams: [
          'Model Evaluation',
          'Multi-Agent Planning',
          'Synthetic Data',
          'Tool Use Research',
          'Human Feedback Lab',
          'Frontier Experiments',
        ],
      },
      {
        id: 'data-operations',
        label: 'Data Operations',
        color: '#2dd4bf',
        teams: ['Warehouse Agents', 'Metric Definitions', 'Data Contracts', 'Insight Briefings'],
      },
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
  if (process.env.AGENT_TEAMS_ELECTRON_USER_DATA_DIR) {
    return process.env.AGENT_TEAMS_ELECTRON_USER_DATA_DIR;
  }
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

function getClaudeRootPath() {
  const override = process.env.AGENT_TEAMS_ELECTRON_CLAUDE_ROOT?.trim();
  if (override && path.isAbsolute(override)) {
    return path.resolve(override);
  }
  return path.join(os.homedir(), '.claude');
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
  const teamsDir = path.join(getClaudeRootPath(), 'teams');
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

function addGroupUnits(params) {
  const { organization, group, parentId, pathParts, units, teamSlots, organizationOrder } = params;
  const groupSlug = group.id ?? slug(group.label, 'group');
  const groupPathParts = [...pathParts, groupSlug];
  const groupId = `${organization.id}:${groupPathParts.join(':')}`;
  const groupOrder = teamSlots.groupOrder;
  teamSlots.groupOrder += 1;

  units.push({
    id: groupId,
    organizationId: organization.id,
    parentId,
    kind: 'container',
    label: group.label,
    description: group.description,
    color: group.color,
    tags: group.tags,
  });

  (group.teams ?? []).forEach((label, index) => {
    teamSlots.items.push({
      organizationId: organization.id,
      parentId: groupId,
      label,
      color: group.color,
      tier: index,
      organizationOrder,
      groupOrder,
    });
  });

  for (const childGroup of group.groups ?? []) {
    addGroupUnits({
      organization,
      group: childGroup,
      parentId: groupId,
      pathParts: groupPathParts,
      units,
      teamSlots,
      organizationOrder,
    });
  }
}

function buildOrganizationUnitsAndSlots() {
  const units = [];
  const teamSlots = { items: [], groupOrder: 0 };

  DEMO_ORGANIZATIONS.forEach((organization, organizationOrder) => {
    const rootId = `${organization.id}:root`;
    units.push({
      id: rootId,
      organizationId: organization.id,
      parentId: null,
      kind: 'organization',
      label: organization.name,
      description: organization.description,
      color: organization.color,
    });

    for (const group of organization.groups) {
      addGroupUnits({
        organization,
        group,
        parentId: rootId,
        pathParts: [],
        units,
        teamSlots,
        organizationOrder,
      });
    }
  });

  return { units, teamSlots: teamSlots.items };
}

function ensureEnoughDemoSlots(units, teamSlots, requiredCount) {
  if (teamSlots.length >= requiredCount) {
    return;
  }

  const organization = DEMO_ORGANIZATIONS[DEMO_ORGANIZATIONS.length - 1];
  const overflowGroupId = `${organization.id}:venture-backlog`;
  if (!units.some((unit) => unit.id === overflowGroupId)) {
    units.push({
      id: overflowGroupId,
      organizationId: organization.id,
      parentId: `${organization.id}:root`,
      kind: 'container',
      label: 'Autonomous Venture Backlog',
      description: 'Overflow demo pods for large local team directories.',
      color: '#94a3b8',
    });
  }

  while (teamSlots.length < requiredCount) {
    const index = teamSlots.length + 1;
    teamSlots.push({
      organizationId: organization.id,
      parentId: overflowGroupId,
      label: `Venture Pod ${index}`,
      color: '#94a3b8',
      tier: index,
      organizationOrder: DEMO_ORGANIZATIONS.length - 1,
      groupOrder: Number.MAX_SAFE_INTEGER,
    });
  }
}

function sortDemoTeamSlots(teamSlots) {
  return teamSlots.slice().sort((left, right) => {
    const tierDelta = left.tier - right.tier;
    if (tierDelta !== 0) return tierDelta;
    const organizationDelta = left.organizationOrder - right.organizationOrder;
    if (organizationDelta !== 0) return organizationDelta;
    return left.groupOrder - right.groupOrder;
  });
}

function findPlacedTeam(placedTeams, labelPattern, fallbackIndex) {
  return (
    placedTeams.find((team) => labelPattern.test(team.label)) ??
    placedTeams[fallbackIndex % Math.max(1, placedTeams.length)] ??
    null
  );
}

function buildDemoRelations(placedTeams) {
  const specs = [
    {
      source: /Task Router|Agent Scheduler/,
      target: /Sales Engineering|Demo Personalization/,
      kind: 'delegates',
      label: 'enterprise demo handoff',
    },
    {
      source: /Workflow Builder|Command Center UI/,
      target: /Customer Education|Onboarding Concierge/,
      kind: 'communicates',
      label: 'onboarding feedback loop',
    },
    {
      source: /Model Routing|Provider Connectors|Anthropic Connector/,
      target: /Policy Guardrails|Permission Review/,
      kind: 'depends_on',
      label: 'provider safety review',
    },
    {
      source: /Landing Page Lab|Conversion Research/,
      target: /Experiment Analysis|Product-Led Growth/,
      kind: 'observes',
      label: 'growth experiment telemetry',
    },
    {
      source: /Support Operations|Triage Desk/,
      target: /Bug Reproduction|Regression Evaluators/,
      kind: 'delegates',
      label: 'support escalation',
    },
    {
      source: /Runtime Observability|Queue Health/,
      target: /Incident Commander|Rollback Automation/,
      kind: 'communicates',
      label: 'incident command stream',
    },
    {
      source: /Knowledge Graph|Semantic Search/,
      target: /Insight Generation|Board Briefing Room/,
      kind: 'observes',
      label: 'executive insight feed',
    },
    {
      source: /GitHub Apps|Webhook Studio/,
      target: /SDK & CLI|Plugin Builder/,
      kind: 'depends_on',
      label: 'developer ecosystem sync',
    },
  ];

  return specs
    .map((spec, index) => {
      const source = findPlacedTeam(placedTeams, spec.source, index);
      const target = findPlacedTeam(placedTeams, spec.target, index + 7);
      if (!source || !target || source.teamName === target.teamName) {
        return null;
      }
      return {
        id: `demo-relation-${index + 1}`,
        sourceNodeId: source.teamName,
        targetNodeId: target.teamName,
        kind: spec.kind,
        sourceKind: 'manual',
        label: spec.label,
        weight: index + 1,
      };
    })
    .filter(Boolean);
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

  const organizations = DEMO_ORGANIZATIONS.map((organization) => ({
    id: organization.id,
    name: organization.name,
    description: organization.description,
    rootNodeId: `${organization.id}:root`,
    updatedAt: now,
  }));

  const { units, teamSlots } = buildOrganizationUnitsAndSlots();
  ensureEnoughDemoSlots(units, teamSlots, assignedTeamNames.length);
  const sortedTeamSlots = sortDemoTeamSlots(teamSlots);
  const placedTeams = [];

  assignedTeamNames.forEach((teamName, index) => {
    const target = sortedTeamSlots[index];
    units.push({
      id: `team:${slug(teamName, 'team')}`,
      organizationId: target.organizationId,
      parentId: target.parentId,
      kind: 'team',
      label: target.label,
      color: target.color,
      teamName,
    });
    placedTeams.push({ ...target, teamName });
  });

  const relations = buildDemoRelations(placedTeams);

  await writeFile(
    mapPath,
    JSON.stringify(
      {
        schemaVersion: 1,
        organizations,
        units,
        relations,
        availableTeams: teamNames.map((teamName) => ({
          teamName,
          displayName: teamName,
          isOnline: false,
        })),
        source: 'configured',
        activeOrganizationId: DEMO_ORGANIZATIONS[0].id,
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
