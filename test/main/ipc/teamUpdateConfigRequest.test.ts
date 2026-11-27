import { describe, expect, it } from 'vitest';

import {
  LEAD_PROMPT_TOO_LONG_MESSAGE,
  parseUpdateConfigRequest,
} from '../../../src/main/ipc/teams/teamUpdateConfigRequest';
import { MAX_TEAM_DEFINITION_TEXT_LENGTH } from '../../../src/shared/constants/teamLimits';

describe('parseUpdateConfigRequest', () => {
  it('passes the known fields through and ignores unknown ones', () => {
    expect(
      parseUpdateConfigRequest({
        name: 'Builders',
        description: 'Text',
        color: 'green',
        prompt: 'Be brief',
        language: 'ru',
        injected: 'x',
      })
    ).toEqual({
      ok: true,
      value: { name: 'Builders', description: 'Text', color: 'green', prompt: 'Be brief' },
    });
  });

  it('keeps absent fields absent so they are not written', () => {
    const parsed = parseUpdateConfigRequest({ prompt: 'Only this' });
    expect(parsed).toEqual({
      ok: true,
      value: { name: undefined, description: undefined, color: undefined, prompt: 'Only this' },
    });
  });

  it('allows an empty prompt: it clears the saved one', () => {
    expect(parseUpdateConfigRequest({ prompt: '' })).toMatchObject({
      ok: true,
      value: { prompt: '' },
    });
  });

  it.each([
    [null, 'Invalid updates object'],
    ['text', 'Invalid updates object'],
    [{ name: 1 }, 'name must be a string'],
    [{ description: {} }, 'description must be a string'],
    [{ color: [] }, 'color must be a string'],
    [{ prompt: 5 }, 'prompt must be a string'],
    [{ prompt: 'x'.repeat(MAX_TEAM_DEFINITION_TEXT_LENGTH + 1) }, LEAD_PROMPT_TOO_LONG_MESSAGE],
  ])('rejects %j', (input, error) => {
    expect(parseUpdateConfigRequest(input)).toEqual({ ok: false, error });
  });
});
