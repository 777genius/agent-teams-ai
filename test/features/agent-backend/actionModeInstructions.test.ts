// @vitest-environment node
import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  buildActionModeAgentBlock,
  buildActionModeProtocol,
  isAgentActionMode,
} from '../../../src/main/services/team/actionModeInstructions';

// Exact existing Desktop outputs captured before extracting its helper from HEAD.
const frozenHashes = {
  protocol: '16df937b24eb189f620d8478964e8752e626e01e83702da0b5764de7bdb82418',
  do: '68e3046525da572ead202081fc01dcfef53fdbb2337ea1417bf138235b3df99a',
  ask: '16a3071867cc04ccbc13dede9af221cecb5404c057039bc5566e45c976e4b9c6',
  delegate: '0c97bdac275a1c6789b189bcc3c7722c7d0d918bc2fac7a652157f16b04a30a8',
};
const hash = (text: string) => createHash('sha256').update(text).digest('hex');

describe('portable action mode helper extraction', () => {
  it('keeps existing lead protocol and each per-mode Desktop block byte-identical', () => {
    expect(hash(buildActionModeProtocol())).toBe(frozenHashes.protocol);
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
