import { describe, expect, it } from 'vitest';

import {
  isActiveProvisioningState,
  isTerminalProvisioningState,
  shouldIgnoreProvisioningProgressRegression,
} from '../../../src/renderer/store/team/teamProvisioningStateRules';

import type { TeamProvisioningProgress } from '../../../src/shared/types';

type ProgressState = TeamProvisioningProgress['state'];

const activeStates: ProgressState[] = [
  'validating',
  'spawning',
  'configuring',
  'assembling',
  'finalizing',
  'verifying',
];

const terminalStates: ProgressState[] = ['ready', 'failed', 'disconnected', 'cancelled'];

describe('teamProvisioningStateRules', () => {
  it('classifies active provisioning states', () => {
    for (const state of activeStates) {
      expect(isActiveProvisioningState(state), state).toBe(true);
      expect(isTerminalProvisioningState(state), state).toBe(false);
    }
  });

  it('classifies terminal provisioning states', () => {
    for (const state of terminalStates) {
      expect(isTerminalProvisioningState(state), state).toBe(true);
      expect(isActiveProvisioningState(state), state).toBe(false);
    }
  });

  it('allows active state progressions and regressions to be processed', () => {
    expect(shouldIgnoreProvisioningProgressRegression('spawning', 'validating')).toBe(false);
    expect(shouldIgnoreProvisioningProgressRegression('validating', 'spawning')).toBe(false);
    expect(shouldIgnoreProvisioningProgressRegression('verifying', 'ready')).toBe(false);
  });

  it('prevents ready from regressing except to disconnected', () => {
    expect(shouldIgnoreProvisioningProgressRegression('ready', 'validating')).toBe(true);
    expect(shouldIgnoreProvisioningProgressRegression('ready', 'failed')).toBe(true);
    expect(shouldIgnoreProvisioningProgressRegression('ready', 'cancelled')).toBe(true);
    expect(shouldIgnoreProvisioningProgressRegression('ready', 'ready')).toBe(false);
    expect(shouldIgnoreProvisioningProgressRegression('ready', 'disconnected')).toBe(false);
  });

  it('locks failed, cancelled, and disconnected to their current terminal state', () => {
    expect(shouldIgnoreProvisioningProgressRegression('failed', 'failed')).toBe(false);
    expect(shouldIgnoreProvisioningProgressRegression('failed', 'ready')).toBe(true);
    expect(shouldIgnoreProvisioningProgressRegression('cancelled', 'cancelled')).toBe(false);
    expect(shouldIgnoreProvisioningProgressRegression('cancelled', 'spawning')).toBe(true);
    expect(shouldIgnoreProvisioningProgressRegression('disconnected', 'disconnected')).toBe(false);
    expect(shouldIgnoreProvisioningProgressRegression('disconnected', 'ready')).toBe(true);
  });
});
