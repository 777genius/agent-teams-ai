// @vitest-environment node
import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  buildActionModeAgentBlock,
  buildActionModeProtocol,
  isAgentActionMode,
} from '../../../src/main/services/team/actionModeInstructions';

// Exact Desktop outputs with the accepted fresh-main bounded ASK communication acknowledgement.
const frozenHashes = {
  protocol: '59f7bce2540f4f3fe5ff961d1c4611896a332a6d8a14374c047f1d21d8b6f2bd',
  do: '68e3046525da572ead202081fc01dcfef53fdbb2337ea1417bf138235b3df99a',
  ask: '16a3071867cc04ccbc13dede9af221cecb5404c057039bc5566e45c976e4b9c6',
  delegate: '0c97bdac275a1c6789b189bcc3c7722c7d0d918bc2fac7a652157f16b04a30a8',
};
const hash = (text: string) => createHash('sha256').update(text).digest('hex');

describe('portable action mode helper extraction', () => {
  it('keeps existing lead protocol and each per-mode Desktop block byte-identical', () => {
    expect(hash(buildActionModeProtocol())).toBe(frozenHashes.protocol);
    expect(buildActionModeProtocol()).toContain(
      'The optional group_chat_react communication acknowledgement is allowed; it does not grant file, task, or process writes.'
    );
    for (const mode of ['do', 'ask', 'delegate'] as const)
      expect(hash(buildActionModeAgentBlock(mode))).toBe(frozenHashes[mode]);
    expect(buildActionModeAgentBlock(undefined)).toBe('');
  });
  it('keeps existing public mode validation semantics', () => {
    for (const mode of ['do', 'ask', 'delegate']) expect(isAgentActionMode(mode)).toBe(true);
    for (const value of [undefined, null, '', 'execute', 'ASK'])
      expect(isAgentActionMode(value)).toBe(false);
  });
});
