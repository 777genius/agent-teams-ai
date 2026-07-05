import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  applyAppManagedRuntimeSettingsPathEnv,
  assertAppDeterministicBootstrapEnabled,
} from '../TeamProvisioningEnvGuards';

const APP_FLAG = 'CLAUDE_APP_DISABLE_DETERMINISTIC_TEAM_BOOTSTRAP';
const RUNTIME_FLAG = 'CLAUDE_DISABLE_DETERMINISTIC_TEAM_BOOTSTRAP';
const TEST_SETTINGS_PATH = '/repo/.agent-teams/settings.json';

describe('TeamProvisioningEnvGuards', () => {
  let savedApp: string | undefined;
  let savedRuntime: string | undefined;

  beforeEach(() => {
    savedApp = process.env[APP_FLAG];
    savedRuntime = process.env[RUNTIME_FLAG];
    delete process.env[APP_FLAG];
    delete process.env[RUNTIME_FLAG];
  });

  afterEach(() => {
    if (savedApp === undefined) delete process.env[APP_FLAG];
    else process.env[APP_FLAG] = savedApp;
    if (savedRuntime === undefined) delete process.env[RUNTIME_FLAG];
    else process.env[RUNTIME_FLAG] = savedRuntime;
  });

  describe('assertAppDeterministicBootstrapEnabled', () => {
    it('does not throw when neither flag is set', () => {
      expect(() => assertAppDeterministicBootstrapEnabled()).not.toThrow();
    });

    it('throws for the app rollout flag', () => {
      process.env[APP_FLAG] = '1';
      expect(() => assertAppDeterministicBootstrapEnabled()).toThrow(/app rollout flag/);
    });

    it('throws for the runtime kill switch', () => {
      process.env[RUNTIME_FLAG] = '1';
      expect(() => assertAppDeterministicBootstrapEnabled()).toThrow(/runtime kill switch/);
    });

    it('ignores non-"1" values', () => {
      process.env[APP_FLAG] = 'true';
      expect(() => assertAppDeterministicBootstrapEnabled()).not.toThrow();
    });
  });

  describe('applyAppManagedRuntimeSettingsPathEnv', () => {
    it('sets the settings path when provided', () => {
      const env: NodeJS.ProcessEnv = {};
      applyAppManagedRuntimeSettingsPathEnv(env, TEST_SETTINGS_PATH);
      expect(env.CLAUDE_TEAM_RUNTIME_SETTINGS_PATH).toBe(TEST_SETTINGS_PATH);
    });

    it('clears the settings path when null', () => {
      const env: NodeJS.ProcessEnv = { CLAUDE_TEAM_RUNTIME_SETTINGS_PATH: '/old' };
      applyAppManagedRuntimeSettingsPathEnv(env, null);
      expect(env.CLAUDE_TEAM_RUNTIME_SETTINGS_PATH).toBeUndefined();
    });
  });
});
