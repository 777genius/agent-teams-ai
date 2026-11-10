import { readFile } from 'node:fs/promises';
import { compileFunction, runInNewContext } from 'node:vm';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { nativeCommandMatch } from '../../scripts/e2e/opencode-native-team-port';
import { projectV2NativeTranscript } from '../../scripts/e2e/opencode-native-v2-transcript';
import { windowsVerificationCommand } from '../../scripts/e2e/opencode-native-real-task-prompts';
import { serializedFunction } from '../../scripts/e2e/release-updater/serialized-function.mts';

const executable = 'D:/TEST-node/node.exe';
const program = 'C:/TEST-project/alice-verify.cjs';
const marker = 'COMMAND_EXEC:TEST-nonce';
const model = 'openrouter/TEST/model';
const session = 'ses_TEST';
const execution = (command: string, patch: Record<string, unknown> = {}) => ({
  toolCall: { id: 'TEST-call', name: 'shell', input: { command } },
  result: { toolUseId: 'TEST-call', isError: false, content: `${marker}\n` },
  ...patch,
});
const match = (command: string, patch: Record<string, unknown> = {}) =>
  nativeCommandMatch(execution(command, patch) as never, program, marker, executable);

const accepted = [
  windowsVerificationCommand(executable, program),
  'D:\\TEST-node\\node.exe C:\\TEST-project\\alice-verify.cjs',
  `"${executable}" "${program}"`,
  `'${executable}' '${program}'`,
  `& "${executable}" '${program}'`,
  `\t ${executable}\t"${program}" \t`,
];
const rejected = [
  `echo node ${program}; echo ${marker}`,
  `echo ${executable} ${program}`,
  `cmd /c ${executable} ${program}`,
  `pwsh -Command "${executable} ${program}"`,
  `node ${program}`,
  `${executable} ./alice-verify.cjs`,
  `${executable} ${program}; echo ${marker}`,
  `${executable} ${program} && echo ${marker}`,
  `${executable} ${program} | echo ${marker}`,
  `${executable} ${program} > output.txt`,
  `${executable} ${program} --extra`,
  `${executable} ${program}\necho ${marker}`,
  `${executable} "${program}; echo ${marker}"`,
  `${executable} '$(echo ${program})'`,
  `d:/TEST-node/node.exe ${program}`,
  `${executable} c:/TEST-project/alice-verify.cjs`,
  `D:/FOREIGN/node.exe ${program}`,
  `${executable} C:/FOREIGN/alice-verify.cjs`,
  `${executable}.bak ${program}`,
  `${executable} ${program}.bak`,
  `${executable} ${program}/extra`,
  `D:/TEST-node/../TEST-node/node.exe ${program}`,
  `"${executable} ${program}`,
];

describe('strict native verification command qualification', () => {
  it.each(accepted)('accepts only the exact staged executable and verifier: %s', (command) => {
    expect(match(command)).toMatchObject({ nativeExact: true, nativeMatches: true, succeeded: true,
      commandShape: { allowedForm: true, expectedNodeExact: true, programExact: true },
      resultPaired: true, resultSucceeded: true, markerMatches: true });
    expect(JSON.stringify(match(command))).not.toMatch(/TEST-node|TEST-project|COMMAND_EXEC/);
  });

  it.each(rejected)('rejects a wrapper, fragment, alias or changed literal: %s', (command) => {
    expect(match(command)).toMatchObject({ nativeExact: false, nativeMatches: false, succeeded: false });
  });

  it('requires this exact native call own successful paired marker result', () => {
    const command = accepted[0]!;
    for (const result of [undefined,
      { toolUseId: 'FOREIGN-call', isError: false, content: marker },
      { toolUseId: 'TEST-call', isError: true, content: marker },
      { toolUseId: 'TEST-call', isError: false, content: `echo ${marker}` }])
      expect(match(command, { result }).succeeded).toBe(false);
    expect(match(command, { toolCall: { id: 'TEST-call', name: 'execute', input: { command } } }).succeeded).toBe(false);
  });

  it('refuses a missing, bare or different expected executable identity', () => {
    for (const expected of [undefined, '', 'node', 'node.exe', 'D:/FOREIGN/node.exe']) {
      const observed = nativeCommandMatch(execution(accepted[0]!) as never, program, marker, expected as string);
      expect(observed.nativeExact).toBe(false);
      expect(observed.succeeded).toBe(false);
    }
  });

  it('never pairs absent or empty native call/result identities', () => {
    for (const [id, toolUseId] of [[undefined, undefined], ['', ''], ['TEST-call', undefined],
      ['TEST-call', ''], [undefined, 'TEST-call']]) {
      expect(match(accepted[0]!, {
        toolCall: { id, name: 'shell', input: { command: accepted[0] } },
        result: { toolUseId, isError: false, content: marker },
      })).toMatchObject({ resultPaired: false, succeeded: false });
    }
  });

  it.each([...accepted, ...rejected])('keeps serialized CDP and bounded transcript predicates consistent: %s', (command) => {
    const actual = match(command);
    const serialized = runInNewContext(`(${serializedFunction(nativeCommandMatch)})`) as typeof nativeCommandMatch;
    expect(serialized(execution(command) as never, program, marker, executable)).toEqual(actual);
    const packet = projectV2NativeTranscript({ sessionId: session, durableState: 'idle', messages: [
      { id: 'msg_INPUT', role: 'user', toolCalls: [] },
      { id: 'msg_REPLY', role: 'assistant', providerId: 'openrouter', modelId: 'TEST/model', toolCalls: [
        { callId: 'TEST-call', toolName: 'shell', input: { command }, status: 'completed', isError: false, outputText: marker },
      ] },
    ] }, { sessionId: session, selectedModel: model, runtimePromptMessageId: 'msg_INPUT',
      command: { executable, program, marker } });
    expect(packet.commandObservation?.tuples[0]?.input).toEqual({ shell: actual.shell,
      programMatches: actual.programMatches, nodeMatches: actual.nodeMatches, commandShape: actual.commandShape });
  });

  it('the actual full gate rejects unpaired CodeMode calls and unrelated outer success', async () => {
    const source = await readFile('scripts/e2e/opencode-native-windows-full.ts', 'utf8');
    const ast = ts.createSourceFile('full.ts', source, ts.ScriptTarget.Latest, true);
    const declaration = ast.statements.filter(ts.isFunctionDeclaration).find(node => node.name?.text === 'commandEvidence')!;
    const compiled = ts.transpileModule(declaration.getText(ast), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    }).outputText;
    const observed: unknown[] = [];
    const run = compileFunction(`${compiled};return commandEvidence;`,
      ['nativeCommandMatch', 'waitFor', 'assert', 'readStopObservation', 'commandEvidenceLivenessRows'])(
      nativeCommandMatch, async (read: () => Promise<unknown>) => {
        const result = await read();
        if (result === null) throw new Error('TEST-no-strict-command-evidence');
        return result;
      }, (await import('node:assert/strict')).default,
      async () => ({ observation: { processAlive: false } }), observed
    );
    const app = (executions: unknown[]) => ({ call: async () => ({ segments: [{
      actor: { memberName: 'alice', sessionId: session }, chunks: [{ chunkType: 'ai',
        responses: [{ type: 'assistant', model }], toolExecutions: executions }],
    }] }) });
    const exact = execution(accepted[0]!);
    const unpaired = execution(accepted[0]!, { result: undefined });
    const outer = execution(`echo ${marker}`, {
      toolCall: { id: 'TEST-outer', name: 'execute', input: { code: 'PRIVATE_CODE' } },
      result: { toolUseId: 'TEST-outer', isError: false, content: marker },
    });
    await expect(run(app([unpaired, outer]), 'TEST-task', 'alice', session, program, marker, executable, model))
      .rejects.toThrow('TEST-no-strict-command-evidence');
    await expect(run(app([execution(rejected[0]!)]), 'TEST-task', 'alice', session, program, marker, executable, model))
      .rejects.toThrow('TEST-no-strict-command-evidence');
    const proof = await run(app([exact]), 'TEST-task', 'alice', session, program, marker, executable, model);
    expect(proof).toEqual({ kind: 'paired-native-shell-result', actorMatches: true, sessionMatches: true,
      modelMatches: true, nativeExact: true, allowedForm: true, expectedNodeExact: true, programExact: true,
      resultPaired: true, resultSucceeded: true, markerMatches: true });
    expect(JSON.stringify(proof)).not.toMatch(/TEST-node|TEST-project|PRIVATE_CODE|COMMAND_EXEC/);
  });
});
