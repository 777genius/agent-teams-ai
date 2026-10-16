import type { ElectronAPI } from '@shared/types/api';
import type { TeamCreateRequest, TeamProvisioningProgress } from '@shared/types/team';

/** Renderer adapter for the existing full-team scenario. The host driver must
 * first verify its owned Electron PID/CDP listener and isolated TEST profile.
 * This module does not launch Electron or establish that host ownership proof.
 * Importing it never submits work. All mutations are explicit and single-shot.
 */
export function electronTeamPort(api: ElectronAPI, teamName: string, projectPath: string) {
  if (!/^test-opencode-[a-zA-Z0-9-]+$/.test(teamName)) throw new Error('TEST team required');
  if (!projectPath || !/(?:^|[\\/])TEST-[^\\/]+(?:[\\/]|$)/.test(projectPath)) {
    throw new Error('TEST project required; host must also verify its opt-in marker');
  }
  const progress: TeamProvisioningProgress[] = [];
  let runId: string | undefined;
  let submitted = false;
  let createBoundary: 'not_submitted' | 'project_registration' | 'team_create' | 'created' =
    'not_submitted';
  let relaunchAttempted = false;
  let launchPending = false;
  const pendingProgress: TeamProvisioningProgress[] = [];
  const unsubscribe = api.teams.onProvisioningProgress((_event, value) => {
    if (value.teamName !== teamName) return;
    if (launchPending) pendingProgress.push(value);
    else if (!runId || value.runId === runId) progress.push(value);
  });
  const tasks = new Set<string>();
  let disposed = false;
  const check = () => {
    if (disposed) throw new Error('renderer port disposed');
  };
  const selectedTask = (id: string) => {
    check();
    if (!tasks.has(id)) throw new Error('task is not owned by this TEST scenario');
  };
  return {
    progress,
    async getStartupStatus() {
      check();
      if (!api.startup) throw new Error('Packaged startup API required');
      return api.startup.getStatus();
    },
    async getStartupCleanupState() {
      check();
      if (!api.startup) throw new Error('Packaged startup API required');
      return (await api.startup.getOpenCodeCleanupStatus()).state;
    },
    async createTeam(request: TeamCreateRequest) {
      check();
      if (
        submitted ||
        request.teamName !== teamName ||
        request.cwd !== projectPath ||
        request.providerId !== 'opencode'
      )
        throw new Error('single owned OpenCode launch required');
      // Never repeat an uncertain createTeam after an IPC timeout.
      submitted = true;
      createBoundary = 'project_registration';
      await api.config.addCustomProjectPath(projectPath);
      createBoundary = 'team_create';
      const result = await api.teams.createTeam(request);
      runId = result.runId;
      createBoundary = 'created';
      return result;
    },
    async getSafeLaunchFailure() {
      check();
      const codes = [
        'workspace_trust_required',
        'transport_rejected',
        'stdin_missing',
        'provider_quota',
        'provider_auth',
        'opencode_runtime_readiness_timeout',
        'process_readiness_timeout',
        'opencode_protocol',
        'model_no_bootstrap',
        'process_exited',
        'unknown',
      ];
      if (createBoundary !== 'team_create' && createBoundary !== 'created')
        return { boundary: createBoundary };
      try {
        const diagnostics = await api.teams.getLaunchFailureDiagnostics(teamName, runId);
        return {
          boundary: createBoundary,
          classification:
            codes.find((code) => code === diagnostics.classification?.code) ?? 'unknown',
          bootstrapSubmitted: diagnostics.bootstrapTransportBreadcrumb?.bootstrapSubmitted === true,
          submitRejected: diagnostics.bootstrapTransportBreadcrumb?.submitRejected === true,
        };
      } catch {
        return { boundary: createBoundary, diagnosticsUnavailable: true };
      }
    },
    async createTask(request: Parameters<ElectronAPI['teams']['createTask']>[1]) {
      check();
      if (!runId) throw new Error('owned team launch required');
      const result = await api.teams.createTask(teamName, request);
      tasks.add(result.id);
      return result;
    },
    async startTask(id: string) {
      selectedTask(id);
      return api.teams.startTask(teamName, id);
    },
    async getTask(id: string) {
      selectedTask(id);
      return api.teams.getTask(teamName, id);
    },
    async getTaskLogStream(id: string) {
      selectedTask(id);
      return api.teams.getTaskLogStream(teamName, id);
    },
    async getSafeTaskFailureSnapshot(id: string, expectedOwner: 'alice' | 'bob') {
      selectedTask(id);
      if (expectedOwner !== 'alice' && expectedOwner !== 'bob') throw new Error('TEST owner required');
      const [taskRead, dataRead, logRead, pageRead] = await Promise.allSettled([
        api.teams.getTask(teamName, id), api.teams.getData(teamName),
        api.teams.getTaskLogStream(teamName, id),
        api.teams.getMessagesPage(teamName, { limit: 100, cursor: null }),
      ]);
      const task = taskRead.status === 'fulfilled' ? taskRead.value : null;
      const data = dataRead.status === 'fulfilled' ? dataRead.value : null;
      const log = logRead.status === 'fulfilled' ? logRead.value : null;
      const page = pageRead.status === 'fulfilled' ? pageRead.value : null;
      const statuses = ['pending', 'in_progress', 'completed', 'deleted'] as const;
      const advisory = data?.members.find((member) => member.name === expectedOwner)?.runtimeAdvisory;
      const advisoryCodes = ['quota_exhausted', 'rate_limited', 'auth_error',
        'codex_native_timeout', 'network_error', 'filesystem_error', 'provider_overloaded',
        'protocol_proof_missing', 'backend_error'] as const;
      const count = (value: number | undefined) => typeof value === 'number' && Number.isFinite(value)
        ? Math.max(0, Math.min(10_000, Math.floor(value))) : null;
      // This production projection contains display text, not a guaranteed
      // secret/path redaction. Emit only closed classifications and task facts.
      const row = (value: unknown): Record<string, unknown> =>
        value && typeof value === 'object' && !Array.isArray(value)
          ? (value as Record<string, unknown>)
          : {};
      const knownTools = [
        'task_get',
        'task_list',
        'task_start',
        'task_set_status',
        'task_add_comment',
        'task_complete',
        'member_work_sync_status',
        'member_work_sync_report',
        'message_send',
        'member_briefing',
        'runtime_bootstrap_checkin',
        'read',
        'bash',
        'edit',
        'write',
        'apply_patch',
        'glob',
        'grep',
        'list',
        'lsp',
        'question',
        'todoread',
        'todowrite',
        'getmcptools',
        'callmcptool',
        'list_mcp_resources',
        'read_mcp_resource',
      ];
      const name = (value: string) => {
        const normalized = value
          .trim()
          .toLowerCase()
          .replace(/^proxy_/, '')
          .replace(/^(?:mcp__agent[-_]teams__|agent[-_]teams_)/, '');
        return knownTools.find((tool) => tool === normalized) ?? 'other';
      };
      const classifyText = (text: string) => {
        const bounded = text.slice(0, 16_384).toLowerCase();
        if (bounded.includes('unknown team') && bounded.includes('config.json'))
          return 'reports_unknown_team';
        if (bounded.includes('unknown task actor')) return 'reports_unknown_task_actor';
        if (/permission denied|access denied|not permitted/.test(bounded))
          return 'reports_permission_denied';
        if (/task.*(?:not found|does not exist)/.test(bounded)) return 'reports_task_missing';
        if (/tool.*(?:not found|unavailable|not available)|(?:missing|unknown) tool/.test(bounded))
          return 'reports_tool_unavailable';
        return bounded.trim() ? 'other_text' : 'empty';
      };
      const decodeResult = (value: unknown, depth = 0): { value: unknown; error: boolean } => {
        if (depth > 5) return { value: undefined, error: false };
        if (typeof value === 'string') {
          if (value.length > 32_768) return { value: undefined, error: false };
          try {
            return decodeResult(JSON.parse(value), depth + 1);
          } catch {
            return { value, error: false };
          }
        }
        if (Array.isArray(value)) {
          if (value.length !== 1 || row(value[0]).type !== 'text')
            return { value: undefined, error: false };
          return decodeResult(row(value[0]).text, depth + 1);
        }
        const object = row(value);
        const nested = Array.isArray(object.content)
          ? decodeResult(object.content, depth + 1)
          : { value, error: false };
        return { value: nested.value, error: object.isError === true || nested.error };
      };
      const messages = [
        ...new Map(
          (log?.segments ?? [])
            .slice(-8)
            .filter((segment) => segment.actor.memberName === expectedOwner)
            .flatMap((segment) =>
              segment.chunks.slice(-16).flatMap((chunk) => chunk.rawMessages.slice(-16))
            )
            .map((message) => [message.uuid, message] as const)
        ).values(),
      ].slice(-128);
      const results = messages.flatMap((message) => message.toolResults.slice(0, 32));
      const observedTools = messages
        .flatMap((message) => message.toolCalls.slice(0, 16))
        .slice(-32)
        .map((call) => {
          const toolName = name(call.name),
            matching = results.filter((result) => result.toolUseId === call.id);
          const result = matching[0],
            decoded = decodeResult(result?.content),
            payload = row(decoded.value);
          const isTask = typeof payload.id === 'string' && typeof payload.status === 'string';
          const text =
            typeof decoded.value === 'string'
              ? decoded.value
              : typeof payload.error === 'string'
                ? payload.error
                : typeof row(payload.error).message === 'string'
                  ? String(row(payload.error).message)
                  : !isTask && typeof payload.message === 'string'
                    ? payload.message
                    : '';
          const reportedFailure =
            toolName !== 'other' &&
            (text.startsWith(`Tool '${toolName}' execution failed:`) ||
              text.startsWith(`Tool '${call.name}' execution failed:`));
          return {
            name: toolName,
            resultCount: count(matching.length),
            state: !result
              ? 'result_unobserved'
              : result.isError === true || decoded.error || payload.error !== undefined
                ? 'error'
                : reportedFailure
                  ? 'reported_error'
                  : 'returned',
            resultErrorFlag: result ? result.isError === true : null,
            inputTeamMatches:
              call.input.teamName === undefined ? null : call.input.teamName === teamName,
            inputTaskMatches: call.input.taskId === undefined ? null : call.input.taskId === id,
            inputActorMatches:
              call.input.actor === undefined ? null : call.input.actor === expectedOwner,
            resultKind: !result
              ? 'unobserved'
              : decoded.value === null
                ? 'null'
                : isTask
                  ? 'task'
                  : decoded.error || payload.error !== undefined
                    ? 'error_object'
                    : reportedFailure
                      ? 'reported_error_text'
                      : typeof decoded.value === 'string'
                        ? 'text'
                        : 'other',
            resultTextClass: classifyText(text),
            rpcErrorCode:
              [-32700, -32600, -32601, -32602, -32603].find(
                (code) => code === payload.code || code === row(payload.error).code
              ) ?? null,
            task:
              toolName === 'task_get' && isTask
                ? {
                    idMatches: payload.id === id,
                    ownerMatches: payload.owner === expectedOwner,
                    status: statuses.find((status) => status === payload.status) ?? 'unknown',
                    promptPresent:
                      typeof payload.prompt === 'string' && payload.prompt.trim().length > 0,
                    descriptionPresent:
                      typeof payload.description === 'string' &&
                      payload.description.trim().length > 0,
                  }
                : null,
          };
        });
      const assistant = messages
        .filter((message) => message.type === 'assistant' && !message.isMeta)
        .at(-1);
      const assistantText =
        typeof assistant?.content === 'string'
          ? assistant.content.slice(0, 16_384)
          : (assistant?.content ?? [])
              .slice(0, 8)
              .filter((block) => block.type === 'text')
              .map((block) => (block.type === 'text' ? block.text.slice(0, 16_384) : ''))
              .join('\n');
      const turn = {
        observation: 'bounded_task_log_only' as const,
        observedMessageCount: count(messages.length),
        observedTools,
        assistantTextClass: classifyText(assistantText),
        assistantHasToolCalls: assistant ? assistant.toolCalls.length > 0 : null,
        // OpenCodeRuntimeProjectionMapper currently drops native finish/usage.
        nativeFinishAndUsage: 'not_exposed_by_task_log' as const,
      };
      const messageIds = [...new Set((page?.messages ?? []).filter((message) =>
        message.to === expectedOwner && message.taskRefs?.some((ref) =>
          ref.taskId === id && ref.teamName === teamName))
        .map((message) => message.messageId).filter((value): value is string => !!value))].slice(0, 4);
      const ledgerStates = ['pending', 'accepted', 'responded', 'unanswered', 'retry_scheduled',
        'retried', 'failed_retryable', 'failed_terminal'] as const;
      const responseStates = ['not_observed', 'pending', 'prompt_not_indexed', 'responded_tool_call',
        'responded_visible_message', 'responded_non_visible_tool', 'responded_plain_text',
        'permission_blocked', 'tool_error', 'empty_assistant_turn',
        'prompt_delivered_no_assistant_message', 'session_stale', 'session_error', 'reconcile_failed'] as const;
      const deliveries = await Promise.all(messageIds.map(async (messageId) => {
        try {
          const status = await this.getOpenCodeRuntimeDeliveryStatus(messageId);
          if (!status) return null;
          const boolean = (value: unknown) => typeof value === 'boolean' ? value : null;
          return {
            attempted: boolean(status.attempted), accepted: boolean(status.accepted),
            delivered: boolean(status.delivered), acceptanceUnknown: boolean(status.acceptanceUnknown),
            responsePending: boolean(status.responsePending),
            ledgerStatus: ledgerStates.find((value) => value === status.ledgerStatus) ?? null,
            responseState: responseStates.find((value) => value === status.responseState) ?? null,
            reasonCode: status.reasonCode === 'unclassified' ? null : status.reasonCode,
            diagnosticCodes: status.diagnosticCodes.filter((code) => code !== 'unclassified'),
          };
        } catch { return null; }
      }));
      return {
        taskId: id,
        taskStatus: task ? statuses.find((value) => value === task.status) ?? 'unknown' : 'missing',
        ownerMatches: !!task && task.owner === expectedOwner,
        commentCount: count(task?.comments?.length),
        log: log ? { segments: count(log.segments.length),
          projectedMessages: count(log.runtimeProjection?.projectedMessageCount),
          nativeTools: count(log.runtimeProjection?.nativeToolCount),
          boardTools: count(log.runtimeProjection?.boardMcpToolCount), turn } : null,
        advisory: advisory ? {
          kind: advisory.kind === 'api_error' || advisory.kind === 'sdk_retrying' ? advisory.kind : null,
          reasonCode: advisoryCodes.find((code) => code === advisory.reasonCode) ?? null,
        } : null,
        // A bounded page is not an exhaustive proof that delivery never happened.
        matchedMessages: messageIds.length, messageSearchExhaustive: false,
        deliveries,
        unavailable: [taskRead, dataRead, logRead, pageRead].some((read) => read.status === 'rejected'),
      };
    },
    async updateTaskOwner(id: string, owner: string | null) {
      selectedTask(id);
      return api.teams.updateTaskOwner(teamName, id, owner);
    },
    async getProvisioningStatus() {
      check();
      if (!runId) throw new Error('owned launch required');
      const status = await api.teams.getProvisioningStatus(runId);
      // The host's existing IPC catch redacts this error before CDP transport.
      if (status.state === 'failed') throw new Error(status.error || status.message);
      return status;
    },
    async getRuntime() {
      check();
      return api.teams.getTeamAgentRuntime(teamName);
    },
    async getData() {
      check();
      const data = await api.teams.getData(teamName);
      // Persisted tasks remain within this same private TEST team after restart.
      for (const task of data.tasks) tasks.add(task.id);
      return data;
    },
    async getMessagesPage(request: Parameters<ElectronAPI['teams']['getMessagesPage']>[1]) {
      check();
      return api.teams.getMessagesPage(teamName, request);
    },
    async getOpenCodeRuntimeDeliveryStatus(messageId: string) {
      check();
      const status = await api.teams.getOpenCodeRuntimeDeliveryStatus(teamName, messageId);
      if (!status) return null;
      // Project before CDP transport: never return provider text, paths, IDs or
      // arbitrary diagnostic suffixes. These categories come from bridge and
      // delivery contracts, not from model output.
      const codes = [
        'unsupported_schema',
        'unsupported_command',
        'invalid_input',
        'runtime_not_ready',
        'provider_error',
        'timeout',
        'transport_watchdog_timeout',
        'contract_violation',
        'internal_error',
        'opencode_runtime_not_active',
        'opencode_runtime_message_bridge_unavailable',
        'opencode_project_path_unavailable',
        'opencode_primary_lane_bootstrap_missing',
        'opencode_primary_lane_bootstrap_unrecoverable',
        'opencode_delivery_response_pending',
        'opencode_prompt_delivery_failed_terminal',
        'opencode_message_delivery_exception',
        'opencode_prompt_acceptance_missing_runtime_prompt_id',
      ];
      const classify = (value: string | undefined) => {
        if (!value) return null;
        return (
          codes.find(
            (code) =>
              value === code ||
              value.startsWith(`${code}:`) ||
              ['info', 'warning', 'error'].some((level) => value.startsWith(`${level}:${code}:`))
          ) ?? 'unclassified'
        );
      };
      return {
        attempted: status.attempted,
        accepted: status.accepted,
        delivered: status.delivered,
        acceptanceUnknown: status.acceptanceUnknown,
        responsePending: status.responsePending,
        ledgerStatus: status.ledgerStatus,
        responseState: status.responseState,
        reasonCode: classify(status.reason),
        diagnosticCodes: [
          ...new Set((status.diagnostics ?? []).map(classify).filter((code) => code !== null)),
        ],
      };
    },
    async sendMessage(request: Parameters<ElectronAPI['teams']['sendMessage']>[1]) {
      check();
      return api.teams.sendMessage(teamName, request);
    },
    async stop() {
      check();
      if (submitted) await api.teams.stop(teamName);
    },
    async processAlive() {
      check();
      return api.teams.processAlive(teamName);
    },
    async launchTeam(request: Parameters<ElectronAPI['teams']['launchTeam']>[0]) {
      check();
      if (
        relaunchAttempted ||
        request.teamName !== teamName ||
        request.cwd !== projectPath ||
        request.providerId !== 'opencode'
      )
        throw new Error('same owned team relaunch required');
      relaunchAttempted = true;
      // A confirmed TEST app restart creates a fresh renderer adapter. Recover
      // the stopped team's persisted run identity through the normal API.
      if (!runId) {
        const retained = await api.teams.getTeamAgentRuntime(teamName);
        if (!retained.runId || (await api.teams.processAlive(teamName))) {
          throw new Error('retained stopped TEST run required');
        }
        runId = retained.runId;
      }
      const previous = runId;
      submitted = true;
      launchPending = true;
      progress.length = 0;
      const result = await api.teams.launchTeam(request);
      if (result.runId === previous) throw new Error('fresh run identity required');
      runId = result.runId;
      progress.push(...pendingProgress.filter((value) => value.runId === runId));
      pendingProgress.length = 0;
      launchPending = false;
      return result;
    },
    dispose() {
      if (!disposed) {
        disposed = true;
        unsubscribe();
      }
    },
  };
}
