import { CLAUDE_IMAGE_MIME_TYPES } from '../../attachments/mimeTypes.js';
import { capturedMcpSourceCurrent } from '../../mcp-catalog/capturedSource.js';
import { initialContextDigest } from '../../team-launch/context.js';
import { join } from 'node:path';
import { createClaudeDriverFactory } from '@agent-teams/provider-implementations/claude';

import { ClaudeSubagentLogProjection } from './ClaudeSubagentLogProjection.js';
import { CapturedProcess } from './CapturedProcess.js';
import { observeMemberProcessStderr } from './observeMemberProcessStderr.js';
import { createClaudeCloseDiagnostic } from './createClaudeCloseDiagnostic.js';
import { claudeSessionExists } from './claudeSessionExists.js';
import { claudeMcpServers } from './claudeMcpServers.js';
import { claudeSessionCommands } from './claudeSessionCommands.js';
import { createTeamMcpTools } from '../../mcp/tools.js';

import type { ClaudeConfig } from '@agent-teams/provider-implementations/claude';
import type { Session } from '@agent-teams/provider-session-contracts';
import type { MemberProvider, MemberProviderContext } from './MemberProvider.js';

/** Outer adapter builds one selected D configuration; all native protocol/SDK logic stays in D. */
export function createClaudeMemberProvider(context: MemberProviderContext): MemberProvider {
  const { profile } = context;
  if (profile.provider !== 'claude') throw new Error('Invalid Claude profile');
  if (!capturedMcpSourceCurrent(profile)) throw new Error('Captured MCP source changed');
  const selectedBinding = context.endpoint.binding;
  const childLogs = new ClaudeSubagentLogProjection({
    backendId: selectedBinding.backendId,
    teamId: selectedBinding.teamId,
    runId: selectedBinding.runId,
    memberId: selectedBinding.memberId,
    generation: selectedBinding.generation,
  });
  // Claude only emits next-prompt suggestions while its own account/time dependent rollout flag is on.
  // When the user's setting selected Claude for this Host, request them explicitly in the launch environment.
  const environment = context.promptSuggestions
    ? { ...profile.environment, CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION: 'true' }
    : { ...profile.environment };
  const launchProfile = Object.freeze({ ...profile, environment: Object.freeze(environment) });
  const custody = new CapturedProcess(
    launchProfile,
    () => context.canAllocate() && capturedMcpSourceCurrent(profile),
    context.processCustody,
    () =>
      (context.canCaptureRegisteredProcess?.() ?? context.canAllocate()) &&
      capturedMcpSourceCurrent(profile),
    undefined,
    context.retainedWindowsLaunch?.port(launchProfile,
      () => context.canAllocate() && capturedMcpSourceCurrent(profile),
      context.canCaptureRegisteredProcess
        ? () => context.canCaptureRegisteredProcess!() && capturedMcpSourceCurrent(profile) : undefined,
      context.processOrigin)
  );
  let ready = false;
  let sealed = false;
  let commands: ReturnType<typeof claudeSessionCommands> = [];
  const required = createTeamMcpTools(context.connection)
    .list()
    .map((tool) => tool.name);
  const config: ClaudeConfig = {
    sessionRef: profile.sessionId,
    observeClose: createClaudeCloseDiagnostic(selectedBinding, profile.sessionId),
    observeCommands: (value) => { commands = claudeSessionCommands(value); },
    ...(context.toolEvidence ? { capture: context.toolEvidence } : {}),
    ...(context.attachments ? { attachments: context.attachments } : {}),
    ...(context.promptSuggestions ? { promptSuggestions: context.promptSuggestions } : {}),
    // Stable principal scope across technical generations; MCP and Runtime separately fence generation.
    trustedBinding: `${context.endpoint.binding.backendId}/${context.endpoint.binding.teamId}/${context.endpoint.binding.runId}/${profile.memberId}`,
    cwd: profile.cwd,
    executablePath: profile.executable.path,
    model: profile.model,
    accountBinding: profile.accountBinding,
    configRevision: profile.configRevision,
    environment: { ...environment },
    ...(profile.extraArgs ? { extraArgs: [...profile.extraArgs] } : {}),
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
    ...(context.subagents ? { subagents: context.subagents } : {}),
    nativeTools: [...new Set([...profile.nativeTools, ...(context.subagents ? ['Agent'] : [])])],
    autoAllowedTools: [
      ...new Set([...profile.autoAllowedTools, ...required.map((name) => `mcp__team__${name}`)]),
    ],
    mcpServers: claudeMcpServers(profile, context.endpoint),
    requiredTools: { team: required },
    probe: async () => !sealed && context.isCurrent() && capturedMcpSourceCurrent(profile),
    limits: { ...profile.limits },
    sessionExists: async (nativeSession) => {
      const directory =
        profile.configNamespace === 'native-default'
          ? join(profile.environment.HOME!, '.claude')
          : profile.environment.CLAUDE_CONFIG_DIR;
      if (!directory) return false;
      return claudeSessionExists(directory.normalize('NFC'), profile.cwd, nativeSession);
    },
    custody: { launch: (request) => {
      const child = custody.launch(request);
      observeMemberProcessStderr(child, context, request.args);
      return child;
    }, confirmStopped: () => custody.confirmStopped() },
  };
  const native = createClaudeDriverFactory({
    capabilities: ['session.conversation', ...(context.subagents ? ['session.subagents'] : [])],
    resolveConfiguration: async (request) =>
      !sealed &&
      context.isCurrent() &&
      capturedMcpSourceCurrent(profile) &&
      JSON.stringify(request) === JSON.stringify(context.request)
        ? config
        : undefined,
    readCheckpoint: context.readCheckpoint,
    ...(context.readCheckpointSource ? { readCheckpointSource: context.readCheckpointSource } : {}),
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
              yield context.subagents ? childLogs.project(event) : event;
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
    ...(context.attachments
      ? {
          attachmentCapabilities: {
            images: CLAUDE_IMAGE_MIME_TYPES.some(
              (mime) => context.attachments?.mimeTypes.includes(mime) === true
            ),
            documents: context.attachments.mimeTypes.includes('application/pdf'),
            textFiles:
              context.attachments.mimeTypes.includes('text/plain') ||
              context.attachments.mimeTypes.includes('text/*'),
          },
        }
      : {}),
    ...(custody.captureRegisteredProcess
      ? { captureRegisteredProcess: custody.captureRegisteredProcess.bind(custody) }
      : {}),
    ...(profile.windowsBroker?.capability === 'service-scopes-v1' && context.retainedWindowsLaunch
      ? { prepareRegisteredWindowsProcess: custody.prepareRegisteredWindowsProcess.bind(custody) } : {}),
    isReady: () => ready && !sealed && context.isCurrent(),
    sessionCommands: () => ready && !sealed && context.isCurrent() && capturedMcpSourceCurrent(profile) ? commands : [],
    initialContextEvidence: () =>
      ready && !sealed && context.isCurrent()
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
      context.toolEvidence?.seal();
      custody.seal();
    },
    cleanup: () => custody.confirmStopped(),
  };
}
