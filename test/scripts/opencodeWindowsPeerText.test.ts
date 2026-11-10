import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

import { stripAgentBlocks, unwrapAgentBlock, wrapAgentBlock } from '@shared/constants/agentBlocks';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

type PeerRow = { from: string; to?: string; text: string };
async function projector() {
  const source = await readFile('scripts/e2e/opencode-native-windows-full.ts', 'utf8');
  const start = source.indexOf('export function projectWindowsPeerTextRows(');
  const end = source.indexOf('\ntype PeerObservation =', start);
  assert(start >= 0 && end > start);
  const actual = ts.transpileModule(source.slice(start, end).replace('export ', ''), {
    compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
  }).outputText;
  // Execute the actual pure projection without importing the executable E2E entrypoint.
  return vm.runInNewContext(`${actual};projectWindowsPeerTextRows`, { stripAgentBlocks, unwrapAgentBlock }) as
    (rows: PeerRow[], nonce: { alice: string; bob: string }) => { from: string; to: string; rowCount: number;
      rowsExhaustive: boolean; rows: Record<string, number | boolean>[] }[];
}
const nonce = { alice: 'TEST_PRIVATE_ALICE', bob: 'TEST_PRIVATE_BOB' };
describe('bounded Windows peer text observations', () => {
  it('distinguishes exact, padded, prose, wrong-nonce, and agent-block text without retaining bodies', async () => {
    const project = await projector();
    const challenge = `CHALLENGE:${nonce.alice}`;
    const facts = project([
      { from: 'alice', to: 'bob', text: challenge },
      { from: 'alice', to: 'bob', text: `  ${challenge}\n` },
      { from: 'alice', to: 'bob', text: `SECRET provider-body ${challenge}` },
      { from: 'alice', to: 'bob', text: `CHALLENGE:${nonce.bob}` },
      { from: 'alice', to: 'bob', text: wrapAgentBlock(challenge) },
      { from: 'alice', to: 'bob', text: `${challenge}\n${wrapAgentBlock('SECRET metadata')}` },
      { from: 'bob', to: 'alice', text: `ACK:${nonce.alice}` },
    ], nonce);
    expect(facts[0]!.rows[0]).toMatchObject({ exactChallenge: true, containsOwnNonce: true, containsPeerNonce: false });
    expect(facts[0]!.rows[1]).toMatchObject({ exactChallenge: false, trimmedExactChallenge: true });
    expect(facts[0]!.rows[2]).toMatchObject({ exactChallenge: false, containsExpectedChallenge: true, trimmedExactChallenge: false });
    expect(facts[0]!.rows[3]).toMatchObject({ containsExpectedChallenge: false, containsOwnNonce: false, containsPeerNonce: true });
    expect(facts[0]!.rows[4]).toMatchObject({ exactChallenge: false, unwrappedExactChallenge: true, visibleExactChallenge: false });
    expect(facts[0]!.rows[5]).toMatchObject({ exactChallenge: false, visibleExactChallenge: true });
    expect(facts[1]!.rows[0]).toMatchObject({ exactAck: true, containsExpectedAck: true, containsPeerNonce: true });
    expect(JSON.stringify(facts)).not.toMatch(/SECRET|TEST_PRIVATE|provider-body|metadata/);
  });
  it('reports absent markers and bounds both row count and inspected text', async () => {
    const project = await projector();
    const rows = Array.from({ length: 33 }, () => ({ from: 'alice', to: 'bob', text: 'x'.repeat(32_769) + nonce.alice }));
    const facts = project(rows, nonce);
    expect(facts[0]).toMatchObject({ rowCount: 33, rowsExhaustive: false });
    expect(facts[0]!.rows).toHaveLength(32);
    expect(facts[0]!.rows[0]).toMatchObject({ inspectedCharacters: 32_768, textExhaustive: false,
      containsChallengeMarker: false, containsAckMarker: false, containsOwnNonce: false, exactChallenge: false });
    expect(facts[1]).toMatchObject({ rowCount: 0, rowsExhaustive: true, rows: [] });
  });
});
