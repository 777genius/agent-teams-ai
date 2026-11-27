import assert from 'node:assert/strict';
import { mixedNativeText, mixedSemanticText } from '../native-mixed-task-notifications.ts';

export type NativeGoalActor = 'alice' | 'bob' | 'carol';
export type NativeGoalProvider = 'claude' | 'codex' | 'opencode';
type Row = Record<string, unknown>;
export const goalRow = (value: unknown): Row => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value as Row;
};
export interface NativeGoalInput {
  inputId: string;
  operationRef: string;
  goalId: string;
  content: string;
  rootInput: boolean;
  stopped: boolean;
}
export interface NativeGoalScenario {
  actor: NativeGoalActor;
  lead: NativeGoalActor;
  mode: 'do' | 'delegate';
  workspace: string;
  workers: NativeGoalActor[];
  /** Read the actual original Runtime record only; the oracle cannot change it. */
  current(): NativeGoalInput;
}
export interface NativeGoalReply {
  id: string;
  action?: { name: string; input: Row };
  text?: string;
  release?: Promise<void>;
}
export const nativeGoalObjective = (stop: boolean) =>
  `TEST_NATIVE_GOAL_${stop ? 'STOP' : 'HAPPY'}: create and verify the prescribed two-stage TEST artifact, then propose the verified result. Do not send a separate final message.`;
export const nativeGoalArtifact = (actor: NativeGoalActor, stop: boolean, final: boolean) =>
  `${stop ? 'stop' : 'happy'}-${actor}-${final ? 'result' : 'draft'}.txt`;
export const nativeGoalBytes = (actor: NativeGoalActor, final: boolean) =>
  `TEST ${actor} ${final ? 'verified result' : 'first stage'}\n`;

/** Actual MCP JSON with the pinned SDK wrappers; no simulated tool result is produced. */
export function readNativeGoalToolValue(content: unknown): unknown {
  const texts =
    typeof content === 'string'
      ? [content]
      : Array.isArray(content)
        ? content
            .map(goalRow)
            .filter((row) => row.type === 'text' || row.type === 'input_text')
            .map((row) => row.text)
        : [];
  for (const candidate of texts) {
    if (typeof candidate !== 'string') continue;
    const text = candidate.replace(/^Wall time: [0-9.]+ seconds\nOutput:\n?/u, '').trimStart();
    if (!/^[{[]/u.test(text) || Buffer.byteLength(text) > 256 * 1024) continue;
    let depth = 0,
      quoted = false,
      escaped = false;
    for (let index = 0; index < text.length; index++) {
      const char = text[index];
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') quoted = false;
      } else if (char === '"') quoted = true;
      else if (char === '{' || char === '[') depth++;
      else if (char === '}' || char === ']') {
        if (--depth !== 0) continue;
        const value: unknown = JSON.parse(text.slice(0, index + 1));
        if (value && typeof value === 'object' && !Array.isArray(value)) {
          const row = goalRow(value);
          assert.notEqual(row.isError, true);
          assert.equal(row.error, undefined);
          return typeof row.phase === 'string' ? row : (row.result ?? row);
        }
        return value;
      }
    }
  }
  throw new Error('Original native goal tool result is missing or malformed');
}

function originalResult(provider: NativeGoalProvider, messages: Row[], id: string) {
  const results =
    provider === 'claude'
      ? messages.flatMap((message) =>
          Array.isArray(message.content)
            ? message.content
                .map(goalRow)
                .filter((block) => block.type === 'tool_result' && block.tool_use_id === id)
            : []
        )
      : messages.filter((message) =>
          provider === 'codex'
            ? message.type === 'function_call_output' && message.call_id === id
            : message.role === 'tool' && message.tool_call_id === id
        );
  assert.equal(results.length, 1, 'one result from the exact original native tool-use id');
  const result = results[0]!;
  assert.notEqual(result.is_error, true);
  assert.notEqual(result.isError, true);
  return provider === 'codex' ? result.output : result.content;
}

/** Finite happy/Stop inference script shared only by this six-row native qualification. */
export function nativeGoalScript(options: NativeGoalScenario) {
  const inputs = new Map<
    string,
    {
      sequence: number;
      step: number;
      stop: boolean;
      previous?: { id: string; name: string };
      taskId?: string;
      tasks?: Row[];
      created?: string[];
      final?: boolean;
    }
  >();
  const workerStages = new Map<string, number>();
  const held = new Map<string, { released: boolean; release(): void }>();
  const observations: {
    actor: NativeGoalActor;
    inputId: string;
    operationRef: string;
    goalId: string;
    step: number;
    tool?: string;
    rootInput: boolean;
    stop: boolean;
  }[] = [];
  return {
    observations,
    heldInputIds: () => [...held].filter(([, row]) => !row.released).map(([id]) => id),
    releaseHeld() {
      assert.ok(held.size > 0, 'only an original held inference may be released');
      for (const entry of held.values()) {
        assert.equal(entry.released, false, 'release the original response exactly once');
        entry.released = true;
        entry.release();
      }
    },
    respond(provider: NativeGoalProvider, body: Row): NativeGoalReply {
      const source = options.current();
      assert.equal(source.stopped, false, 'no model request may start after explicit Stop');
      const messages = (provider === 'codex' ? body.input : body.messages) as unknown[];
      assert.ok(Array.isArray(messages));
      const rows = messages.map(goalRow);
      const current = rows
        .toReversed()
        .find((row) => row.role === 'user' && mixedSemanticText(row.content));
      assert.ok(
        current && mixedNativeText(current.content).includes(source.content),
        'the CURRENT native user input must contain its exact original Runtime content'
      );
      let state = inputs.get(source.inputId);
      if (!state) {
        assert.ok(inputs.size < 16, 'bounded actual native inputs per actor');
        state = {
          sequence: inputs.size + 1,
          step: 0,
          stop: source.content.includes('TEST_NATIVE_GOAL_STOP'),
        };
        inputs.set(source.inputId, state);
      }
      assert.ok(
        !state.final && state.step < 14 && observations.length < 100,
        'finite original goal turn; no historical input replay'
      );
      const id = `TEST_goal_${options.actor}_${state.sequence}_${state.step}`;
      let result: unknown;
      if (state.previous) {
        const content = originalResult(provider, rows, state.previous.id);
        if (state.previous.name === 'shell') {
          assert.ok(
            mixedNativeText(content).includes('TEST_NATIVE_GOAL_FILE_OK'),
            'actual native file command must verify its effect'
          );
        } else {
          result = readNativeGoalToolValue(content);
          if (state.previous.name === 'goal_status') {
            const status = goalRow(result);
            assert.equal(status.goalId, source.goalId);
            assert.equal(status.disposition, 'active');
            assert.ok(typeof status.objective === 'string');
            state.stop = status.objective.includes('TEST_NATIVE_GOAL_STOP');
          } else if (state.previous.name === 'task_list') {
            assert.ok(Array.isArray(result));
            state.tasks = result
              .map(goalRow)
              .filter(
                (task) => typeof task.subject === 'string' && task.subject.includes(source.goalId)
              );
          } else if (state.previous.name === 'goal_propose') {
            assert.equal(goalRow(result).goalId, source.goalId);
            assert.equal(goalRow(result).disposition, 'finalizing');
          } else {
            const receipt = goalRow(result);
            assert.equal(
              receipt.phase,
              'completed',
              'only the real completed canonical mutation advances inference'
            );
            assert.equal(
              receipt.principalId,
              options.actor + '-session',
              'actual mutation preserves its authenticated actor'
            );
            if (state.previous.name === 'task_create') {
              const taskId = goalRow(receipt.effects).taskId;
              assert.ok(typeof taskId === 'string');
              (state.created ??= []).push(taskId);
            }
          }
        }
      }
      const tool = (name: string, input: Row = {}): NativeGoalReply => {
        state!.previous = { id, name };
        return {
          id,
          action:
            name === 'shell' && provider === 'codex'
              ? {
                  name: 'exec_command',
                  input: {
                    cmd: input.command,
                    workdir: options.workspace,
                    yield_time_ms: 1000,
                    max_output_tokens: 1000,
                  },
                }
              : {
                  name: name === 'shell' ? (provider === 'claude' ? 'Bash' : 'bash') : name,
                  input,
                },
        };
      };
      const finish = (hold = false): NativeGoalReply => {
        state!.final = true;
        if (!hold) return { id, text: 'TEST native goal step settled; Host owns any next input.' };
        assert.ok(!held.has(source.inputId));
        let release!: () => void;
        const wait = new Promise<void>((done) => {
          release = done;
        });
        held.set(source.inputId, { released: false, release });
        return {
          id,
          text: 'TEST original native input settled after explicit Stop.',
          release: wait,
        };
      };
      const commandId = (operation: string) =>
        `TEST-goal-${source.goalId}-${options.actor}-${operation}`;
      const shell = (
        final: boolean,
        actors: NativeGoalActor[] = [options.actor]
      ): NativeGoalReply => {
        const commands: string[] = [];
        if (actors.length > 1 || actors[0] !== options.actor) {
          for (const actor of actors)
            commands.push(
              `test "$(cat ${nativeGoalArtifact(actor, false, true)})" = 'TEST ${actor} verified result'`
            );
        } else {
          if (final)
            commands.push(
              `test "$(cat ${nativeGoalArtifact(options.actor, state!.stop, false)})" = 'TEST ${options.actor} first stage'`
            );
          const path = nativeGoalArtifact(options.actor, state!.stop, final);
          const text = nativeGoalBytes(options.actor, final).trimEnd();
          commands.push(`printf '%s\\n' '${text}' > ${path}`, `test "$(cat ${path})" = '${text}'`);
        }
        commands.push("printf 'TEST_NATIVE_GOAL_FILE_OK\\n'");
        return tool('shell', {
          command: commands.join(' && '),
          description: 'Verify only this original TEST goal artifact',
        });
      };
      let reply: NativeGoalReply;
      if (state.step === 0) reply = tool('goal_status');
      else if (options.mode === 'do') {
        assert.equal(options.actor, options.lead);
        if (state.step === 1) reply = shell(!source.rootInput);
        else if (source.rootInput) reply = finish(state.stop);
        else if (state.step === 2)
          reply = tool('goal_propose', {
            commandId: commandId('propose'),
            result: 'TEST verified native two-stage result',
            evidence: nativeGoalArtifact(options.actor, false, true),
          });
        else reply = finish();
      } else if (options.actor === options.lead && source.rootInput) {
        const workers = state.stop ? options.workers.slice(0, 1) : options.workers;
        const worker = workers[state.step - 1];
        if (worker)
          reply = tool('task_create', {
            commandId: commandId('create-' + worker),
            owner: worker,
            subject: 'TEST native goal ' + source.goalId + ' artifact for ' + worker,
            description: nativeGoalObjective(state.stop),
            ...(state.created?.length ? { blockedBy: [state.created.at(-1)] } : {}),
          });
        else reply = finish(state.stop);
      } else if (state.step === 1)
        reply = tool('task_list', options.actor === options.lead ? {} : { owner: options.actor });
      else if (options.actor === options.lead) {
        assert.ok(state.tasks && state.tasks.length === options.workers.length);
        if (state.tasks.some((task) => task.status !== 'completed')) reply = finish();
        else if (state.step === 2) reply = shell(true, options.workers);
        else if (state.step === 3)
          reply = tool('goal_propose', {
            commandId: commandId('propose'),
            result: 'TEST verified native delegated result',
            evidence: options.workers
              .map((actor) => nativeGoalArtifact(actor, false, true))
              .join(', '),
          });
        else reply = finish();
      } else {
        assert.ok(state.tasks?.length === 1, 'one canonical task for this original worker');
        const task = state.tasks[0]!;
        assert.equal(task.owner, options.actor, 'actual inventory retains the original task owner');
        const taskId = String(task.id);
        assert.ok(taskId && taskId !== 'undefined');
        const key = source.goalId + ':' + taskId;
        if (state.step === 2) {
          const stage = workerStages.get(key) ?? 0;
          assert.ok(stage < 2, 'exactly two productive native worker inputs');
          state.taskId = taskId;
          workerStages.set(key, stage + 1);
          reply =
            stage === 0
              ? tool('task_start', { commandId: commandId('start'), taskId })
              : shell(true);
        } else if (workerStages.get(key) === 1) {
          if (state.step === 3) reply = shell(false);
          else if (state.step === 4)
            reply = tool('task_add_comment', {
              commandId: commandId('progress'),
              taskId,
              text: 'TEST original native first-stage artifact verified; one second stage remains.',
            });
          else reply = finish(state.stop);
        } else if (state.step === 3)
          reply = tool('task_complete', { commandId: commandId('complete'), taskId });
        else reply = finish();
      }
      observations.push({
        actor: options.actor,
        inputId: source.inputId,
        operationRef: source.operationRef,
        goalId: source.goalId,
        step: state.step,
        rootInput: source.rootInput,
        stop: state.stop,
        ...(reply.action ? { tool: reply.action.name } : {}),
      });
      state.step++;
      return reply;
    },
  };
}

export type NativeGoalScript = ReturnType<typeof nativeGoalScript>;
