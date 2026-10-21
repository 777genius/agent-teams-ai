import { join } from 'node:path';
import { createClaudeDriverFactory } from '@agent-teams/provider-implementations/claude';

import { CapturedClaudeProcess } from './CapturedClaudeProcess.js';
import { claudeSessionExists } from './claudeSessionExists.js';
import { createTeamMcpTools } from '../../mcp/tools.js';

import type { ClaudeConfig } from '@agent-teams/provider-implementations/claude';
import type { DriverFactory, OpenConfig, Session } from '@agent-teams/provider-session-contracts';
import type { TeamMcpEndpoint, TeamMcpConnection } from '../../mcp/contracts.js';
import type { RuntimeMemberProfile } from '../../composition/runtimeProfile.js';

export interface MemberProviderContext {
  profile: RuntimeMemberProfile;
  request: OpenConfig;
  endpoint: TeamMcpEndpoint;
  connection: TeamMcpConnection;
  instructions: string;
  isCurrent(): boolean;
  canAllocate(): boolean;
  readCheckpoint(reference: string, request: OpenConfig): Promise<unknown>;
  onProgress(): void;
}

export interface MemberProvider {
  factory: DriverFactory;
  isReady(): boolean;
  seal(): void;
  cleanup(): Promise<boolean>;
}

/** Outer adapter builds one selected D configuration; all native protocol/SDK logic stays in D. */
export function createClaudeMemberProvider(context: MemberProviderContext): MemberProvider {
  const { profile } = context;
  const custody = new CapturedClaudeProcess(profile, context.canAllocate);
  let ready = false;
  let sealed = false;
  const required = createTeamMcpTools(context.connection)
    .list()
    .map((tool) => tool.name);
  const config: ClaudeConfig = {
    sessionRef: profile.sessionId,
    // Stable principal scope across technical generations; MCP and Runtime separately fence generation.
    trustedBinding: `${context.endpoint.binding.backendId}/${context.endpoint.binding.teamId}/${context.endpoint.binding.runId}/${profile.memberId}`,
    cwd: profile.cwd,
    model: profile.model,
    accountBinding: profile.accountBinding,
    configRevision: profile.configRevision,
    environment: { ...profile.environment },
    ...(profile.configNamespace ? { configNamespace: profile.configNamespace } : {}),
    nativeOptions: {
      ...(profile.nativeOptions?.permissionMode !== undefined
        ? { permissionMode: profile.nativeOptions.permissionMode }
        : {}),
      ...(profile.nativeOptions?.allowDangerouslySkipPermissions !== undefined
        ? { allowDangerouslySkipPermissions: profile.nativeOptions.allowDangerouslySkipPermissions }
        : {}),
      ...(profile.nativeOptions?.settingSources !== undefined
        ? { settingSources: profile.nativeOptions.settingSources }
        : {}),
      ...(profile.nativeOptions?.effort !== undefined
        ? { effort: profile.nativeOptions.effort }
        : {}),
      ...(profile.nativeOptions?.fastMode !== undefined
        ? { fastMode: profile.nativeOptions.fastMode }
        : {}),
      ...(profile.nativeOptions?.context !== undefined
        ? { context: profile.nativeOptions.context }
        : {}),
      projectInstructions: {
        append: [context.instructions, profile.nativeOptions?.projectInstructions?.append]
          .filter(Boolean)
          .join('\n\n'),
      },
    },
    nativeTools: [...profile.nativeTools],
    autoAllowedTools: [
      ...new Set([...profile.autoAllowedTools, ...required.map((name) => `mcp__team__${name}`)]),
    ],
    mcpServers: {
      team: {
        type: 'http',
        url: context.endpoint.url,
        headers: { Authorization: `Bearer ${context.endpoint.bearerToken}` },
      },
    },
    requiredTools: { team: required },
    probe: async () => !sealed && context.isCurrent(),
    limits: { ...profile.limits },
    sessionExists: async (nativeSession) => {
      const directory =
        profile.configNamespace === 'native-default'
          ? join(profile.environment.HOME!, '.claude')
          : profile.environment.CLAUDE_CONFIG_DIR;
      if (!directory) return false;
      return claudeSessionExists(directory.normalize('NFC'), profile.cwd, nativeSession);
    },
    custody: { launch: custody.launch, confirmStopped: () => custody.confirmStopped() },
  };
  const native = createClaudeDriverFactory({
    capabilities: ['session.conversation'],
    resolveConfiguration: async (request) =>
      !sealed && context.isCurrent() && JSON.stringify(request) === JSON.stringify(context.request)
        ? config
        : undefined,
    readCheckpoint: context.readCheckpoint,
  });
  return {
    factory: {
      async open(request) {
        const opened = await native.open(request);
        const source = opened.driver;
        const driver: Session = {
          sessionRef: source.sessionRef,
          submit: (input) => source.submit(input),
          async *observe() {
            for await (const event of source.observe()) {
              yield event;
              context.onProgress(); // Runtime has persisted its event before scheduling another dispatch.
            }
          },
          respondToInteraction: (reference, reply) => source.respondToInteraction(reference, reply),
          interrupt: (operation) => source.interrupt(operation),
          async checkReadiness() {
            const proof = await source.checkReadiness();
            ready = proof.ok && !sealed && context.isCurrent();
            return proof;
          },
          checkpoint: () => source.checkpoint(),
          async close() {
            ready = false;
            return source.close();
          },
        };
        return { ...opened, driver };
      },
    },
    isReady: () => ready && !sealed && context.isCurrent(),
    seal() {
      sealed = true;
      ready = false;
      custody.seal();
    },
    cleanup: () => custody.confirmStopped(),
  };
}
