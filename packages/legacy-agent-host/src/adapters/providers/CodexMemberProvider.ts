import { channel } from 'node:diagnostics_channel';
import { performance } from 'node:perf_hooks';
import { managementDigest } from '../../management/identity.js';
import { NATIVE_IMAGE_MIME_TYPES } from '../../attachments/mimeTypes.js';
import { capturedMcpSourceCurrent } from '../../mcp-catalog/capturedSource.js';
import { qualifiedCodexProtocolRevision } from '../../composition/runtimeSourceQualification.js';
import { codexMcpPolicy } from './codexMcpPolicy.js';
import { capturedNativeProcessFactory } from './capturedNativeProcessFactory.js';
import { readCodexMcpCatalog } from './readCodexMcpCatalog.js';
import { initialContextDigest } from '../../team-launch/context.js';
import {
  codexModelOptionArgs,
  captureCodexExtraArgs,
  codexMcpPolicyArgs,
  createCodexDriverFactory,
} from '@agent-teams/provider-implementations/codex';

import { codexByteTransport } from './codexByteTransport.js';
import { observeMemberProcessStderr } from './observeMemberProcessStderr.js';
import { CapturedProcess } from './CapturedProcess.js';
import { buildCodexMemberEnvironment, codexTeamTokenEnvironment as TEAM_TOKEN_ENV } from './nativeLaunchEnvironment.js';
import { createTeamMcpTools } from '../../mcp/tools.js';

import type { CodexDriverConfig } from '@agent-teams/provider-implementations/codex';
import type { DriverFactory, Session } from '@agent-teams/provider-session-contracts';
import type { CapturedProcessPort } from './CapturedProcess.js';
import type { MemberProvider, MemberProviderContext } from './MemberProvider.js';
import type { CodexMemberProfile } from '../../composition/runtimeProfile.js';

type ReadinessOperation = 'open' | 'catalog' | 'readiness';
type ReadinessPhase = 'before-await' | 'after-await' | 'returned' | 'threw';

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
  const readinessObservation = (() => {
    let diagnostic: ReturnType<typeof channel> | undefined;
    let identity: { schemaVersion: 2; bindingDigest: string; sourceId: string; sourceRevision: string } | undefined;
    let sequence = 0, invocations = 0, disabled = false;
    let started = 0;
    // Fixed buckets: isCurrent, canAllocate, MCP source; count, total ms, maximum ms.
    // Emit integer tenths of a millisecond only. Bounds keep the 64-event ledger below 8192 bytes.
    const guards = Array.from({ length: 3 }, () => ({ count: 0, total: 0, max: 0 }));
    try {
      diagnostic = channel('agent-teams.legacy-host.codex-readiness');
      const origin = context.processOrigin, binding = context.endpoint.binding;
      const sourceId = origin?.sourceId, sourceRevision = origin?.revision;
      if (origin?.origin.kind === 'runtime' && typeof sourceId === 'string' && /^[a-f0-9]{64}$/.test(sourceId) &&
          typeof sourceRevision === 'string' && /^[a-f0-9]{64}$/.test(sourceRevision)) {
        const { backendId, teamId, runId, memberId, generation } = binding;
        if ([backendId, teamId, runId, memberId, generation].every(value => typeof value === 'string'))
          identity = { schemaVersion: 2, bindingDigest: managementDigest({ backendId, teamId, runId, memberId, generation }), sourceId, sourceRevision };
      }
      started = performance.now();
    } catch { disabled = true; }
    const limit = (): void => { try {
      if (!identity || disabled) return; disabled = true;
      if (diagnostic?.hasSubscribers) diagnostic.publish({ ...identity, limit: true });
    } catch { disabled = true; } };
    const publish = (invocation: number | undefined, operation: ReadinessOperation, phase: ReadinessPhase, result: boolean | null = null): void => { try {
      if (!identity || disabled || invocation === undefined) return;
      if (sequence >= 64) { limit(); return; }
      const timing = [Math.floor((performance.now() - started) * 10),
        ...guards.flatMap(value => [value.count, Math.floor(value.total * 10), Math.floor(value.max * 10)])];
      if (timing.some(value => !Number.isSafeInteger(value) || value < 0 || value > 999999)) { limit(); return; }
      sequence++;
      if (diagnostic?.hasSubscribers) diagnostic.publish({ ...identity, sequence, invocation, operation, phase, result, timing });
    } catch { disabled = true; } };
    const begin = (operation: ReadinessOperation): number | undefined => { try {
      if (!identity || disabled) return undefined;
      if (invocations >= 16) { limit(); return undefined; }
      const invocation = ++invocations; publish(invocation, operation, 'before-await'); return invocation;
    } catch { disabled = true; return undefined; } };
    const measure = (index: 0 | 1 | 2, guard: () => boolean): boolean => {
      let before: number | undefined;
      try { if (identity && !disabled && diagnostic?.hasSubscribers) before = performance.now(); }
      catch { disabled = true; }
      try { return guard(); }
      finally { if (before !== undefined) try {
        const elapsed = performance.now() - before, value = guards[index]!;
        if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed > 99999.9 || value.count >= 4096 ||
            value.total + elapsed > 99999.9) limit();
        else { value.count++; value.total += elapsed; value.max = Math.max(value.max, elapsed); }
      } catch { disabled = true; } }
    };
    return { begin, publish, measure };
  })();
  const isCurrent = () => readinessObservation.measure(0, () => context.isCurrent());
  const allocationCurrent = () => readinessObservation.measure(1, () => context.canAllocate());
  const mcpSourceCurrent = () => readinessObservation.measure(2, () => capturedMcpSourceCurrent(profile));
  if (profile.provider !== 'codex') throw new Error('Invalid Codex profile');
  qualifiedCodexProtocolRevision(profile.protocolRevision);
  if (!mcpSourceCurrent()) throw new Error('Captured MCP source changed');
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
    environment: buildCodexMemberEnvironment(profile.environment, context.endpoint.bearerToken),
  };
  const canAllocate = () => allocationCurrent() && mcpSourceCurrent();
  const canCapture = () =>
    (context.canCaptureRegisteredProcess?.() ?? allocationCurrent()) &&
    mcpSourceCurrent();
  const custody = (
    options.createProcess ??
    ((selected, canAllocate) =>
      new CapturedProcess(
        selected,
        canAllocate,
        context.processCustody,
        canCapture,
        undefined,
        context.retainedWindowsLaunch?.port(selected, canAllocate, canCapture, context.processOrigin)
      ))
  )(captured, canAllocate);
  let sealed = false;
  let ready = false;
  let allocated = false;
  const current = () =>
    !sealed && isCurrent() && custody.isRunning() && mcpSourceCurrent();
  const verifyCatalog = async (signal?: AbortSignal): Promise<boolean> => {
    if (!policy) return true;
    let invocation: number | undefined;
    const assertCurrent = () => {
      if (sealed || !isCurrent() || !mcpSourceCurrent())
        throw new Error('Captured MCP authority changed');
    };
    try {
      assertCurrent();
      invocation = readinessObservation.begin('catalog');
      const actual = await (options.readCatalog ?? readCodexMcpCatalog)(
        profile,
        assertCurrent,
        signal,
        capturedNativeProcessFactory(context.retainedWindowsLaunch, context.processOrigin)
      );
      readinessObservation.publish(invocation, 'catalog', 'after-await');
      assertCurrent();
      const matches = actual.digest === policy.catalog.digest;
      readinessObservation.publish(invocation, 'catalog', 'returned', matches);
      return matches;
    } catch {
      readinessObservation.publish(invocation, 'catalog', 'threw');
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
        !isCurrent() ||
        !allocationCurrent() ||
        JSON.stringify(request) !== JSON.stringify(context.request)
      )
        return undefined;
      if (!mcpSourceCurrent() || !(await verifyCatalog())) return undefined;
      if (sealed || !isCurrent() || !allocationCurrent()) return undefined;
      allocated = true;
      const args = codexLaunchArguments({ ...context, profile: captured });
      const child = custody.launch({
        command: profile.executable.path,
        args,
        cwd: profile.cwd,
      });
      observeMemberProcessStderr(child, context, args);
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
        ...(context.promptSuggestions ? { promptSuggestions: context.promptSuggestions } : {}),
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
        ...(policy
          ? { mcpPolicy: policy, verifyMcpCatalog: verifyCatalog, runtimeMcpServer: 'team' }
          : {}),
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
      let invocation: number | undefined;
      try {
        invocation = readinessObservation.begin('open');
        const opened = await native.open(request);
        readinessObservation.publish(invocation, 'open', 'after-await');
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
            const invocation = readinessObservation.begin('readiness');
            try {
              const proof = await source.checkReadiness();
              readinessObservation.publish(invocation, 'readiness', 'after-await');
              ready = proof.ok && current();
              readinessObservation.publish(invocation, 'readiness', 'returned', ready);
              return proof;
            } catch (error) {
              readinessObservation.publish(invocation, 'readiness', 'threw');
              throw error;
            }
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
        readinessObservation.publish(invocation, 'open', 'threw');
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
    ...(context.attachments
      ? {
          attachmentCapabilities: {
            images: NATIVE_IMAGE_MIME_TYPES.some(
              (mime) => context.attachments?.mimeTypes.includes(mime) === true
            ),
            documents: false,
            textFiles: false,
          },
        }
      : {}),
    ...(custody.captureRegisteredProcess
      ? { captureRegisteredProcess: custody.captureRegisteredProcess.bind(custody) }
      : {}),
    ...(profile.windowsBroker?.capability === 'service-scopes-v1' &&
        context.retainedWindowsLaunch && custody.prepareRegisteredWindowsProcess
      ? { prepareRegisteredWindowsProcess: custody.prepareRegisteredWindowsProcess.bind(custody) }
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
