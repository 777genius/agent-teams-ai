import { afterEach, describe, expect, it } from 'vitest';

import { getDeterministicBootstrapTimeoutMs } from '../TeamProvisioningBootstrapSpec';

describe('getDeterministicBootstrapTimeoutMs', () => {
  const previous = process.env.CLAUDE_TEAM_DETERMINISTIC_BOOTSTRAP_TIMEOUT_MS;

  afterEach(() => {
    if (previous === undefined) {
      delete process.env.CLAUDE_TEAM_DETERMINISTIC_BOOTSTRAP_TIMEOUT_MS;
    } else {
      process.env.CLAUDE_TEAM_DETERMINISTIC_BOOTSTRAP_TIMEOUT_MS = previous;
    }
  });

  it('uses the per-member budget when no override is set', () => {
    delete process.env.CLAUDE_TEAM_DETERMINISTIC_BOOTSTRAP_TIMEOUT_MS;
    expect(getDeterministicBootstrapTimeoutMs(1)).toBe(120_000);
  });

  it('honors a positive env override up to the max budget', () => {
    process.env.CLAUDE_TEAM_DETERMINISTIC_BOOTSTRAP_TIMEOUT_MS = '240000';
    expect(getDeterministicBootstrapTimeoutMs(1)).toBe(240_000);
  });
});
