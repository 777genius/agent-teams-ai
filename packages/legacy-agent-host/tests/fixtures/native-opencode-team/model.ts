import { mixedNativeText, mixedSemanticText } from '../native-mixed-task-notifications.ts';
import type {
  MixedTaskNoticeReader,
  ObservedMixedTaskNotice,
} from '../native-mixed-task-notifications.ts';
import { assertNativeMessageImage } from '../native-message-image.ts';
import {
  readMixedGroupTurn,
  mixedGroupActions,
  assertMixedGroupReceipt,
  type MixedGroupTurn,
} from '../native-mixed-groups.ts';
// Finite Chat Completions inference oracle. Actual OpenCode must execute the
// offered MCP/Bash tools; this server never writes product or workspace files.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { nativePeerTurn, nativePeerActions } from '../native-peers.ts';

import { nativeToolReceipt, record } from '../native-claude-team/model.ts';
import { isOpenCodeModelProbe } from './model-probe.ts';

export const CONTEXT_MARKER = 'TEST_OPENCODE_CAPTURED_MEMBER_CONTEXT_V1';
export const COORDINATION_TOOLS = ['coordination_task_briefing', 'coordination_message_send'] as const;
export const COORDINATION_PROMPT =
  'Native local coordination check. Call coordination_task_briefing with {} once. ' +
  'Read its nonce and destination from the actual result. Then call coordination_message_send ' +
  'with exactly that nonce and destination once. After its accepted result reply OK. ' +
  'Do not use any other tool, file, command or agent.';
export const REQUIRED_TOOLS = [
  'task_create',
  'task_set_owner',
  'task_start',
  'task_add_comment',
  'task_complete',
  'message_send',
];

export const CAPTURE_TURN = 'OPENCODE_CAPTURE_TASK_START_V1';
export const CAPTURE_ASSIGNMENT = CAPTURE_TURN + '_ASSIGNMENT';
export const CAPTURE_BEFORE = 'TEST clean anchor\nTEST dirty preimage\nTEST tail\n';
export const CAPTURE_AFTER = 'TEST clean anchor\nTEST native foreground patched\nTEST tail\n';
export const CAPTURE_FAILED_AFTER = 'TEST clean anchor\nTEST native failed shell\nTEST tail\n';
export const CAPTURE_FAILED_COMMAND =
  "printf 'TEST clean anchor\\nTEST native failed shell\\nTEST tail\\n' > dirty.txt; printf 'TEST_CAPTURE_FAILED_SHELL_EXECUTED\\n'; exit 7";
export interface CaptureFileUpdateScenario {
  failedShell?: boolean;
  workspace: string;
  taskId(): string;
  phase(): 'assignment' | 'task-start';
}
export type SettingsModelProbe = {
  step: 'global-default' | 'project-default' | 'project-test' | 'local-limits';
  model: 'TEST-model' | 'TEST-project-model';
  outputTokens?: number;
};
export type LiveMembershipModelPhase = 'idle' | 'add' | 'add-ready' | 'remove' | 'restore' | 'restore-ready' | 'stopped';

export async function startOpenCodeModel(
  options: {
    nativeGeneration?: 'v2';
    coordinationProof?: true;
    localReadinessProof?: true;
    liveMembershipPhase?: () => LiveMembershipModelPhase;
    sharedSessionProbe?: boolean;
    nativeMessageImage?: boolean;
    mixedGroups?: boolean;
    mixedTaskNotifications?: MixedTaskNoticeReader;
    peerMessaging?: boolean;
    captureFileUpdate?: CaptureFileUpdateScenario;
    allowModelProbes?: boolean;
    settingsProbe?: () => SettingsModelProbe | 'idle' | undefined;
    selectedBusinessOutputTokens?: number;
    memberName?: 'alice' | 'carol';
    uiGeneratedMessageIds?: boolean;
    captureHistoryMarkers?: boolean;
    holdInitialTurnResponse?: boolean;
    principalId?: () => string;
    selectedModel?: { id: string; effort?: string };
    selectedOutputTokens?: number;
    selectedConfiguration?: { scope: string };
  } = {}
) {
  assert.ok(!(options.peerMessaging && options.captureFileUpdate));
  if (options.liveMembershipPhase) assert.ok(options.allowModelProbes && options.uiGeneratedMessageIds &&
    options.principalId && !options.coordinationProof && !options.localReadinessProof && !options.sharedSessionProbe &&
    !options.mixedGroups && !options.mixedTaskNotifications && !options.peerMessaging && !options.captureFileUpdate &&
    !options.settingsProbe && !options.holdInitialTurnResponse, 'one explicit live membership oracle');
  const livePrincipals = new Map<string, string>();
  if (options.sharedSessionProbe)
    assert.ok(
      !options.mixedGroups &&
        !options.peerMessaging &&
        !options.captureFileUpdate &&
        !options.allowModelProbes
    );
  if (options.captureFileUpdate)
    assert.match(
      options.captureFileUpdate.workspace,
      /\/TEST-native-opencode-capture-[^/]+\/workspace$/
    );

  if (options.localReadinessProof) assert.equal(options.coordinationProof, true);
  if (options.coordinationProof)
    assert.ok(!options.sharedSessionProbe && !options.mixedGroups && !options.peerMessaging &&
      !options.captureFileUpdate && !options.allowModelProbes && !options.settingsProbe &&
      !options.mixedTaskNotifications, 'one explicitly selected native coordination scenario');
  const coordinationObservations: { step: number; nativeToolRefs: string[];
    requestedModel?: string; requestedEffort?: string; requestedOutputTokens?: number }[] = [];
  const ordinaryReadinessObservations: { requestedModel?: string; requestedEffort?: string; requestedOutputTokens?: number }[] = [];
  let inventoryReads = 0;
  const localReadiness = { ordinary: ordinaryReadinessObservations, get inventoryReads() { return inventoryReads; } };
  let coordinationArmed = false, coordinationFinished = false, coordinationNonce: string | undefined;
  const coordination = {
    observations: coordinationObservations,
    arm() {
      assert.equal(options.coordinationProof, true);
      assert.ok(!coordinationArmed && !coordinationFinished && observations.length === 0 && probes.length === 0);
      coordinationArmed = true;
    },
    finish() {
      assert.ok(coordinationArmed && !coordinationFinished);
      assert.equal(coordinationObservations.length, 3); assert.equal(failures.length, 0);
      if (options.localReadinessProof) {
        assert.equal(ordinaryReadinessObservations.length, 1); assert.equal(inventoryReads, 1);
      }
      coordinationArmed = false; coordinationFinished = true;
    },
  };
  const probes: {
    requestedModel?: string;
    requestedEffort?: string;
    requestedOutputTokens?: number;
    settingsStep?: SettingsModelProbe['step'];
  }[] = [];
  const settingsSteps = new Set<SettingsModelProbe['step']>();
  const observations: {
    nativeImage?: ReturnType<typeof assertNativeMessageImage>;
    failedShellToolOutput?: ReturnType<typeof assertCaptureFailedShellOutput>;
    turn: string;
    step: number;
    contextEffective: boolean;
    priorTurn: boolean;
    requestedModel?: string;
    requestedEffort?: string;
    requestedOutputTokens?: number;
    priorNativeToolIds?: string[];
    visibleReplyContract?: boolean;
    incomingMessageId?: string;
    tools: string[];
  }[] = [];
  const notificationObservations: ((typeof observations)[number] & {
    notice: ObservedMixedTaskNotice;
  })[] = [];
  const failures: string[] = [];
  const heldInitialRequests: { turn: string; step: number; disconnected: boolean }[] = [];
  const counts = new Map<string, number>();
  let taskId: string | undefined;
  const server = createServer((request, response) => {
    void (async () => {
      assert.equal(failures.length, 0, 'oracle seals after its first protocol failure');
      if (options.localReadinessProof && request.method === 'GET') {
        assert.equal(request.url, '/v1/models');
        assert.ok(coordinationArmed && !coordinationFinished);
        assert.equal(ordinaryReadinessObservations.length, 1);
        assert.equal(coordinationObservations.length, 0); assert.equal(inventoryReads, 0);
        assert.equal(request.headers.authorization, undefined);
        for await (const chunk of request) assert.equal(Buffer.byteLength(chunk), 0, 'bodyless original metadata read');
        inventoryReads++;
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ data: [...new Set(['TEST-model', options.selectedModel?.id ?? 'TEST-model'])]
          .map(id => ({ id })) }));
        return;
      }
      assert.equal(request.method, 'POST');
      if (options.localReadinessProof) assert.equal(request.headers.authorization, undefined,
        'the original authless source remains authless through business continuation');
      assert.match(request.url ?? '', /\/v1\/chat\/completions$/);
      if (!options.mixedTaskNotifications)
        assert.ok(
          observations.length + coordinationObservations.length + ordinaryReadinessObservations.length < (options.peerMessaging ? 48 : 16),
          'finite model request budget'
        );
      let bytes = 0;
      const chunks: Buffer[] = [];
      for await (const raw of request) {
        const chunk = Buffer.from(raw as Uint8Array);
        bytes += chunk.length;
        assert.ok(bytes < 2_000_000);
        chunks.push(chunk);
      }
      const body = record(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown);
      if (options.liveMembershipPhase) {
        assert.equal(request.headers.authorization, 'Bearer TEST-LOCALHOST-ONLY');
        assert.equal(body.model, 'TEST-model');
      }
      const settingsProbe = options.settingsProbe?.();
      if (options.selectedModel && !settingsProbe) {
        assert.equal(body.model, options.selectedModel.id, 'actual native request uses the selected model');
        assert.equal(body.reasoning_effort, options.selectedModel.effort,
          'actual native request applies the selected named variant');
      }
      if (options.selectedOutputTokens !== undefined)
        assert.equal(body.max_tokens, options.selectedOutputTokens,
          'actual native request uses the saved selected-model output limit');
      if (options.selectedConfiguration) {
        assert.equal(body.test_config_scope, options.selectedConfiguration.scope,
          'actual native request retains its original private model body');
        assert.equal(request.headers['x-test-config-scope'], options.selectedConfiguration.scope,
          'actual native request retains its original private model headers');
        assert.equal(request.headers.authorization, options.localReadinessProof ? undefined : 'Bearer TEST-LOCALHOST-ONLY');
      }
      const messages = (Array.isArray(body.messages) ? body.messages : []).map(record);
      const user = messages.filter((item) => item.role === 'user');
      if (options.localReadinessProof && coordinationArmed && ordinaryReadinessObservations.length === 0) {
        assert.equal(inventoryReads, 0); assert.equal(coordinationObservations.length, 0);
        assert.equal(isOpenCodeModelProbe(body, options.nativeGeneration ?? 'v1'), true,
          'the first native input is the original ordinary no-tool probe');
        ordinaryReadinessObservations.push({
          ...(typeof body.model === 'string' ? { requestedModel: body.model } : {}),
          ...(typeof body.reasoning_effort === 'string' ? { requestedEffort: body.reasoning_effort } : {}),
          ...(typeof body.max_tokens === 'number' ? { requestedOutputTokens: body.max_tokens } : {}),
        });
        const event = (delta: Record<string, unknown>, finish: string | null) => ({
          id: 'TEST-native-readiness-ordinary', object: 'chat.completion.chunk', created: 1700000000,
          model: typeof body.model === 'string' ? body.model : 'TEST-model',
          choices: [{ index: 0, delta, finish_reason: finish }],
        });
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.write('data: ' + JSON.stringify(event({ role: 'assistant', content: 'OK' }, null)) + '\n\n');
        response.write('data: ' + JSON.stringify(event({}, 'stop')) + '\n\n');
        response.end('data: [DONE]\n\n');
        return;
      }
      if (coordinationArmed) {
        if (options.localReadinessProof) {
          assert.equal(ordinaryReadinessObservations.length, 1); assert.equal(inventoryReads, 1);
        }
        const step = coordinationObservations.length;
        assert.ok(step < 3, 'one original two-tool challenge and terminal');
        assert.equal(user.length, 1); assert.equal(mixedNativeText(user[0]!.content), COORDINATION_PROMPT);
        const offered = (Array.isArray(body.tools) ? body.tools : []).map(record)
          .map(tool => String(record(tool.function).name));
        assert.deepEqual([...offered].sort(), [...COORDINATION_TOOLS].sort(),
          'only the two inert native tools may be offered');
        const calls = messages.filter(message => message.role === 'assistant').flatMap(message =>
          Array.isArray(message.tool_calls) ? message.tool_calls.map(record) : []);
        const results = messages.filter(message => message.role === 'tool');
        assert.equal(calls.length, step); assert.equal(results.length, step);
        for (let index = 0; index < step; index++) {
          const id = 'TEST_COORDINATION_' + index;
          assert.equal(calls[index]!.id, id); assert.equal(results[index]!.tool_call_id, id);
          const call = record(calls[index]!.function);
          assert.equal(call.name, COORDINATION_TOOLS[index]); assert.equal(typeof call.arguments, 'string');
          const args = record(JSON.parse(call.arguments as string) as unknown);
          if (index === 0) assert.deepEqual(args, {});
          else assert.ok(Object.keys(args).sort().join(',') === 'destination,nonce' &&
            args.destination === 'native-local-coordination-v1' && args.nonce === coordinationNonce,
            'second actual native tool consumes the original nonce');
          let content = results[index]!.content;
          if (Array.isArray(content)) {
            assert.equal(content.length, 1);
            const block = record(content[0]); assert.equal(block.type, 'text'); content = block.text;
          }
          assert.equal(typeof content, 'string');
          const result = record(JSON.parse(content as string) as unknown);
          if (index === 0) {
            assert.equal(Object.keys(result).sort().join(','), 'destination,nonce');
            assert.equal(result.destination, 'native-local-coordination-v1');
            assert.ok(typeof result.nonce === 'string' && /^[a-f0-9]{64}$/.test(result.nonce),
              'first native tool supplies a bounded actual challenge nonce');
            if (coordinationNonce !== undefined) assert.ok(coordinationNonce === result.nonce, 'original nonce unchanged');
            else coordinationNonce = result.nonce;
          } else assert.ok(Object.keys(result).sort().join(',') === 'accepted,nonce' &&
            result.accepted === true && result.nonce === coordinationNonce, 'actual second tool accepted the original nonce');
        }
        coordinationObservations.push({ step, nativeToolRefs: calls.map(call => String(call.id)),
          ...(typeof body.model === 'string' ? { requestedModel: body.model } : {}),
          ...(typeof body.reasoning_effort === 'string' ? { requestedEffort: body.reasoning_effort } : {}),
          ...(typeof body.max_tokens === 'number' ? { requestedOutputTokens: body.max_tokens } : {}) });
        const delta = step === 2 ? { role: 'assistant', content: 'OK' } : {
          role: 'assistant', tool_calls: [{ index: 0, id: 'TEST_COORDINATION_' + step, type: 'function',
            function: { name: COORDINATION_TOOLS[step], arguments: JSON.stringify(step === 0 ? {} :
              { nonce: coordinationNonce, destination: 'native-local-coordination-v1' }) } }],
        };
        const event = (value: unknown, finish: string | null) => ({
          id: 'TEST-coordination-response-' + step, object: 'chat.completion.chunk', created: 1700000000,
          model: typeof body.model === 'string' ? body.model : 'TEST-model',
          choices: [{ index: 0, delta: value, finish_reason: finish }],
        });
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.write('data: ' + JSON.stringify(event(delta, null)) + '\n\n');
        response.write('data: ' + JSON.stringify(event({}, step === 2 ? 'stop' : 'tool_calls')) + '\n\n');
        response.end('data: [DONE]\n\n');
        return;
      }
      if (options.coordinationProof) assert.equal(coordinationFinished, true,
        'no business input before the original challenge is completed and released');
      if (
        options.allowModelProbes &&
        isOpenCodeModelProbe(body, options.nativeGeneration ?? 'v1')
      ) {
        if (options.liveMembershipPhase) {
          const expected = options.liveMembershipPhase() === 'add' ? 0 : options.liveMembershipPhase() === 'restore' ? 1 : -1;
          assert.ok(expected >= 0, 'only the original Add or Restore may prepare a model');
          assert.equal(probes.length, expected); assert.equal(observations.length, expected * 2);
        }
        assert.notEqual(settingsProbe, 'idle', 'no unrequested Settings model probe');
        if (settingsProbe && settingsProbe !== 'idle') {
          assert.equal(settingsSteps.has(settingsProbe.step), false, 'one original Settings action');
          assert.equal(body.model, settingsProbe.model, 'Settings action uses its selected model');
          assert.equal(body.reasoning_effort, undefined);
          if (settingsProbe.outputTokens !== undefined)
            assert.equal(body.max_tokens, settingsProbe.outputTokens);
          settingsSteps.add(settingsProbe.step);
        } else {
          assert.ok(
            probes.filter((probe) => probe.settingsStep === undefined).length < 8,
            'bounded original-dialog model probes'
          );
        }
        probes.push({
          ...(settingsProbe && settingsProbe !== 'idle' ? {
            settingsStep: settingsProbe.step,
            ...(typeof body.max_tokens === 'number' ? { requestedOutputTokens: body.max_tokens } : {}),
          } : {}),
          ...(typeof body.model === 'string' ? { requestedModel: body.model } : {}),
          ...(typeof body.reasoning_effort === 'string'
            ? { requestedEffort: body.reasoning_effort }
            : {}),
        });
        const event = (delta: Record<string, unknown>, finish: string | null) => ({
          id: `TEST-opencode-probe-${probes.length}`,
          object: 'chat.completion.chunk',
          created: 1700000000,
          model: typeof body.model === 'string' ? body.model : 'TEST-model',
          choices: [{ index: 0, delta, finish_reason: finish }],
        });
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.write(
          `data: ${JSON.stringify(event({ role: 'assistant', content: 'OK' }, null))}\n\n`
        );
        response.write(`data: ${JSON.stringify(event({}, 'stop'))}\n\n`);
        response.end('data: [DONE]\n\n');
        return;
      }
      assert.equal(settingsProbe, undefined, 'no business input during Settings verification');
      if (options.selectedBusinessOutputTokens !== undefined)
        assert.equal(body.max_tokens, options.selectedBusinessOutputTokens,
          'actual business request uses the saved local output limit');
      if (options.sharedSessionProbe) {
        const text = JSON.stringify(user.at(-1)?.content),
          turn = /TEST_SHARED_OPENCODE_(A1|B1|B2)/.exec(text)?.[0];
        assert.ok(turn, 'one exact shared-session native input');
        assert.equal(counts.get(turn) ?? 0, 0, 'no repeated native turn');
        const history = JSON.stringify(messages),
          contextEffective = history.includes(CONTEXT_MARKER);
        assert.equal(contextEffective, true);
        assert.equal(
          messages.some((item) => item.role === 'tool'),
          false
        );
        if (turn.endsWith('B2'))
          assert.ok(
            history.includes('TEST_SHARED_OPENCODE_B1') &&
              history.includes('REPLY_TEST_SHARED_OPENCODE_B1')
          );
        if (!turn.endsWith('A1'))
          assert.equal(
            history.includes('TEST_SHARED_OPENCODE_A1'),
            false,
            'B never consumes A history'
          );
        assert.equal(body.model, 'TEST-model');
        counts.set(turn, 1);
        observations.push({
          turn,
          step: 0,
          contextEffective,
          priorTurn: turn.endsWith('B2'),
          tools: [],
        });
        const event = (delta: Record<string, unknown>, finish: string | null) => ({
          id: 'TEST-shared-' + turn,
          object: 'chat.completion.chunk',
          created: 1700000000,
          model: 'TEST-model',
          choices: [{ index: 0, delta, finish_reason: finish }],
        });
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.write(
          `data: ${JSON.stringify(event({ role: 'assistant', content: 'REPLY_' + turn }, null))}\n\n`
        );
        response.write(`data: ${JSON.stringify(event({}, 'stop'))}\n\n`);
        response.end('data: [DONE]\n\n');
        return;
      }
      if (options.mixedTaskNotifications)
        assert.ok(
          observations.length + notificationObservations.length < (options.peerMessaging ? 48 : 16),
          'finite mixed inference budget'
        );
      let turn = '', turnText = '';
      let notice: ObservedMixedTaskNotice | undefined;
      let mixedGroup: MixedGroupTurn | undefined;
      for (const message of messages.toReversed()) {
        if (message.role !== 'user') continue;
        const group = options.mixedGroups
          ? readMixedGroupTurn(message.content, 'carol')
          : undefined;
        const capture =
          options.captureFileUpdate && JSON.stringify(message.content).includes(CAPTURE_TURN);
        const match = /OPENCODE_TEAM_(ONE|TWO)/.exec(JSON.stringify(message.content));
        const live = options.liveMembershipPhase
          ? /TEST_LIVE_MEMBERSHIP_(ADD|RESTORE)/.exec(mixedNativeText(message.content)) : undefined;
        if (options.liveMembershipPhase) {
          if (!mixedSemanticText(message.content)) continue;
          assert.ok(live, 'no historical fallback for a foreign current membership input');
        }
        const peer = options.peerMessaging
          ? nativePeerTurn(JSON.stringify(message.content), 'carol')
          : undefined;
        if (options.mixedTaskNotifications) {
          const currentText = mixedNativeText(message.content);
          if (!mixedSemanticText(currentText)) continue;
          notice = options.mixedTaskNotifications(currentText);
          if (notice) {
            turn = 'TEST_TASK_NOTICE:' + notice.inputId;
            break;
          }
          assert.ok(
            group || peer || match,
            'unrecognized CURRENT mixed input; no historical fallback'
          );
        }
        if (group || capture || peer || match || live) {
          turnText = mixedNativeText(message.content);
          mixedGroup = group;
          turn =
            live?.[0] ?? group?.turn ??
            (capture
              ? options.captureFileUpdate!.phase() === 'assignment'
                ? CAPTURE_ASSIGNMENT
                : CAPTURE_TURN
              : (peer ?? match![0]));
          break;
        }
      }
      assert.ok(turn, 'native request retains deliberate TEST business input');
      const step = counts.get(turn) ?? 0;
      if (options.mixedTaskNotifications && /_TEAM_(ONE|TWO)$/.test(turn))
        assert.ok(
          step <= (turn.endsWith('_ONE') ? 7 : 2),
          'finite original business input; no replay'
        );
      const nativeImage =
        options.nativeMessageImage && turn === 'OPENCODE_TEAM_TWO'
          ? assertNativeMessageImage(messages, 'opencode')
          : undefined;
      const groupActions = mixedGroup ? mixedGroupActions(mixedGroup) : undefined;
      if (groupActions) assert.ok(step <= groupActions.length, 'finite mixed group turn');
      const peerActions = options.peerMessaging ? nativePeerActions(turn, 'carol') : undefined;
      const capture = options.captureFileUpdate;
      let failedShellToolOutput: ReturnType<typeof assertCaptureFailedShellOutput> | undefined;
      if (capture && turn === CAPTURE_ASSIGNMENT)
        assert.equal(step, 0, 'one assignment terminal, no tools/effects');
      if (capture && turn === CAPTURE_TURN) {
        assert.ok(
          step <= (capture.failedShell ? 1 : 2),
          'one bounded original native input; no replay'
        );
        assert.ok(capture.taskId(), 'original Host canonical task captured before TaskStart');
        if (step > 0) {
          const last = messages.filter((item) => item.role === 'tool').at(-1);
          assert.ok(last);
          const output = JSON.stringify(last.content);
          if (capture.failedShell)
            failedShellToolOutput = assertCaptureFailedShellOutput(last.content);
          else if (step === 1)
            assert.ok(
              output.includes('TEST dirty preimage') &&
                !output.includes('TEST native foreground patched'),
              'native read observes dirty preimage'
            );
          else
            assert.ok(
              output.includes('Edit applied successfully.'),
              'native edit must succeed before terminal'
            );
        }
      }
      const contextEffective = JSON.stringify(
        // V2 renders durable instruction entries as context messages. The
        // original TEST business input contains no marker in either dialect.
        options.nativeGeneration === 'v2' ? messages : messages.filter((item) => item.role === 'system')
      ).includes(CONTEXT_MARKER);
      assert.ok(contextEffective, 'native model request contains selected member instructions');
      const tools = (Array.isArray(body.tools) ? body.tools : [])
        .map(record)
        .map((tool) => String(record(tool.function).name));
      const liveActions = options.liveMembershipPhase ? [{ name: 'message_send', input: {
        commandId: 'TEST-live-reply-' + (turn.endsWith('_ADD') ? 'add' : 'restore'), to: 'user', text: 'REPLY_' + turn,
      } }] : undefined;
      if (liveActions) {
        const restoring = turn === 'TEST_LIVE_MEMBERSHIP_RESTORE', phase = restoring ? 'restore-ready' : 'add-ready';
        assert.equal(options.liveMembershipPhase!(), phase); assert.ok(step < 2, 'one tool and one terminal, no replay');
        assert.equal(probes.length, restoring ? 2 : 1); assert.equal(observations.length, (restoring ? 2 : 0) + step);
        assert.equal(counts.get(restoring ? 'TEST_LIVE_MEMBERSHIP_ADD' : 'TEST_LIVE_MEMBERSHIP_RESTORE') ?? 0, restoring ? 2 : 0);
        const principal = options.principalId!(); assert.ok(principal);
        if (step === 0) {
          assert.equal(livePrincipals.has(turn), false);
          if (restoring) assert.notEqual(principal, livePrincipals.get('TEST_LIVE_MEMBERSHIP_ADD'));
          livePrincipals.set(turn, principal);
        }
        assert.equal(livePrincipals.get(turn), principal, 'the native tool result retains this exact current member');
        const calls = messages.filter(row => row.role === 'assistant').flatMap(row =>
          Array.isArray(row.tool_calls) ? row.tool_calls.map(record) : []), results = messages.filter(row => row.role === 'tool');
        assert.equal(calls.length, step); assert.equal(results.length, step);
        for (const name of REQUIRED_TOOLS) assert.ok(tools.some(tool => options.nativeGeneration === 'v2'
          ? [`agent-teams_${name}`, `mcp__agent-teams__${name}`].includes(tool) : tool === `team_${name}`));
        if (step === 1) {
          const call = calls[0]!, result = results[0]!, operation = record(call.function);
          assert.equal(call.id, `TEST_${turn}_0`); assert.equal(result.tool_call_id, call.id);
          assert.ok(tools.includes(String(operation.name)) && String(operation.name).endsWith('message_send'));
          assert.deepEqual(JSON.parse(String(operation.arguments)), liveActions[0]!.input);
          const receipt = nativeToolReceipt(result.content);
          assert.equal(receipt.phase, 'completed'); assert.equal(receipt.principalId, principal);
          assert.equal(receipt.operation, 'message.send'); assert.equal(receipt.commandId, liveActions[0]!.input.commandId);
          assert.ok(typeof record(receipt.effects).messageId === 'string' && record(receipt.effects).messageId);
        }
      }
      if (mixedGroup && step > 0) {
        const last = messages.filter((item) => item.role === 'tool').at(-1);
        assertMixedGroupReceipt(mixedGroup, step, last?.content, nativeToolReceipt);
      }
      if (
        (turn === 'OPENCODE_TEAM_ONE' && [1, 2, 3, 5, 6, 7].includes(step)) ||
        (turn === 'OPENCODE_TEAM_TWO' && step === 2) ||
        (peerActions && step > 0 && step <= peerActions.length)
      ) {
        const result = messages.filter((item) => item.role === 'tool').at(-1);
        const completed = nativeToolReceipt(result?.content);
        assert.equal(
          completed.phase,
          'completed',
          'native MCP action must succeed before scripted continuation'
        );
        assert.equal(completed.principalId, options.principalId?.() ?? 'carol-session');
      }
      if (turn === 'OPENCODE_TEAM_ONE' && step === 1) {
        const result = messages.filter((item) => item.role === 'tool').at(-1);
        const receipt = nativeToolReceipt(result?.content);
        assert.equal(receipt.phase, 'completed');
        assert.equal(receipt.principalId, options.principalId?.() ?? 'carol-session');
        taskId = String(record(receipt.effects).taskId);
        assert.ok(taskId && taskId !== 'undefined');
      }
      const observation = {
        ...(nativeImage ? { nativeImage } : {}),
        ...(failedShellToolOutput ? { failedShellToolOutput } : {}),
        turn,
        step,
        contextEffective,
        priorTurn: JSON.stringify(messages).includes('OPENCODE_TEAM_ONE'),
        ...(typeof body.model === 'string' ? { requestedModel: body.model } : {}),
        ...(typeof body.reasoning_effort === 'string' ? { requestedEffort: body.reasoning_effort } : {}),
        ...(options.selectedOutputTokens === undefined && options.selectedBusinessOutputTokens === undefined
          ? {} : { requestedOutputTokens: Number(body.max_tokens) }),
        ...(options.captureHistoryMarkers ? { priorNativeToolIds: messages.flatMap(message =>
          Array.isArray(message.tool_calls) ? message.tool_calls.map(record)
            .filter(call => typeof call.id === 'string' && /^TEST_OPENCODE_TEAM_ONE_[0-6]$/.test(call.id))
            .map(call => String(call.id)) : []) } : {}),
        ...(options.uiGeneratedMessageIds ? (() => {
          const incomingMessageId = /"messageId":"([^"\n]+)"/.exec(turnText)?.[1];
          return { ...(incomingMessageId !== undefined ? { incomingMessageId } : {}), visibleReplyContract:
            turnText.includes('message_send tool to="user", including commandId and text') &&
            turnText.includes('Do not reuse the incoming messageId as a reply commandId') &&
            typeof incomingMessageId === 'string' &&
            /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(incomingMessageId) };
        })() : {}),
        tools,
      };
      if (liveActions) assert.equal(observation.visibleReplyContract, true, 'actual original UI message envelope');
      if (notice) notificationObservations.push({ ...observation, notice });
      else observations.push(observation);
      if (options.holdInitialTurnResponse) {
        assert.equal(options.nativeGeneration, 'v2');
        assert.equal(turn, 'OPENCODE_TEAM_ONE', 'queued input must never reach native inference');
        assert.equal(step, 0); assert.equal(heldInitialRequests.length, 0, 'one original request, no retry');
        assert.equal(observation.visibleReplyContract, true);
        for (const tool of REQUIRED_TOOLS)
          assert.ok(tools.includes(`agent-teams_${tool}`) || tools.includes(`mcp__agent-teams__${tool}`));
        assert.ok(tools.includes('shell'));
        const held = { turn, step, disconnected: false };
        heldInitialRequests.push(held);
        await new Promise<void>(resolve => {
          response.once('close', () => { held.disconnected = true; resolve(); });
          if (response.destroyed) { held.disconnected = true; resolve(); }
        });
        return;
      }
      const windowsV2 = options.nativeGeneration === 'v2' && process.platform === 'win32';
      const first = [
        {
          name: 'task_create',
          input: { commandId: 'opencode-task-create', subject: 'Native OpenCode TEST task' },
        },
        {
          name: 'task_set_owner',
          input: { commandId: 'opencode-task-assign', taskId, owner: options.memberName ?? 'carol' },
        },
        { name: 'task_start', input: { commandId: 'opencode-task-start', taskId } },
        {
          name: 'bash',
          input: {
            command: windowsV2
              ? "[System.IO.File]::AppendAllText((Join-Path (Get-Location) 'native-effect.txt'), \"ONE`n\"); exit 7"
              : "printf 'ONE\\n' >> native-effect.txt; exit 7",
            description: 'TEST partial effect and failed shell exit',
          },
        },
        {
          name: 'task_add_comment',
          input: {
            commandId: 'opencode-task-comment',
            taskId,
            text: 'OpenCode native shell wrote TEST bytes and exited seven.',
          },
        },
        { name: 'task_complete', input: { commandId: 'opencode-task-complete', taskId } },
        {
          name: 'message_send',
          input: { commandId: 'opencode-reply-one', to: 'user', text: 'REPLY_OPENCODE_ONE' },
        },
      ];
      const second = [
        {
          name: 'bash',
          input: {
            command: windowsV2
              ? "[System.IO.File]::AppendAllText((Join-Path (Get-Location) 'native-effect.txt'), \"TWO`n\")"
              : "printf 'TWO\\n' >> native-effect.txt",
            description: 'TEST second sequential input',
          },
        },
        {
          name: 'message_send',
          input: { commandId: 'opencode-reply-two', to: 'user', text: 'REPLY_OPENCODE_TWO' },
        },
      ];
      const captureActions = capture
        ? turn === CAPTURE_ASSIGNMENT
          ? []
          : capture.failedShell
            ? [
                {
                  name: 'bash',
                  input: {
                    command: CAPTURE_FAILED_COMMAND,
                    workdir: capture.workspace,
                    description: 'TEST dirty write and native exit 7',
                  },
                },
              ]
            : [
                { name: 'read', input: { filePath: capture.workspace + '/dirty.txt' } },
                {
                  name: 'edit',
                  input: {
                    filePath: capture.workspace + '/dirty.txt',
                    oldString: 'TEST dirty preimage',
                    newString: 'TEST native foreground patched',
                  },
                },
              ]
        : undefined;
      const action = notice
        ? undefined
        : (liveActions ?? groupActions ??
            captureActions ??
            peerActions ??
            (turn === 'OPENCODE_TEAM_ONE' ? first : second))[step];
      let delta: Record<string, unknown>;
      if (action) {
        const nativeAction = options.nativeGeneration === 'v2' && action.name === 'bash'
          ? 'shell' : action.name;
        const chosen = tools.find((name) =>
          ['bash', 'read', 'edit'].includes(action.name)
            ? name === nativeAction
            : options.nativeGeneration === 'v2'
              ? [`agent-teams_${action.name}`, `mcp__agent-teams__${action.name}`].includes(name)
              : name === `team_${action.name}`
        );
        assert.ok(chosen, `actual OpenCode catalog contains ${action.name}`);
        if (windowsV2 && action.name === 'bash') {
          const offered = (body.tools as unknown[]).map(record)
            .map(tool => record(tool.function)).find(tool => tool.name === chosen);
          assert.match(String(offered?.description), /Commands run on Windows using powershell\./,
            'Windows shell syntax requires the actual native PowerShell tool selection');
        }
        delta = {
          role: 'assistant',
          tool_calls: [
            {
              index: 0,
              id: `TEST_${turn}_${step}`,
              type: 'function',
              function: { name: chosen, arguments: JSON.stringify(action.input) },
            },
          ],
        };
      } else delta = { role: 'assistant', content: `DONE_${turn}` };
      counts.set(turn, step + 1);
      const event = (value: Record<string, unknown>, finish: string | null) => ({
        id: `TEST-opencode-response-${observations.length + notificationObservations.length}`,
        object: 'chat.completion.chunk',
        created: 1700000000,
        model: options.selectedModel?.id ?? 'TEST-model',
        choices: [{ index: 0, delta: value, finish_reason: finish }],
      });
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(`data: ${JSON.stringify(event(delta, null))}\n\n`);
      response.write(`data: ${JSON.stringify(event({}, action ? 'tool_calls' : 'stop'))}\n\n`);
      response.end('data: [DONE]\n\n');
    })().catch((error) => {
      failures.push(error instanceof Error ? error.message : 'fixture-failed');
      if (!response.headersSent) response.writeHead(400);
      response.end('TEST Chat Completions fixture rejected request');
    });
  });
  server.requestTimeout = 15_000;
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return {
    url: `http://127.0.0.1:${address.port}`,
    observations,
    ...(options.mixedTaskNotifications ? { notificationObservations } : {}),
    probes,
    ...(options.coordinationProof ? { coordination } : {}),
    ...(options.localReadinessProof ? { localReadiness } : {}),
    failures,
    ...(options.holdInitialTurnResponse ? { heldInitialRequests } : {}),
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** Continuation shape only; opaque output proves nothing about execution or failure.
 * The later original native exit7, causal binding and dirty-byte assertions remain necessary. */
export function assertCaptureFailedShellOutput(
  output: unknown
): 'marker-text' | 'opaque-no-output' {
  if (output === '(no output)') return 'opaque-no-output';
  assert.equal(typeof output, 'string');
  assert.equal((output as string).trim(), 'TEST_CAPTURE_FAILED_SHELL_EXECUTED');
  return 'marker-text';
}
