import {
  validateMemberName,
  validateTeammateName,
  validateTeamName,
} from '@main/services/team/TeamIdentifierValidation';
import { describe, expect, it } from 'vitest';

describe('team identifier validation', () => {
  it('validates transport-neutral team and member identifiers', () => {
    expect(validateTeamName(' demo-team ').value).toBe('demo-team');
    expect(validateMemberName('alice_1').valid).toBe(true);
    expect(validateTeammateName('alice_1').valid).toBe(true);
  });

  it('rejects invalid filesystem-backed or reserved identifiers', () => {
    expect(validateTeamName('../escape')).toMatchObject({
      valid: false,
      error: 'teamName contains invalid characters',
    });
    expect(validateTeamName('con')).toMatchObject({
      valid: false,
      error: 'teamName is reserved on Windows',
    });
    expect(validateMemberName('user')).toMatchObject({
      valid: false,
      error: 'member name "user" is reserved',
    });
    expect(validateTeammateName('team-lead')).toMatchObject({
      valid: false,
      error: 'member name "team-lead" is reserved',
    });
  });
});
