import { describe, expect, it } from 'vitest';

import {
  isOpenCodeDeliveryTurnActivityWarnEnabled,
  selectOpenCodeDeliveryTurnActivityLogLevel,
} from '../OpenCodeDeliveryTurnActivityLogGate';

function env(value?: string): NodeJS.ProcessEnv {
  return (
    value === undefined ? {} : { CLAUDE_TEAM_DELIVERY_TURN_ACTIVITY_WARN: value }
  ) as NodeJS.ProcessEnv;
}

describe('selectOpenCodeDeliveryTurnActivityLogLevel', () => {
  // Negative control: an informational trace must never be promoted on its own.
  // `warn` is a problem report developers are shown; this line is neither, and
  // the durable copy reaches the sink from `diagnostic` regardless.
  it('does not raise the level for informational diagnostics', () => {
    expect(selectOpenCodeDeliveryTurnActivityLogLevel(env())).toBe('diagnostic');
    for (const value of ['', ' ', '0', 'false', 'no', 'off', 'warn', 'maybe']) {
      expect(selectOpenCodeDeliveryTurnActivityLogLevel(env(value))).toBe('diagnostic');
      expect(isOpenCodeDeliveryTurnActivityWarnEnabled(env(value))).toBe(false);
    }
  });

  it('promotes the trace only on an explicit opt-in', () => {
    for (const value of ['1', 'true', 'yes', 'on', ' TRUE ', 'On']) {
      expect(isOpenCodeDeliveryTurnActivityWarnEnabled(env(value))).toBe(true);
      expect(selectOpenCodeDeliveryTurnActivityLogLevel(env(value))).toBe('warn');
    }
  });
});
