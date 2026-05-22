import * as agentTeamsControllerModule from 'agent-teams-controller';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { getConfiguredAgentLanguageName } from './TeamProvisioningAgentLanguage';

import type { NativeAppManagedBootstrapSpec } from '../bootstrap/NativeAppManagedBootstrapContextBuilder';
import type {
  EffortLevel,
  TeamCreateRequest,
  TeamLaunchRequest,
  TeamProviderId,
} from '@shared/types';

const { AGENT_TEAMS_NAMESPACED_LEAD_BOOTSTRAP_TOOL_NAMES } = agentTeamsControllerModule;
const RUN_TIMEOUT_MS = 300_000;

export interface TeamProvisioningRunTimeoutInput {
  deterministicBootstrap: boolean;
  effectiveMembers: TeamCreateRequest['members'];
}

interface RuntimeBootstrapMemberSpec {
  name: string;
  prompt?: string;
  cwd?: string;
  model?: string;
  provider?: TeamProviderId;
  effort?: EffortLevel;
  isolation?: 'worktree';
  agentType?: string;
  description?: string;
  useSplitPane?: boolean;
  planModeRequired?: boolean;
  mcpConfigPath?: string;
  mcpSettingSources?: string;
  strictMcpConfig?: boolean;
  nativeAppManagedBootstrap?: NativeAppManagedBootstrapSpec;
}

export interface RuntimeBootstrapMemberMcpLaunchConfig {
  mcpConfigPath: string;
  mcpSettingSources: string;
  strictMcpConfig: boolean;
}

export interface RuntimeBootstrapSpec {
  version: 1;
  runId: string;
  mode: 'create' | 'launch';
  initiator: {
    kind: 'app';
    source: 'claude_team_agent_teams_orchestrator';
  };
  team: {
    name: string;
    displayName?: string;
    description?: string;
    color?: string;
    cwd: string;
  };
  lead: {
    agentLanguage?: string;
    permissionSeedTools?: string[];
  };
  members: RuntimeBootstrapMemberSpec[];
  launch?: {
    bootstrapTimeoutMs?: number;
    continueOnPartialFailure?: boolean;
  };
  ui?: {
    emitStructuredEvents?: boolean;
  };
}

const DETERMINISTIC_BOOTSTRAP_MIN_TIMEOUT_MS = 120_000;
const DETERMINISTIC_BOOTSTRAP_TIMEOUT_PER_MEMBER_MS = 75_000;
const DETERMINISTIC_BOOTSTRAP_MAX_TIMEOUT_MS = 900_000;
const DETERMINISTIC_BOOTSTRAP_OUTER_TIMEOUT_GRACE_MS = 30_000;

export function getDeterministicBootstrapTimeoutMs(memberCount: number): number {
  const perMemberBudget = Math.max(0, memberCount) * DETERMINISTIC_BOOTSTRAP_TIMEOUT_PER_MEMBER_MS;
  return Math.min(
    DETERMINISTIC_BOOTSTRAP_MAX_TIMEOUT_MS,
    Math.max(DETERMINISTIC_BOOTSTRAP_MIN_TIMEOUT_MS, perMemberBudget)
  );
}

export function getProvisioningRunTimeoutMs(run: TeamProvisioningRunTimeoutInput): number {
  if (!run.deterministicBootstrap) {
    return RUN_TIMEOUT_MS;
  }

  return Math.max(
    RUN_TIMEOUT_MS,
    getDeterministicBootstrapTimeoutMs(run.effectiveMembers.length) +
      DETERMINISTIC_BOOTSTRAP_OUTER_TIMEOUT_GRACE_MS
  );
}

export function buildDeterministicCreateBootstrapSpec(
  runId: string,
  request: TeamCreateRequest,
  effectiveMembers: TeamCreateRequest['members'],
  nativeAppManagedBootstrapByMember: ReadonlyMap<string, NativeAppManagedBootstrapSpec> = new Map(),
  mcpLaunchConfigByMember: ReadonlyMap<string, RuntimeBootstrapMemberMcpLaunchConfig> = new Map()
): RuntimeBootstrapSpec {
  return {
    version: 1,
    runId,
    mode: 'create',
    initiator: {
      kind: 'app',
      source: 'claude_team_agent_teams_orchestrator',
    },
    team: {
      name: request.teamName,
      ...(request.displayName?.trim() ? { displayName: request.displayName.trim() } : {}),
      ...(request.description?.trim() ? { description: request.description.trim() } : {}),
      ...(request.color?.trim() ? { color: request.color.trim() } : {}),
      cwd: request.cwd,
    },
    lead: {
      agentLanguage: getConfiguredAgentLanguageName(),
      ...(request.skipPermissions === false
        ? {
            permissionSeedTools: [
              ...AGENT_TEAMS_NAMESPACED_LEAD_BOOTSTRAP_TOOL_NAMES,
              'Edit',
              'Write',
              'NotebookEdit',
            ],
          }
        : {}),
    },
    members: effectiveMembers.map((member) => {
      const mcpLaunchConfig = mcpLaunchConfigByMember.get(member.name);
      return {
        name: member.name,
        ...(member.role?.trim() ? { role: member.role.trim() } : {}),
        ...(member.workflow?.trim() ? { workflow: member.workflow.trim() } : {}),
        ...(request.cwd ? { cwd: request.cwd } : {}),
        ...(member.model?.trim() ? { model: member.model.trim() } : {}),
        ...(member.providerId ? { provider: member.providerId } : {}),
        ...(member.effort ? { effort: member.effort } : {}),
        ...(member.isolation === 'worktree' ? { isolation: 'worktree' as const } : {}),
        ...(member.role?.trim() ? { description: member.role.trim() } : {}),
        ...(mcpLaunchConfig ? mcpLaunchConfig : {}),
        ...(nativeAppManagedBootstrapByMember.get(member.name)
          ? { nativeAppManagedBootstrap: nativeAppManagedBootstrapByMember.get(member.name)! }
          : {}),
      };
    }),
    launch: {
      bootstrapTimeoutMs: getDeterministicBootstrapTimeoutMs(effectiveMembers.length),
      continueOnPartialFailure: true,
    },
    ui: {
      emitStructuredEvents: true,
    },
  };
}

export function buildDeterministicLaunchBootstrapSpec(
  runId: string,
  request: TeamLaunchRequest,
  effectiveMembers: TeamCreateRequest['members'],
  nativeAppManagedBootstrapByMember: ReadonlyMap<string, NativeAppManagedBootstrapSpec> = new Map(),
  mcpLaunchConfigByMember: ReadonlyMap<string, RuntimeBootstrapMemberMcpLaunchConfig> = new Map()
): RuntimeBootstrapSpec {
  return {
    version: 1,
    runId,
    mode: 'launch',
    initiator: {
      kind: 'app',
      source: 'claude_team_agent_teams_orchestrator',
    },
    team: {
      name: request.teamName,
      cwd: request.cwd,
    },
    lead: {
      agentLanguage: getConfiguredAgentLanguageName(),
      ...(request.skipPermissions === false
        ? {
            permissionSeedTools: [
              ...AGENT_TEAMS_NAMESPACED_LEAD_BOOTSTRAP_TOOL_NAMES,
              'Edit',
              'Write',
              'NotebookEdit',
            ],
          }
        : {}),
    },
    members: effectiveMembers.map((member) => {
      const mcpLaunchConfig = mcpLaunchConfigByMember.get(member.name);
      return {
        name: member.name,
        ...(request.cwd ? { cwd: request.cwd } : {}),
        ...(member.model?.trim() ? { model: member.model.trim() } : {}),
        ...(member.providerId ? { provider: member.providerId } : {}),
        ...(member.effort ? { effort: member.effort } : {}),
        ...(member.isolation === 'worktree' ? { isolation: 'worktree' as const } : {}),
        ...(member.role?.trim() ? { role: member.role.trim() } : {}),
        ...(member.workflow?.trim() ? { workflow: member.workflow.trim() } : {}),
        ...(member.role?.trim() ? { description: member.role.trim() } : {}),
        ...(mcpLaunchConfig ? mcpLaunchConfig : {}),
        ...(nativeAppManagedBootstrapByMember.get(member.name)
          ? { nativeAppManagedBootstrap: nativeAppManagedBootstrapByMember.get(member.name)! }
          : {}),
      };
    }),
    launch: {
      bootstrapTimeoutMs: getDeterministicBootstrapTimeoutMs(effectiveMembers.length),
      continueOnPartialFailure: true,
    },
    ui: {
      emitStructuredEvents: true,
    },
  };
}

export async function writeDeterministicBootstrapSpecFile(
  spec: RuntimeBootstrapSpec
): Promise<string> {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'agent-teams-bootstrap-'));
  const filePath = path.join(tempDir, `${spec.team.name}-${randomUUID()}.json`);
  await fs.promises.writeFile(filePath, JSON.stringify(spec), {
    encoding: 'utf8',
    mode: 0o600,
  });
  return filePath;
}

async function removeDeterministicBootstrapTempFile(filePath: string | null): Promise<void> {
  if (!filePath) return;
  await fs.promises.rm(filePath, { force: true }).catch(() => {});
  await fs.promises.rmdir(path.dirname(filePath)).catch(() => {});
}

export async function removeDeterministicBootstrapSpecFile(filePath: string | null): Promise<void> {
  await removeDeterministicBootstrapTempFile(filePath);
}

export async function writeDeterministicBootstrapUserPromptFile(prompt: string): Promise<string> {
  const tempDir = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), 'agent-teams-bootstrap-prompt-')
  );
  const filePath = path.join(tempDir, `${randomUUID()}.txt`);
  await fs.promises.writeFile(filePath, prompt, {
    encoding: 'utf8',
    mode: 0o600,
  });
  return filePath;
}

export async function removeDeterministicBootstrapUserPromptFile(
  filePath: string | null
): Promise<void> {
  await removeDeterministicBootstrapTempFile(filePath);
}
