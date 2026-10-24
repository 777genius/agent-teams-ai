import { readOpenCodeInputModalities } from './readOpenCodeInputModalities.js';
import { captureOpenCodeExtraArgs } from '@agent-teams/provider-implementations/opencode';
import { capturedMcpSourceCurrent } from '../../mcp-catalog/capturedSource.js';
import { createHash, randomBytes } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import {
  OpenCodeClientFactory,
  createOpenCodeV1DriverFactory,
  readOpenCodeV1CheckpointSessionId,
} from '@agent-teams/provider-implementations/opencode';

import { CapturedProcess } from './CapturedProcess.js';
import {
  canonicalOpenCodeAgentPermission,
  requiredOpenCodeToolsAllowed,
} from './openCodeAgentPolicy.js';
import {
  verifyOpenCodeMcpPolicyPlugin,
  openCodeMcpServers,
  exactOpenCodeMcpPolicy,
  exactOpenCodeMcpStatus,
} from './openCodeMcpPolicy.js';
import { createTeamMcpTools } from '../../mcp/tools.js';
import { initialContextDigest } from '../../team-launch/context.js';

import type {
  OpenCodeClient,
  OpenCodeV1DriverConfig,
} from '@agent-teams/provider-implementations/opencode';
import type { DriverFactory, Input, Session } from '@agent-teams/provider-session-contracts';
import type { CapturedProcessPort } from './CapturedProcess.js';
import type { MemberProvider, MemberProviderContext } from './MemberProvider.js';
import type { OpenCodeMemberProfile } from '../../composition/runtimeProfile.js';
import type { TeamMcpCatalogReceipt } from '../../mcp/contracts.js';

const capabilities = ['text', 'tools', 'permission', 'interrupt', 'checkpoint'];
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid OpenCode configuration');
  return value as Record<string, unknown>;
};

/** Owns a dedicated selected V1 server; shared-server reference custody is a separate, unqualified path. */
export function createOpenCodeMemberProvider(
  context: MemberProviderContext,
  options: {
    /** Controlled process and HTTP boundaries for tests. Production always captures its own process handles. */
    createProcess?(profile: OpenCodeMemberProfile, canAllocate: () => boolean): CapturedProcessPort;
    fetchImpl?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  } = {}
): MemberProvider {
  if (context.profile.provider !== 'opencode') throw new Error('Invalid OpenCode profile');
  const evidence = context.opencodeEvidence;
  const profile = structuredClone(context.profile);
  const extraArgs = captureOpenCodeExtraArgs(profile.extraArgs);
  const config =
    profile.environment.OPENCODE_CONFIG_CONTENT === undefined
      ? {}
      : record(JSON.parse(profile.environment.OPENCODE_CONFIG_CONTENT) as unknown);
  const agentName = profile.nativeOptions.agent;
  const agents = config.agent === undefined ? {} : record(config.agent);
  const agent = agents[agentName] === undefined ? {} : record(agents[agentName]);
  if (agent.prompt !== undefined && typeof agent.prompt !== 'string')
    throw new Error('Invalid OpenCode agent prompt');
  const prompt = [context.instructions, agent.prompt, profile.nativeOptions.instructions]
    .filter(Boolean)
    .join('\n\n');
  const capturedPolicy = profile.capturedMcpServers !== undefined;
  const plugin = capturedPolicy ? verifyOpenCodeMcpPolicyPlugin(profile) : undefined;
  const policyNonce = capturedPolicy ? randomBytes(32).toString('hex') : undefined;
  const mcp = capturedPolicy
    ? openCodeMcpServers(profile)
    : config.mcp === undefined
      ? {}
      : record(config.mcp);
  const bindingKey = [
    context.endpoint.binding.backendId,
    context.endpoint.binding.teamId,
    context.endpoint.binding.runId,
    profile.memberId,
  ].join('/');
  const prefix =
    'legacy_host_team_' + createHash('sha256').update(bindingKey).digest('hex').slice(0, 16);
  let serverName = Object.hasOwn(mcp, 'team') ? prefix : 'team';
  for (let index = 1; Object.hasOwn(mcp, serverName); index++) serverName = `${prefix}_${index}`;
  const requiredToolNames = createTeamMcpTools(context.connection)
    .list()
    .map((tool) => tool.name);
  const required = requiredToolNames.map((name) => `${serverName}_${name}`);
  const permission = agent.permission === undefined ? {} : record(agent.permission);
  const approvalMode = profile.nativeOptions.toolApprovalMode;
  const selectedPermissions =
    approvalMode === undefined
      ? permission
      : {
          '*': approvalMode === 'manual' ? 'ask' : 'deny',
          ...(approvalMode === 'manual'
            ? {}
            : Object.fromEntries(
                [
                  'read',
                  'glob',
                  'grep',
                  'list',
                  'lsp',
                  'todoread',
                  'todowrite',
                  'edit',
                  'bash',
                ].map((name) => [name, 'allow'])
              )),
          task: { '*': 'deny' },
          external_directory: 'deny',
          doom_loop: 'deny',
        };
  const tools = agent.tools === undefined ? {} : record(agent.tools);
  const effectiveAgent = {
    ...Object.fromEntries(Object.entries(agent).filter(([key]) => key !== 'tools')),
    prompt,
    model: `${profile.nativeOptions.providerId}/${profile.model}`,
    permission: canonicalOpenCodeAgentPermission(tools, selectedPermissions, required),
  };
  const plugins = config.plugin === undefined ? [] : config.plugin;
  if (!Array.isArray(plugins)) throw new Error('Invalid OpenCode plugins');
  const nativeConfig = {
    ...config,
    ...(plugin ? { plugin: [...plugins.filter((value) => value !== plugin), plugin] } : {}),
    agent: { ...agents, [agentName]: effectiveAgent },
    mcp: {
      ...mcp,
      [serverName]: {
        type: 'remote',
        url: context.endpoint.url,
        headers: { Authorization: `Bearer ${context.endpoint.bearerToken}` },
        oauth: false,
        enabled: true,
        timeout: profile.limits.timeoutMs,
      },
    },
  };
  const expectedMcp = structuredClone(nativeConfig.mcp);
  if (policyNonce)
    record(record(expectedMcp[serverName]).headers)['X-Legacy-Mcp-Policy'] = policyNonce;
  const password = randomBytes(32).toString('base64url');
  const captured: OpenCodeMemberProfile = {
    ...profile,
    environment: {
      ...profile.environment,
      OPENCODE_CONFIG_CONTENT: JSON.stringify(nativeConfig),
      ...(policyNonce
        ? {
            LEGACY_AGENT_HOST_MCP_POLICY_NONCE: policyNonce,
            LEGACY_AGENT_HOST_MCP_TEAM_SERVER: serverName,
          }
        : {}),
      OPENCODE_SERVER_USERNAME: 'opencode',
      OPENCODE_SERVER_PASSWORD: password,
    },
  };
  // Validate every selected namespace before any process or native mutation.
  const verifyNamespaces = () => {
    if (!capturedMcpSourceCurrent(profile)) throw new Error('Captured MCP source changed');
    if (capturedPolicy) verifyOpenCodeMcpPolicyPlugin(profile);
    if (!options.createProcess)
      for (const key of ['HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME']) {
        const path = captured.environment[key];
        if (!path || realpathSync(path) !== path || !statSync(path).isDirectory())
          throw new Error('Invalid OpenCode namespace');
      }
  };
  verifyNamespaces();
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
  let configurationAccepted = false;
  const contextDigest = initialContextDigest(context.instructions);
  let allocated = false;
  let nativeSessionId: string | undefined;
  // Pending calls, not a delivery queue: D readiness must recheck their media until native handoff.
  const nativeMediaSubmits = new Set<Input>();
  const abort = new AbortController();
  const current = () => !sealed && context.isCurrent() && custody.isRunning();
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    if (
      request.url.startsWith(profile.endpoint + '/') === false ||
      new URL(request.url).origin !== profile.endpoint
    )
      throw new Error('Foreign OpenCode endpoint');
    const headers = new Headers(request.headers);
    headers.set('authorization', 'Basic ' + Buffer.from(`opencode:${password}`).toString('base64'));
    headers.set('x-opencode-directory', profile.cwd);
    return (options.fetchImpl ?? fetch)(new Request(request, { headers, redirect: 'error' }));
  };
  const client = (signal: AbortSignal, deadline: number): OpenCodeClient =>
    new OpenCodeClientFactory({ fetchImpl }).create(profile.endpoint, {
      signal,
      remainingMs: () => deadline - Date.now(),
    });
  const verifyConfiguration = async (api: OpenCodeClient): Promise<boolean> => {
    const effective = record(await api.getConfig());
    if (capturedPolicy && !exactOpenCodeMcpPolicy(effective.mcp, expectedMcp)) return false;
    const selectedAgent = record(record(effective.agent)[agentName]);
    const selectedMcp = record(record(effective.mcp)[serverName]);
    if (
      selectedAgent.prompt !== prompt ||
      selectedAgent.model !== effectiveAgent.model ||
      selectedMcp.url !== context.endpoint.url ||
      selectedMcp.enabled !== true ||
      record(selectedMcp.headers).Authorization !== `Bearer ${context.endpoint.bearerToken}`
    )
      return false;
    if (selectedAgent.disable === true) return false;
    if (!(await api.listAgents()).some((agent) => agent.name === agentName)) return false;
    const selectedPermission = record(selectedAgent.permission);
    if (!requiredOpenCodeToolsAllowed(selectedPermission, required)) return false;
    if (
      approvalMode !== undefined &&
      !Object.entries(selectedPermissions).every(
        ([key, value]) => JSON.stringify(selectedPermission[key]) === JSON.stringify(value)
      )
    )
      return false;
    const providers = await api.getConfigProviders({
      initializeInstance: true,
    });
    const selected = providers.providers?.filter(
      (item) => item.id === profile.nativeOptions.providerId
    );
    if (
      selected?.length !== 1 ||
      !selected[0]?.models ||
      !Object.hasOwn(selected[0].models, profile.model)
    )
      return false;
    const references = [...nativeMediaSubmits].flatMap((input) => input.attachments ?? []);
    if (references.length) {
      const declaration = readOpenCodeInputModalities(selected[0].models[profile.model]);
      if (
        !declaration ||
        references.some((reference) => {
          const modality = reference.mimeType.startsWith('image/')
            ? 'image'
            : reference.mimeType.startsWith('video/')
              ? 'video'
              : undefined;
          return !modality || !declaration.includes(modality);
        })
      )
        return false;
    }
    return current();
  };
  const validCatalogReceipt = (receipt: TeamMcpCatalogReceipt | undefined): boolean =>
    receipt !== undefined &&
    Number.isSafeInteger(receipt.sequence) &&
    receipt.sequence > 0 &&
    Number.isSafeInteger(receipt.servedAtMs) &&
    receipt.servedAtMs >= 0 &&
    Object.entries(context.endpoint.binding).every(
      ([key, value]) => receipt.binding[key as keyof typeof receipt.binding] === value
    ) &&
    receipt.toolNames.length === requiredToolNames.length &&
    new Set(receipt.toolNames).size === requiredToolNames.length &&
    requiredToolNames.every((name) => receipt.toolNames.includes(name));
  let starting: Promise<void> | undefined;
  const startServer = (): Promise<void> =>
    (starting ??= (async () => {
      verifyNamespaces();
      const child = custody.launch({
        command: profile.executable.path,
        cwd: profile.cwd,
        args: [
          'serve',
          '--hostname',
          '127.0.0.1',
          '--port',
          new URL(profile.endpoint).port,
          ...extraArgs,
        ],
      });
      child.stdout.on('data', () => {});
      const deadline = Date.now() + profile.limits.timeoutMs;
      const api = client(abort.signal, deadline);
      // Retry only read-only startup qualification; never repeat a session-creation mutation.
      for (;;) {
        if (!context.isCurrent() || !context.canAllocate() || sealed)
          throw new Error('OpenCode authority unavailable');
        try {
          if (await verifyConfiguration(api)) break;
        } catch {
          /* Startup not proved yet. */
        }
        if (Date.now() >= deadline || !custody.isRunning())
          throw new Error('OpenCode configuration unavailable');
        await delay(Math.min(25, Math.max(1, deadline - Date.now())), undefined, {
          signal: abort.signal,
        });
      }
    })());
  const probe = async (signal: AbortSignal): Promise<boolean> => {
    configurationAccepted = false;
    if (sealed || !context.isCurrent() || !nativeSessionId || !capturedMcpSourceCurrent(profile))
      return false;
    await startServer();
    if (!current()) return false;
    const api = client(
      AbortSignal.any([signal, abort.signal]),
      Date.now() + profile.limits.timeoutMs
    );
    const before = await api.getSession(nativeSessionId);
    if (
      before.id !== nativeSessionId ||
      before.directory !== profile.cwd ||
      !(await verifyConfiguration(api))
    )
      return false;
    const status = await api.getMcp();
    if (
      status[serverName]?.status !== 'connected' ||
      (capturedPolicy && !exactOpenCodeMcpStatus(status, expectedMcp))
    )
      return false;
    // In pinned V1, connected is published only after successful MCP tools/list caching.
    // /experimental/tool enumerates builtin/custom tools, so it cannot prove MCP availability.
    // The owner receipt proves which immutable catalog this exact endpoint generation served.
    const catalog = context.endpoint.getCatalogReceipt?.();
    if (!validCatalogReceipt(catalog)) return false;
    if (!(await verifyConfiguration(api))) return false;
    const after = await api.getSession(nativeSessionId);
    const finalStatus = await api.getMcp();
    const finalCatalog = context.endpoint.getCatalogReceipt?.();
    configurationAccepted =
      after.id === before.id &&
      after.directory === before.directory &&
      finalStatus[serverName]?.status === 'connected' &&
      (!capturedPolicy || exactOpenCodeMcpStatus(finalStatus, expectedMcp)) &&
      validCatalogReceipt(finalCatalog) &&
      finalCatalog!.sequence >= catalog!.sequence &&
      current();
    return configurationAccepted;
  };
  const native = createOpenCodeV1DriverFactory({
    capabilities,
    resolveConfiguration: async (request): Promise<OpenCodeV1DriverConfig | undefined> => {
      if (
        allocated ||
        sealed ||
        !context.isCurrent() ||
        !context.canAllocate() ||
        JSON.stringify(request) !== JSON.stringify(context.request)
      )
        return undefined;
      // No implicit new native session can satisfy a restore of a previously captured session.
      if (!request.checkpointRef && profile.nativeSessionId) return undefined;
      const restoredSessionId = request.checkpointRef
        ? readOpenCodeV1CheckpointSessionId(
            await context.readCheckpoint(request.checkpointRef, request)
          )
        : undefined;
      if (profile.nativeSessionId && profile.nativeSessionId !== restoredSessionId)
        return undefined;
      allocated = true;
      if (restoredSessionId) {
        // The public D factory validates the Runtime-selected checkpoint before invoking probe.
        // Defer native server allocation/history reads until that validation has succeeded.
        nativeSessionId = restoredSessionId;
      } else {
        await startServer();
        if (!context.canAllocate() || !current())
          throw new Error('OpenCode allocation unavailable');
        const api = client(abort.signal, Date.now() + profile.limits.timeoutMs);
        const session = await api.createSession({
          title: `Team member ${profile.memberId}`,
        });
        if (!/^ses_[A-Za-z0-9]+$/.test(session.id) || session.directory !== profile.cwd)
          throw new Error('OpenCode session unavailable');
        nativeSessionId = session.id;
      }
      return {
        endpoint: profile.endpoint,
        version: profile.protocolRevision,
        workspacePath: profile.cwd,
        nativeSessionId,
        trustedBinding: bindingKey,
        accountBinding: profile.accountBinding,
        profileBinding: profile.sessionId,
        runBinding: context.endpoint.binding.runId,
        configRevision: profile.configRevision,
        model: {
          providerID: profile.nativeOptions.providerId,
          modelID: profile.model,
        },
        agent: agentName,
        ...(profile.nativeOptions.variant ? { variant: profile.nativeOptions.variant } : {}),
        binding: {
          tenantId: request.tenantId,
          projectId: request.projectId,
          sessionId: profile.sessionId,
          generation: profile.generation,
        },
        limits: { ...profile.limits },
        ...(evidence ? { capture: evidence } : {}),
        ...(context.attachments ? { attachments: context.attachments } : {}),
        fetchImpl,
        probe,
        confirmStopped: () => custody.confirmStopped(),
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
          async submit(input) {
            if (!capturedPolicy && !input.attachments?.length) return source.submit(input);
            const capturedInput = structuredClone(input);
            if (capturedInput.attachments?.length) {
              if (nativeMediaSubmits.size >= profile.limits.queuedInputs + 1)
                return { ok: false, code: 'backpressure', delivery: 'known-not-sent' } as const;
              nativeMediaSubmits.add(capturedInput);
            }
            try {
              let approved = false;
              try {
                approved = await probe(abort.signal);
              } catch {
                /* No native handoff yet. */
              }
              if (!approved)
                return {
                  ok: false,
                  code: 'dependency-unavailable',
                  delivery: 'known-not-sent',
                } as const;
              return await source.submit(capturedInput);
            } finally {
              nativeMediaSubmits.delete(capturedInput);
            }
          },
          async *observe() {
            for await (const event of source.observe()) {
              yield event;
              context.onProgress();
            }
          },
          respondToInteraction: (reference, reply) => source.respondToInteraction(reference, reply),
          interrupt: (operation) => source.interrupt(operation),
          checkpoint: () => source.checkpoint(),
          async checkReadiness() {
            const proof = await source.checkReadiness();
            ready = proof.ok && current();
            return proof;
          },
          async close() {
            ready = false;
            evidence?.seal();
            return source.close();
          },
        };
        return { ...opened, driver };
      } catch {
        evidence?.seal();
        sealed = true;
        ready = false;
        abort.abort();
        custody.seal();
        await custody.confirmStopped();
        throw new Error('OpenCode member unavailable');
      }
    },
  };
  return {
    factory,
    ...(custody.captureRegisteredProcess
      ? {
          captureRegisteredProcess: custody.captureRegisteredProcess.bind(custody),
        }
      : {}),
    isReady: () => ready && configurationAccepted && current(),
    initialContextEvidence: () =>
      ready && configurationAccepted && current()
        ? {
            kind: 'native-configuration',
            contextDigest,
            generation: context.endpoint.binding.generation,
            configRevision: profile.configRevision,
          }
        : undefined,
    seal() {
      evidence?.seal();
      sealed = true;
      ready = false;
      abort.abort();
      custody.seal();
    },
    cleanup: () => custody.confirmStopped(),
  };
}
