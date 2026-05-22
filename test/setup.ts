/**
 * Vitest setup file.
 * Runs before each test file.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, afterEach, beforeEach, expect, vi } from 'vitest';

const TEST_HOME_PREFIX = 'agent-teams-vitest-home-';
const DEFAULT_STALE_TEST_HOME_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function getStaleTestHomeMaxAgeMs(): number {
  const value = Number(process.env.AGENT_TEAMS_VITEST_STALE_HOME_MAX_AGE_MS);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_STALE_TEST_HOME_MAX_AGE_MS;
}

function cleanupStaleTestHomeDirs(): void {
  const cutoff = Date.now() - getStaleTestHomeMaxAgeMs();

  for (const entry of fs.readdirSync(os.tmpdir(), { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith(TEST_HOME_PREFIX)) {
      continue;
    }

    const dir = path.join(os.tmpdir(), entry.name);
    try {
      const stat = fs.statSync(dir);
      if (stat.mtimeMs < cutoff) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    } catch {
      // Best effort cleanup only.
    }
  }
}

if (process.env.AGENT_TEAMS_VITEST_TEMP_CLEANUP_DONE !== '1') {
  process.env.AGENT_TEAMS_VITEST_TEMP_CLEANUP_DONE = '1';
  cleanupStaleTestHomeDirs();
}

// Mock Sentry Electron SDK - it requires the real `electron` package at import
// time which is unavailable in the vitest/happy-dom environment.
const sentryNoOp = {
  init: vi.fn(),
  addBreadcrumb: vi.fn(),
  captureException: vi.fn(),
  setUser: vi.fn(),
  setTags: vi.fn(),
  close: vi.fn(() => Promise.resolve(true)),
  startSpan: vi.fn((_opts: unknown, fn: () => unknown) => fn()),
  withScope: vi.fn((fn: (scope: unknown) => void) => fn({ setContext: vi.fn() })),
  browserTracingIntegration: vi.fn(() => ({
    name: 'BrowserTracing',
    setup: vi.fn(),
    afterAllSetup: vi.fn(),
  })),
};
vi.mock('@sentry/electron/main', () => sentryNoOp);
vi.mock('@sentry/electron/renderer', () => sentryNoOp);
vi.mock('@sentry/react', () => sentryNoOp);

// Mock HOME for tests that need a predictable home path. It must be writable:
// some services persist state in best-effort background writes after a test has
// already reset path overrides.
const testHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), TEST_HOME_PREFIX));
vi.stubEnv('HOME', testHomeDir);
let testHomeDirRemoved = false;
function removeTestHomeDir(): void {
  if (testHomeDirRemoved) {
    return;
  }
  testHomeDirRemoved = true;
  try {
    fs.rmSync(testHomeDir, { recursive: true, force: true });
  } catch {
    // Best effort cleanup only.
  }
}
afterAll(removeTestHomeDir);
process.once('exit', removeTestHomeDir);

let errorSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;

function formatConsoleCall(args: unknown[]): string {
  return args
    .map((arg) => {
      if (arg instanceof Error) {
        return arg.message;
      }
      return String(arg);
    })
    .join(' ');
}

beforeEach(() => {
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  const unexpectedErrors = errorSpy.mock.calls.map(formatConsoleCall);
  const unexpectedWarnings = warnSpy.mock.calls.map(formatConsoleCall);

  errorSpy.mockRestore();
  warnSpy.mockRestore();

  expect(
    unexpectedErrors,
    `Unexpected console.error calls:\n${unexpectedErrors.join('\n')}`
  ).toEqual([]);
  expect(
    unexpectedWarnings,
    `Unexpected console.warn calls:\n${unexpectedWarnings.join('\n')}`
  ).toEqual([]);
});
