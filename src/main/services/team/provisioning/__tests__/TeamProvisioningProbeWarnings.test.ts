import { describe, expect, it } from 'vitest';

import { isBinaryProbeWarning, isTransientProbeWarning } from '../TeamProvisioningProbeWarnings';

describe('TeamProvisioningProbeWarnings', () => {
  describe('isTransientProbeWarning', () => {
    it('matches transient timeout/network markers case-insensitively', () => {
      expect(isTransientProbeWarning('Timeout running: claude status')).toBe(true);
      expect(isTransientProbeWarning('probe did not complete')).toBe(true);
      expect(isTransientProbeWarning('runtime status was unavailable')).toBe(true);
      expect(isTransientProbeWarning('runtime status check did not complete')).toBe(true);
      expect(isTransientProbeWarning('operation TIMED OUT')).toBe(true);
      expect(isTransientProbeWarning('connect ETIMEDOUT 1.2.3.4')).toBe(true);
      expect(isTransientProbeWarning('read ECONNRESET')).toBe(true);
      expect(isTransientProbeWarning('getaddrinfo EAI_AGAIN host')).toBe(true);
    });

    it('does not match unrelated or hard-failure warnings', () => {
      expect(isTransientProbeWarning('spawn claude ENOENT')).toBe(false);
      expect(isTransientProbeWarning('some other warning')).toBe(false);
      expect(isTransientProbeWarning('')).toBe(false);
    });
  });

  describe('isBinaryProbeWarning', () => {
    it('matches hard binary/launch failures case-insensitively', () => {
      expect(isBinaryProbeWarning('spawn /usr/bin/claude ENOENT')).toBe(true);
      expect(isBinaryProbeWarning('EACCES: permission denied')).toBe(true);
      expect(isBinaryProbeWarning('ENOEXEC')).toBe(true);
      expect(isBinaryProbeWarning('bad CPU type in executable')).toBe(true);
      expect(isBinaryProbeWarning('dyld: image not found')).toBe(true);
    });

    it('requires both spawn and enoent together for the spawn case', () => {
      expect(isBinaryProbeWarning('spawn started fine')).toBe(false);
      expect(isBinaryProbeWarning('ENOENT without spawn keyword')).toBe(false);
    });

    it('does not match transient/unrelated warnings', () => {
      expect(isBinaryProbeWarning('operation timed out')).toBe(false);
      expect(isBinaryProbeWarning('')).toBe(false);
    });
  });
});
