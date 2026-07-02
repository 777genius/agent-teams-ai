import { describe, expect, it } from 'vitest';

import {
  isTerminalFailureProvisioningState,
  looksLikeClaudeStdoutJsonFragment,
  shouldIgnoreProvisioningProgressRegression,
} from '../TeamProvisioningProgressState';

describe('TeamProvisioningProgressState', () => {
  describe('looksLikeClaudeStdoutJsonFragment', () => {
    it('recognizes stream-json object/array fragments by shape key', () => {
      expect(looksLikeClaudeStdoutJsonFragment('{"type":"assistant"}')).toBe(true);
      expect(looksLikeClaudeStdoutJsonFragment('  {"session_id":"s"} ')).toBe(true);
      expect(looksLikeClaudeStdoutJsonFragment('[{"message":{}}]')).toBe(true);
    });

    it('rejects non-json and json without known shape keys', () => {
      expect(looksLikeClaudeStdoutJsonFragment('hello world')).toBe(false);
      expect(looksLikeClaudeStdoutJsonFragment('{"other":1}')).toBe(false);
      expect(looksLikeClaudeStdoutJsonFragment('type: x')).toBe(false);
    });
  });

  describe('isTerminalFailureProvisioningState', () => {
    it('is true only for failed/cancelled/disconnected', () => {
      expect(isTerminalFailureProvisioningState('failed')).toBe(true);
      expect(isTerminalFailureProvisioningState('cancelled')).toBe(true);
      expect(isTerminalFailureProvisioningState('disconnected')).toBe(true);
      expect(isTerminalFailureProvisioningState('ready')).toBe(false);
      expect(isTerminalFailureProvisioningState('spawning')).toBe(false);
    });
  });

  describe('shouldIgnoreProvisioningProgressRegression', () => {
    it('lets a ready run stay ready or disconnect, but ignores other transitions', () => {
      expect(shouldIgnoreProvisioningProgressRegression('ready', 'ready')).toBe(false);
      expect(shouldIgnoreProvisioningProgressRegression('ready', 'disconnected')).toBe(false);
      expect(shouldIgnoreProvisioningProgressRegression('ready', 'spawning')).toBe(true);
      expect(shouldIgnoreProvisioningProgressRegression('ready', 'failed')).toBe(true);
    });

    it('pins a terminal-failure run and ignores flips to a different state', () => {
      expect(shouldIgnoreProvisioningProgressRegression('failed', 'failed')).toBe(false);
      expect(shouldIgnoreProvisioningProgressRegression('failed', 'ready')).toBe(true);
      expect(shouldIgnoreProvisioningProgressRegression('cancelled', 'spawning')).toBe(true);
    });

    it('allows normal forward progress from non-settled states', () => {
      expect(shouldIgnoreProvisioningProgressRegression('spawning', 'configuring')).toBe(false);
      expect(shouldIgnoreProvisioningProgressRegression('verifying', 'ready')).toBe(false);
    });
  });
});
