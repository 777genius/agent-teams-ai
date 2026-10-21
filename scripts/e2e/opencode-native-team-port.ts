import type { ElectronAPI } from '@shared/types/api';
import type { OpenCodeStopCausalFailure, TeamCreateRequest, TeamProvisioningProgress } from '@shared/types/team';

// Proof-only projection; production lifecycle and delivery contracts remain unchanged.
export type NativeCausalFailure = OpenCodeStopCausalFailure & {
  bridgeFailure?: { kind: string; sdkCode: string; nativeOperation?: string };
};

type NativeCommandExecution = Extract<Awaited<ReturnType<ElectronAPI['teams']['getTaskLogStream']>>['segments'][number]['chunks'][number], { chunkType: 'ai' }>['toolExecutions'][number];
export type NativeCommandExpectation = {
  session: string; program: string; marker: string; model: string;
};

/** Closed identifiers in redacted diagnostic text; the text itself never leaves. */
const closedDiagnosticTokens = (values: readonly (string | undefined)[] | undefined) =>
  [...new Set((values ?? []).flatMap((value) =>
    typeof value === 'string'
      ? value.match(/\b(?:[a-z][a-z0-9]*(?:_[a-z0-9]+){1,12}|EPERM|EACCES|ENOENT|ENOTDIR|EISDIR|EINVAL|EIO|ENOSYS|EBUSY|EEXIST|ELOOP|UNKNOWN|[A-Z][A-Za-z]{1,30}Error)\b/g) ?? []
      : []))].slice(0, 16);

/** The exact acceptance predicates, also used for finite failure observations. */
export function nativeCommandMatch(execution: NativeCommandExecution, program: string, marker: string) {
  const command = execution.toolCall.input.command;
  const shell = ['bash', 'shell', 'exec'].includes(execution.toolCall.name);
  const programMatches = typeof command === 'string' && command.includes(program);
  const nodeMatches = typeof command === 'string' && /\bnode(?:\.exe)?\b/i.test(command);
  // Diagnostic presence only. Equivalent spellings never relax acceptance.
  // Keep this closure self-contained because the host serializes it into CDP.
  const slash = (value: string) => value.replace(/\\/g, '/');
  const normalizedProgram = slash(program);
  const normalizedCommand = typeof command === 'string' ? slash(command) : '';
  const windowsAbsolute = /^[A-Za-z]:\//.test(normalizedProgram);
  const directory = normalizedProgram.slice(0, normalizedProgram.lastIndexOf('/'));
  const basename = normalizedProgram.slice(normalizedProgram.lastIndexOf('/') + 1);
  // Recognize only a single plain Node invocation, never shell fragments or
  // embedded text. An absent/relative workdir cannot bind a relative argument.
  const invocation = typeof command === 'string'
    ? /^\s*node(?:\.exe)?\s+(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([^\s"';&|<>`$]+))\s*$/i.exec(command)
    : null;
  const argument = invocation ? slash(invocation[1] ?? invocation[2] ?? invocation[3]) : null;
  const relativeProgramArgument = argument !== null &&
    [basename, './' + basename].includes(argument);
  const workdir = execution.toolCall.input.workdir;
  const normalizedWorkdir = typeof workdir === 'string' ? slash(workdir).replace(/\/$/, '') : null;
  const workdirProjectMatches = normalizedWorkdir !== null && windowsAbsolute &&
    /^[A-Za-z]:\//.test(normalizedWorkdir)
    ? normalizedWorkdir.toLowerCase() === directory.toLowerCase() : null;
  const commandShape = {
    slashNormalizedAbsolutePresent: windowsAbsolute && normalizedCommand.includes(normalizedProgram),
    caseNormalizedAbsolutePresent: windowsAbsolute && normalizedCommand.toLowerCase().includes(normalizedProgram.toLowerCase()),
    relativeProgramArgument,
    workdirProjectMatches,
    relativeProgramAtProject: relativeProgramArgument && workdirProjectMatches === true,
  };
  const resultPaired = execution.result?.toolUseId === execution.toolCall.id;
  const resultSucceeded = execution.result?.isError === false;
  const hasMarker = (content: unknown): boolean => {
    if (typeof content !== 'string') return false;
    if (content.split(/\r?\n/).includes(marker)) return true;
    try {
      const blocks: unknown = JSON.parse(content);
      return Array.isArray(blocks) && blocks.some((block) => block && typeof block === 'object' &&
        'type' in block && block.type === 'text' && 'text' in block && typeof block.text === 'string' &&
        block.text.split(/\r?\n/).includes(marker));
    } catch { return false; }
  };
  const markerMatches = hasMarker(execution.result?.content);
  return { shell, programMatches, nodeMatches, commandShape, resultPaired, resultSucceeded, markerMatches,
    nativeMatches: shell && programMatches && nodeMatches,
    succeeded: resultPaired && resultSucceeded && markerMatches };
}

/** Renderer adapter for the existing full-team scenario. The host driver must
 * first verify its owned Electron PID/CDP listener and isolated TEST profile.
 * This module does not launch Electron or establish that host ownership proof.
 * Importing it never submits work. All mutations are explicit and single-shot.
 */
export function electronTeamPort(api: ElectronAPI, teamName: string, projectPath: string, matchCommand = nativeCommandMatch, projectCausal: (value: unknown) => NativeCausalFailure | null = () => null) {
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
  // Failure diagnostics reuse only a completed gate read for this exact task.
  // They never start an extra long-lived transcript request before Stop.
  const completedTaskLogs = new Map<string, {
    stream: Awaited<ReturnType<ElectronAPI['teams']['getTaskLogStream']>>;
    completedAt: number;
  }>();
  let disposed = false;
  const check = () => {
    if (disposed) throw new Error('renderer port disposed');
  };
  const selectedTask = (id: string) => {
    check();
    if (!tasks.has(id)) throw new Error('task is not owned by this TEST scenario');
  };
  // Original native/provider reasons stay inside the renderer. The proof gets
  // only closed names/signals and bounded numeric facts, never message text.
  const safeFailure = (value: unknown) => {
    const original = typeof value === 'string' ? value : '';
    const text = original.slice(0, 32_768);
    const record = (input: unknown): Record<string, unknown> =>
      input && typeof input === 'object' && !Array.isArray(input)
        ? (input as Record<string, unknown>) : {};
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch {
      // Stop diagnostics can prefix the original provider JSON with a guard.
      try { parsed = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)); }
      catch { /* Native reasons are often plain text. */ }
    }
    const root = record(parsed), error = record(root.error), data = record(error.data ?? root.data);
    const unsupportedMaxTokens = "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.";
    const rows = [root, error, data];
    const errorNames = ['APIError', 'APICallError', 'AI_APICallError', 'ProviderAuthError',
      'MessageAbortedError', 'ContextOverflowError', 'StructuredOutputError', 'UnknownError',
      'NoOutputGeneratedError', 'NoObjectGeneratedError', 'InvalidResponseDataError',
      'TypeValidationError', 'InvalidPromptError', 'UnsupportedFunctionalityError',
      'ModelNotFoundError'] as const;
    const codes = ['insufficient_credits', 'insufficient_quota', 'rate_limit_exceeded',
      'invalid_api_key', 'context_length_exceeded', 'max_tokens_exceeded', 'model_not_found',
      'invalid_request_error', 'invalid_request', 'authentication_error', 'permission_denied',
      'server_error', 'overloaded_error', 'billing_error'] as const;
    const signals = [
      ['credits_or_quota', /insufficient.?credits|not enough credits|more credits|can only afford|quota.{0,40}(?:exceeded|exhausted)|credit balance.{0,40}(?:low|insufficient)/i],
      ['rate_limit', /rate.?limit|too many requests/i],
      ['authentication', /invalid.?api.?key|incorrect.?api.?key|unauthorized|authentication|token refresh failed/i],
      ['model_unavailable', /model.{0,80}(?:not found|does not exist|unavailable)|unknown model|no endpoints found/i],
      ['context_limit', /context.{0,60}(?:exceed|limit|maximum)|maximum context length/i],
      ['output_limit', /max_tokens|max output tokens|output token limit/i],
      ['tool_input_invalid', /tool.{0,60}(?:schema|arguments|input).{0,40}(?:invalid|malformed)|invalid.{0,40}tool/i],
      ['permission_denied', /permission denied|access denied|not permitted/i],
      ['network', /fetch failed|connection reset|socket hang up|ECONNRESET|ECONNREFUSED|ENOTFOUND|ETIMEDOUT/i],
      ['provider_unavailable', /overload|service unavailable|server error/i],
      ['aborted', /aborted|cancelled|canceled/i],
      ['filesystem', /\b(?:EACCES|EPERM|ENOENT)\b/],
      ['no_output', /no output generated|NoOutputGeneratedError|NoObjectGeneratedError/i],
      ['response_invalid', /invalid response|response.{0,30}(?:empty|malformed)|empty response|TypeValidationError|InvalidResponseDataError/i],
    ] as const;
    const numeric = (input: unknown, min: number, max: number) =>
      Number.isSafeInteger(input) && Number(input) >= min && Number(input) <= max
        ? Number(input) : null;
    const tokens = (pattern: RegExp) => numeric(Number(pattern.exec(text)?.[1]), 1, 10_000_000);
    return {
      factsSource: 'bounded_original_reason_text' as const,
      // Match the complete public provider template, including a JSON-quoted
      // reason; length or a max_tokens mention alone is never this proof.
      parameterFailure: (original === unsupportedMaxTokens ||
        original === JSON.stringify(unsupportedMaxTokens))
        ? { template: 'unsupported_max_tokens' as const, parameter: 'max_tokens' as const,
          replacement: 'max_completion_tokens' as const }
        : null,
      present: text.length > 0,
      inspectedCharacters: text.length,
      truncated: original.length > text.length,
      reportedErrorName: errorNames.find((name) => rows.some((row) => row.name === name) ||
        new RegExp(`\\b${name}\\b`).test(text)) ?? null,
      providerCode: codes.find((code) => rows.some((row) => row.code === code)) ?? null,
      httpStatus: rows.flatMap((row) => [row.statusCode, row.status, row.code])
        .map((code) => numeric(code, 100, 599)).find((code) => code !== null) ?? null,
      retryable: rows.map((row) => row.isRetryable).find((flag) => typeof flag === 'boolean') ?? null,
      signals: signals.filter(([, pattern]) => pattern.test(text)).map(([signal]) => signal),
      requestedTokens: tokens(/requested(?: up to)?\s+(\d+)\s+tokens/i),
      affordableTokens: tokens(/can only afford\s+(\d+)/i),
      maximumContextTokens: tokens(/maximum context length(?: is| of)?\s+(\d+)\s+tokens/i),
      resultingTokens: tokens(/(?:resulted in|requested)\s+(\d+)\s+tokens/i),
    };
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
      // Only closed identifiers and enumerated codes cross this boundary; labels,
      // details and raw log text are dropped here.
      const diagnosticCodes = [
        'spawn_accepted',
        'runtime_process_detected',
        'runtime_process_candidate',
        'tmux_shell_only',
        'runtime_not_found',
        'permission_pending',
        'bootstrap_confirmed',
        'bootstrap_stalled',
        'workspace_trust_preflight',
        'stale_runtime_event_rejected',
        'process_table_unavailable',
      ] as const;
      const severities = ['info', 'warning', 'error'] as const;
      try {
        const diagnostics = await api.teams.getLaunchFailureDiagnostics(teamName, runId);
        const breadcrumb = diagnostics.bootstrapTransportBreadcrumb;
        const launchDiagnostics: { code: string; severity: string; memberName: string | null }[] = [];
        let provisioningState: string | null = null;
        try {
          const status = runId === undefined ? null : await api.teams.getProvisioningStatus(runId);
          if (status && status.runId === runId && status.teamName === teamName) {
            provisioningState =
              typeof status.state === 'string' && /^[a-z_]{1,32}$/.test(status.state)
                ? status.state
                : null;
            for (const item of (status.launchDiagnostics ?? []).slice(0, 32)) {
              const code = diagnosticCodes.find((value) => value === item.code);
              const severity = severities.find((value) => value === item.severity);
              if (!code || !severity) continue;
              launchDiagnostics.push({
                code,
                severity,
                memberName:
                  typeof item.memberName === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(item.memberName)
                    ? item.memberName
                    : null,
              });
            }
          }
        } catch {
          /* Provisioning status is diagnostic-only here. */
        }
        return {
          boundary: createBoundary,
          classification:
            codes.find((code) => code === diagnostics.classification?.code) ?? 'unknown',
          classificationConfidence:
            typeof diagnostics.classification?.confidence === 'number' &&
            Number.isFinite(diagnostics.classification.confidence)
              ? diagnostics.classification.confidence
              : null,
          evidenceTokens: closedDiagnosticTokens([
            ...(diagnostics.classification?.evidence ?? []),
            ...(breadcrumb?.evidence ?? []),
          ]),
          breadcrumbStage:
            typeof breadcrumb?.lastTransportStage === 'string' &&
            /^[A-Za-z0-9_.:\- ]{1,96}$/.test(breadcrumb.lastTransportStage)
              ? breadcrumb.lastTransportStage
              : null,
          retryable: typeof breadcrumb?.retryable === 'boolean' ? breadcrumb.retryable : null,
          noStdinWarning: breadcrumb?.noStdinWarning === true,
          bootstrapSubmitted: breadcrumb?.bootstrapSubmitted === true,
          submitRejected: breadcrumb?.submitRejected === true,
          provisioningState,
          launchDiagnostics,
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
      const stream = await api.teams.getTaskLogStream(teamName, id);
      completedTaskLogs.set(id, { stream, completedAt: Date.now() });
      return stream;
    },
    async getSafeTaskFailureSnapshot(id: string, expectedOwner: 'alice' | 'bob', command?: NativeCommandExpectation) {
      selectedTask(id);
      if (expectedOwner !== 'alice' && expectedOwner !== 'bob') throw new Error('TEST owner required');
      const completedLog = completedTaskLogs.get(id);
      const [taskRead, dataRead, logRead, pageRead] = await Promise.allSettled([
        api.teams.getTask(teamName, id), api.teams.getData(teamName),
        completedLog ? Promise.resolve(completedLog.stream) : api.teams.getTaskLogStream(teamName, id),
        api.teams.getMessagesPage(teamName, { limit: 100, cursor: null }),
      ]);
      const commandObservation = command && logRead.status === 'fulfilled' ? (() => {
        let shellCount = 0;
        const tuples: { tool: 'bash' | 'shell' | 'exec'; actorMatches: boolean; sessionMatches: boolean;
          modelMatches: boolean; modelMismatch: boolean; match: ReturnType<typeof matchCommand> }[] = [];
        for (const segment of logRead.value.segments) for (const chunk of segment.chunks) {
          if (chunk.chunkType !== 'ai') continue;
          const models = chunk.responses.filter((response) => response.type === 'assistant' || response.role === 'assistant')
            .map((response) => response.model).filter((value): value is string => typeof value === 'string' && value.length > 0);
          for (const execution of chunk.toolExecutions) {
            const match = matchCommand(execution, command.program, command.marker);
            const tool = (['bash', 'shell', 'exec'] as const).find((name) => name === execution.toolCall.name);
            if (!tool) continue;
            shellCount = Math.min(10_000, shellCount + 1);
            tuples.push({ tool, actorMatches: segment.actor.memberName === expectedOwner,
              sessionMatches: segment.actor.sessionId === command.session,
              modelMatches: models.includes(command.model), modelMismatch: models.some((value) => value !== command.model), match });
            if (tuples.length > 8) tuples.shift();
          }
        }
        return { shellCount, tuples, exhaustive: shellCount <= 8 };
      })() : null;
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
            nativeSessionFailure: status.nativeSessionFailure,
            causalFailure: status.causalFailure,
          };
        } catch { return null; }
      }));
      return {
        taskId: id,
        commandObservation,
        logReadSource: completedLog ? 'last_completed_gate_read' : 'fresh_read',
        logReadAgeMs: completedLog
          ? Math.min(0xffffffff, Math.max(0, Date.now() - completedLog.completedAt))
          : null,
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
        causalFailure: (status.diagnostics ?? []).map(value => projectCausal(value)).find(value => value !== null) ?? null,
        nativeSessionFailure: status.responseState === 'session_error'
          ? { source: 'native_session_error_ledger_reason' as const,
            ...safeFailure(status.reason), nativeStatusAndUsage: 'not_exposed_by_delivery_ledger' as const }
          : null,
      };
    },
    async getSafeStopFailure() {
      check();
      let failed = progress.slice(-32).filter((value) => value.teamName === teamName &&
        value.runId === runId && value.state === 'failed' &&
        value.message === 'OpenCode team stop failed').at(-1);
      // Stop records retained progress without publishing a provisioning event.
      // Observe only this exact original run once; this never starts another Stop.
      if (!failed && runId) {
        try {
          const retained = await api.teams.getProvisioningStatus(runId);
          const own = (key: string): unknown => {
            if (!retained || typeof retained !== 'object' || Array.isArray(retained)) return undefined;
            const descriptor = Object.getOwnPropertyDescriptor(retained, key);
            return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
          };
          if (own('teamName') === teamName && own('runId') === runId && own('state') === 'failed' &&
              own('message') === 'OpenCode team stop failed') {
            const error = own('error');
            failed = { teamName, runId, state: 'failed', message: 'OpenCode team stop failed',
              startedAt: '', updatedAt: '', error: typeof error === 'string' ? error.slice(0, 32_768) : undefined };
          }
        } catch { /* Missing or foreign retained observations stay unknown. */ }
      }
      const text = (failed?.error ?? '').slice(0, 32_768);
      const v2MemberCodes = ['tombstone_unknown', 'cancel_or_interrupt_unknown', 'readers_unknown',
        'physical_cleanup_unknown', 'run_tombstone_unknown'];
      const v2Word = '(?:' + [...v2MemberCodes, 'stop unconfirmed'].join('|') + ')';
      const v2Member = '(?:team-lead|alice|bob): ' + v2Word + '(?:; ' + v2Word + ')*';
      const v2Stop = new RegExp('^OpenCode team did not confirm stop: warning:opencode_v2_cleanup_unknown: ' +
        'Physical cleanup remains unverified; retained tombstones forbid send/relaunch\\.(?:; ' + v2Member + ')*' +
        '(?: \\((?:host process still alive: pid [0-9]+(?:, [0-9]+)*|no recorded host pid to verify)\\))?$').test(text);
      const v2Codes = v2Stop ? ['opencode_v2_cleanup_unknown', ...v2MemberCodes.filter(code =>
        new RegExp('(?:^|[ :;])' + code + '(?=;| \\(|$)').test(text))] : [];
      const codes = ['opencode_stop_identity_changed', 'opencode_stop_status_unconfirmed',
        'opencode_stop_abort_rejected', 'opencode_stop_deadline', 'opencode_stop_compensation_failed',
        'unsupported_schema', 'unsupported_command', 'invalid_input', 'runtime_not_ready',
        'provider_error', 'timeout', 'transport_watchdog_timeout', 'contract_violation', 'internal_error'];
      // These are original SDK/desktop guards, retained inside the outer bridge
      // wrapper. Keep every matching boundary instead of replacing it with the
      // desktop's generic stop_not_confirmed label.
      const reasons = [
        ['lifecycle_identifiers_required', 'OpenCode lifecycle authority requires teamId and laneId'],
        ['lane_precondition_mismatch', 'OpenCode bridge expected laneId precondition does not match command laneId'],
        ['run_precondition_mismatch', 'OpenCode bridge expectedRunId precondition does not match command runId'],
        ['empty_lane_authority_mismatch', 'OpenCode empty-lane stop authority mismatch'],
        ['selected_lane_authority_unavailable', 'OpenCode lifecycle selected lane authority is unavailable'],
        ['existing_capability_required', 'OpenCode lifecycle existing lane requires a capability snapshot'],
        ['lifecycle_run_required', 'OpenCode lifecycle authority requires runId'],
        ['stored_run_authority_mismatch', 'OpenCode lifecycle stored run authority mismatch'],
        ['selected_run_authority_unavailable', 'OpenCode lifecycle selected run authority is unavailable'],
        ['selected_lane_scope_unavailable', 'OpenCode lifecycle selected lane scope is unavailable'],
        ['lane_project_authority_mismatch', 'OpenCode lifecycle lane project authority mismatch'],
        ['lane_scope_ambiguous', 'OpenCode lifecycle lane scope is ambiguous'],
        ['confirmed_stop_authority_mismatch', 'OpenCode confirmed stop authority mismatch'],
        ['host_authority_ambiguous', 'OpenCode lifecycle lane host authority is ambiguous'],
        ['process_authority_ambiguous', 'OpenCode lifecycle lane process authority is ambiguous'],
        ['cleanup_host_ownership_unavailable', 'OpenCode cleanup host ownership is unavailable'],
        ['cleanup_endpoint_invalid', 'OpenCode cleanup endpoint is invalid'],
        ['cleanup_process_ownership_unavailable', 'OpenCode cleanup host process ownership is unavailable'],
        ['stop_identifiers_required', 'opencode.stopTeam requires runId, laneId and teamId/teamName'],
        ['retained_capability_required', 'OpenCode Stop requires retained capability authority'],
        ['stop_target_mismatch', 'OpenCode Stop target_mismatch'],
        ['stop_contract_inflight', 'OpenCode Stop inflight; query stopOutcome/reconcileStop'],
        ['target_project_mismatch', 'OpenCode Stop target project mismatch'],
        ['original_request_target_mismatch', 'OpenCode Stop original request/target mismatch'],
        ['active_run_precondition_stale', 'OpenCode bridge active run precondition is stale'],
        ['capability_precondition_mismatch', 'OpenCode bridge capability snapshot precondition mismatch'],
        ['recovery_object_invalid', 'Invalid Stop recovery object'],
        ['recovery_identity_invalid', 'Invalid Stop recovery identity'],
        ['recovery_contract_unsupported', 'Unsupported OpenCode Stop recovery contract'],
        ['recovery_session_set_required', 'Stop recovery requires the nonempty original session set'],
        ['recovery_session_set_ambiguous', 'Ambiguous Stop recovery session set'],
        ['recovery_capability_invalid', 'Invalid Stop recovery capability/behavior identity'],
        ['durable_stop_result_invalid', 'Invalid durable Stop result'],
        ['stop_receipt_corrupt', 'Corrupt Stop receipt'],
        ['stop_receipt_identity_changed', 'Stop receipt identity changed'],
        ['stop_result_conflict', 'Stop result already completed differently'],
        ['session_authority_changed', 'OpenCode session authority changed before persistence'],
        ['session_materialization_claim_fenced', 'OpenCode session write is fenced by a materialization claim'],
        ['session_materialization_owner_fenced', 'OpenCode session write is fenced by a materialization owner'],
        ['session_committed_identity_mismatch', 'OpenCode session write does not match the committed run and session'],
        ['runtime_adapter_unavailable', 'OpenCode runtime adapter is unavailable'],
        ['primary_lane_not_owned', 'OpenCode primary lane is not owned by run'],
        ['storage_ownership_changed', 'OpenCode primary lane ownership changed before stopped storage cleanup'],
        ['stop_not_confirmed', 'OpenCode team did not confirm stop'],
      ] as const;
      return {
        observation: 'same_run_stop_progress_only' as const,
        observed: failed !== undefined,
        failure: failed ? safeFailure(failed.error) : null,
        diagnosticCodes: [...v2Codes, ...codes.filter((code) => new RegExp(
          `(?:^|[\\s:;])(?:info:|warning:|error:|stop_failure_code:)${code}(?=:|$|[\\s;])`
        ).test(text))],
        originalStopReasons: reasons.filter(([, original]) => text.includes(original))
          .map(([reason]) => reason),
        guard: !failed ? null
          : text.includes('OpenCode team did not confirm stop') ? 'stop_not_confirmed'
            : text.includes('OpenCode primary lane ownership changed before stopped storage cleanup')
              ? 'storage_ownership_changed' : 'other',
        bridgeFailure: text.includes('OpenCode stop bridge failed: OpenCode bridge command failed')
          ? 'reports_command_failed_message'
          : text.includes('OpenCode stop bridge failed:') ? 'reports_stop_failure_wrapper' : 'unknown',
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
    async launchTeam(request: Parameters<ElectronAPI['teams']['launchTeam']>[0], stoppedRunId?: string) {
      check();
      if (
        relaunchAttempted ||
        request.teamName !== teamName ||
        request.cwd !== projectPath ||
        request.providerId !== 'opencode'
      )
        throw new Error('same owned team relaunch required');
      relaunchAttempted = true;
      // Confirmed Stop clears the active pointer. The TEST host retains the
      // exact previous run across its already-verified stop and app restart.
      if (!runId) {
        const retained = await api.teams.getTeamAgentRuntime(teamName);
        if (!stoppedRunId || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(stoppedRunId)
          || (retained.runId !== null && retained.runId !== stoppedRunId)
          || Object.values(retained.members).some((member) => member.alive)
          || (await api.teams.processAlive(teamName))) {
          throw new Error('retained stopped TEST run required');
        }
        runId = stoppedRunId;
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
