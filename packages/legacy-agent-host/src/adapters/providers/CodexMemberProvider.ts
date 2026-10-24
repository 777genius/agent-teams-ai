import { capturedMcpSourceCurrent } from '../../mcp-catalog/capturedSource.js';
import { codexMcpPolicy } from './codexMcpPolicy.js';
import { readCodexMcpCatalog } from './readCodexMcpCatalog.js';
import { initialContextDigest } from '../../team-launch/context.js';
import {
  codexModelOptionArgs,
  captureCodexExtraArgs,
  codexMcpPolicyArgs,
  createCodexDriverFactory,
} from '@agent-teams/provider-implementations/codex';

import { codexByteTransport } from './codexByteTransport.js';
import { CapturedProcess } from './CapturedProcess.js';
import { createTeamMcpTools } from '../../mcp/tools.js';

import type { CodexDriverConfig } from '@agent-teams/provider-implementations/codex';
import type { DriverFactory, Session } from '@agent-teams/provider-session-contracts';
import type { CapturedProcessPort } from './CapturedProcess.js';
import type { MemberProvider, MemberProviderContext } from './MemberProvider.js';
import type { CodexMemberProfile } from '../../composition/runtimeProfile.js';

const TEAM_TOKEN_ENV = 'LEGACY_AGENT_HOST_TEAM_MCP_TOKEN';

/** Captured native flags only. RPC, native configuration acceptance and discovery belong to D. */
export function codexLaunchArguments(context: MemberProviderContext): string[] {
  const required = createTeamMcpTools(context.connection)
    .list()
    .map((tool) => tool.name);
  const settings: Record<string, string | number | boolean | string[]> = {
    'mcp_servers.team.enabled': true,
    'mcp_servers.team.url': context.endpoint.url,
    'mcp_servers.team.bearer_token_env_var': TEAM_TOKEN_ENV,
    'mcp_servers.team.enabled_tools': required,
    'mcp_servers.team.startup_timeout_sec': Math.ceil(context.profile.limits.timeoutMs / 1000),
    'mcp_servers.team.tool_timeout_sec': Math.ceil(context.profile.limits.timeoutMs / 1000),
  };
  for (const name of required) {
    // Pinned native 0.162.0 mode for our already-authorized captured Team tools.
    settings[`mcp_servers.team.tools.${name}.approval_mode`] = 'approve';
  }
  return [
    ...codexModelOptionArgs(
      context.profile.provider === 'codex'
        ? {
            ...(context.profile.nativeOptions.reasoningEffort === undefined
              ? {}
              : { reasoningEffort: context.profile.nativeOptions.reasoningEffort }),
            ...(context.profile.nativeOptions.fastMode === undefined
              ? {}
              : { fastMode: context.profile.nativeOptions.fastMode }),
          }
        : {}
    ),
    ...(context.profile.provider === 'codex' && context.profile.capturedMcpServers !== undefined
      ? codexMcpPolicyArgs(codexMcpPolicy(context.profile, context.endpoint, required)!)
      : []),
    ...Object.entries(
      context.profile.provider === 'codex' && context.profile.capturedMcpServers !== undefined
        ? {}
        : settings
    ).flatMap(([key, value]) => ['-c', `${key}=${JSON.stringify(value)}`]),
    'app-server',
    '--listen',
    'stdio://',
    ...captureCodexExtraArgs(context.profile.extraArgs),
  ];
}

/** Selected Codex process custody plus public D; no native protocol implementation. */
export function createCodexMemberProvider(
  context: MemberProviderContext,
  options: {
    readCatalog?: typeof readCodexMcpCatalog;
    /** Controlled byte streams in tests; production always uses captured handle custody. */
    createProcess?(profile: CodexMemberProfile, canAllocate: () => boolean): CapturedProcessPort;
  } = {}
): MemberProvider {
  const { profile } = context;
  const evidence = context.codexEvidence;
  if (profile.provider !== 'codex') throw new Error('Invalid Codex profile');
  if (!capturedMcpSourceCurrent(profile)) throw new Error('Captured MCP source changed');
  const extraArgs = captureCodexExtraArgs(profile.extraArgs);
  const policy = codexMcpPolicy(
    profile,
    context.endpoint,
    createTeamMcpTools(context.connection)
      .list()
      .map((tool) => tool.name)
  );
  const captured = {
    ...profile,
    ...(extraArgs.length ? { extraArgs: [...extraArgs] } : {}),
    environment: {
      ...profile.environment,
      [TEAM_TOKEN_ENV]: context.endpoint.bearerToken,
    },
  };
  const custody = (
    options.createProcess ??
    ((selected, canAllocate) =>
      new CapturedProcess(
        selected,
        canAllocate,
        context.processCustody,
        context.canCaptureRegisteredProcess
      ))
  )(captured, context.canAllocate);
  let sealed = false;
  let ready = false;
  let allocated = false;
  const current = () =>
    !sealed && context.isCurrent() && custody.isRunning() && capturedMcpSourceCurrent(profile);
  const verifyCatalog = async (signal?: AbortSignal): Promise<boolean> => {
    if (!policy) return true;
    const assertCurrent = () => {
      if (sealed || !context.isCurrent() || !capturedMcpSourceCurrent(profile))
        throw new Error('Captured MCP authority changed');
    };
    try {
      assertCurrent();
      const actual = await (options.readCatalog ?? readCodexMcpCatalog)(
        profile,
        assertCurrent,
        signal
      );
      assertCurrent();
      return actual.digest === policy.catalog.digest;
    } catch {
      return false;
    }
  };
  const required = createTeamMcpTools(context.connection)
    .list()
    .map((tool) => tool.name);
  const native = createCodexDriverFactory({
    capabilities: ['text', 'tools'],
    resolveConfiguration: async (request): Promise<CodexDriverConfig | undefined> => {
      if (
        allocated ||
        sealed ||
        !context.isCurrent() ||
        !context.canAllocate() ||
        JSON.stringify(request) !== JSON.stringify(context.request)
      )
        return undefined;
      if (!capturedMcpSourceCurrent(profile) || !(await verifyCatalog())) return undefined;
      if (sealed || !context.isCurrent() || !context.canAllocate()) return undefined;
      allocated = true;
      const child = custody.launch({
        command: profile.executable.path,
        args: codexLaunchArguments({ ...context, profile: captured }),
        cwd: profile.cwd,
      });
      return {
        binding: {
          tenantId: request.tenantId,
          projectId: request.projectId,
          sessionId: profile.sessionId,
          generation: profile.generation,
        },
        configRevision: profile.configRevision,
        protocolRevision: profile.protocolRevision,
        ...(evidence ? { capture: evidence } : {}),
        ...(context.attachments ? { attachments: context.attachments } : {}),
        trustedBinding: `${context.endpoint.binding.backendId}/${context.endpoint.binding.teamId}/${context.endpoint.binding.runId}/${profile.memberId}`,
        accountBinding: profile.accountBinding,
        transport: codexByteTransport(child),
        initialize: {
          clientInfo: { name: 'legacy-agent-host', version: '0.1.0' },
          capabilities: { experimentalApi: true },
        },
        ...(profile.nativeOptions.reasoningEffort === undefined
          ? {}
          : { turnParams: { effort: profile.nativeOptions.reasoningEffort } }),
        threadParams: {
          ...(profile.nativeOptions.fastMode === true ? { serviceTier: 'fast' } : {}),
          cwd: profile.cwd,
          model: profile.model,
          approvalPolicy: profile.nativeOptions.approvalPolicy,
          sandbox: profile.nativeOptions.sandbox,
          ...(profile.nativeOptions.modelProvider
            ? { modelProvider: profile.nativeOptions.modelProvider }
            : {}),
          developerInstructions: [context.instructions, profile.nativeOptions.developerInstructions]
            .filter(Boolean)
            .join('\n\n'),
        },
        requiredMcpTools: { team: required },
        ...(policy ? { mcpPolicy: policy, verifyMcpCatalog: verifyCatalog } : {}),
        limits: { ...profile.limits },
        probe: async () => current(),
        confirmStopped: async () => {
          child.stdin.end();
          return custody.confirmStopped();
        },
      };
    },
    readCheckpoint: context.readCheckpoint,
  });
  const factory: DriverFactory = {
    async open(request) {
      try {
        const opened = await native.open(request);
        const source = opened.driver;
        const driver: Session = {
          sessionRef: source.sessionRef,
          submit: (input) => source.submit(input),
          async *observe() {
            for await (const event of source.observe()) {
              yield event;
              context.onProgress();
            }
          },
          respondToInteraction: (reference, reply) => source.respondToInteraction(reference, reply),
          interrupt: (operation) => source.interrupt(operation),
          async checkReadiness() {
            const proof = await source.checkReadiness();
            ready = proof.ok && current();
            return proof;
          },
          checkpoint: () => source.checkpoint(),
          async close() {
            ready = false;
            evidence?.seal();
            return source.close();
          },
        };
        return { ...opened, driver };
      } catch {
        // D may reject a checkpoint/configuration after transport allocation. Always clean up our handles.
        sealed = true;
        ready = false;
        evidence?.seal();
        custody.seal();
        await custody.confirmStopped();
        throw new Error('Codex member unavailable');
      }
    },
  };
  return {
    factory,
    ...(custody.captureRegisteredProcess
      ? { captureRegisteredProcess: custody.captureRegisteredProcess.bind(custody) }
      : {}),
    isReady: () => ready && current(),
    initialContextEvidence: () =>
      ready && current()
        ? {
            kind: 'native-configuration',
            contextDigest: initialContextDigest(context.instructions),
            generation: context.endpoint.binding.generation,
            configRevision: context.request.configRevision,
          }
        : undefined,
    seal() {
      sealed = true;
      ready = false;
      evidence?.seal();
      custody.seal();
    },
    cleanup: () => custody.confirmStopped(),
  };
}
