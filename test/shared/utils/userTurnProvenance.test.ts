import {
  classifyUserTurnProvenance,
  isDisplayableTeammateProtocol,
  isHumanAuthoredUserTurn,
  isSyntheticReplayNoise,
} from '@shared/utils/userTurnProvenance';
import { describe, expect, it } from 'vitest';

describe('userTurnProvenance', () => {
  it('keeps replay-only user text human-authored', () => {
    const message = {
      type: 'user',
      isReplay: true,
      content: 'Human: I tested the feature looks good',
    };

    expect(classifyUserTurnProvenance(message)).toBe('human');
    expect(isHumanAuthoredUserTurn(message)).toBe(true);
  });

  it('treats an origin object without kind like absent origin', () => {
    const message = {
      type: 'user',
      origin: {},
      content: 'ordinary user text',
    };

    expect(classifyUserTurnProvenance(message)).toBe('human');
    expect(isHumanAuthoredUserTurn(message)).toBe(true);
  });

  it('uses structured provenance before legacy text shape', () => {
    const message = {
      type: 'user',
      protocolKind: 'teammate-message',
      content: 'Plain protocol payload',
    };

    expect(classifyUserTurnProvenance(message)).toBe('teammate-protocol');
    expect(isHumanAuthoredUserTurn(message)).toBe(false);
    expect(isDisplayableTeammateProtocol(message)).toBe(true);
  });

  it('keeps legacy teammate protocol detection as fallback', () => {
    const message = {
      type: 'user',
      content:
        'Human: <teammate-message teammate_id="alice">Looks good</teammate-message>',
    };

    expect(classifyUserTurnProvenance(message)).toBe('teammate-protocol');
    expect(isDisplayableTeammateProtocol(message)).toBe(true);
  });

  it('hides synthetic replay text without hiding synthetic tool results or command output', () => {
    expect(
      isSyntheticReplayNoise({
        type: 'user',
        isReplay: true,
        isSynthetic: true,
        content: 'Human: I tested the feature looks good',
      })
    ).toBe(true);

    expect(
      isSyntheticReplayNoise({
        type: 'user',
        isReplay: true,
        isSynthetic: true,
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tool-1',
            content: 'result',
          },
        ],
      })
    ).toBe(false);

    expect(
      isSyntheticReplayNoise({
        type: 'user',
        isReplay: true,
        isSynthetic: true,
        sourceToolUseID: 'tool-1',
        content: 'result',
      })
    ).toBe(false);

    expect(
      isSyntheticReplayNoise({
        type: 'user',
        isReplay: true,
        isSynthetic: true,
        content: '<local-command-stdout>Set model to sonnet</local-command-stdout>',
      })
    ).toBe(false);
  });

  it('does not display synthetic teammate protocol as real teammate output', () => {
    const message = {
      type: 'user',
      isReplay: true,
      isSynthetic: true,
      protocolKind: 'teammate-message',
      content:
        '<teammate-message teammate_id="alice">Looks good</teammate-message>',
    };

    expect(classifyUserTurnProvenance(message)).toBe('teammate-protocol');
    expect(isDisplayableTeammateProtocol(message)).toBe(false);
  });
});
