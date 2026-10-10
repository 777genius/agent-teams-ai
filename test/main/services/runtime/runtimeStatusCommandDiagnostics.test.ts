import {
  createRuntimeStatusErrorProviderStatus,
  getProviderStatusCheckErrorCode,
} from '@main/services/runtime/providerStatusCheckContract';
import {
  extractRuntimeStatusJsonObject,
  readRuntimeStatusCommand,
} from '@main/services/runtime/runtimeStatusCommandDiagnostics';
import { WorkingDirectoryMissingError } from '@main/utils/cliWorkingDirectory';
import { execCliWithOpenCodeRecovery } from '@main/utils/openCodeNodeModulesJunction';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@main/utils/openCodeNodeModulesJunction', () => ({
  execCliWithOpenCodeRecovery: vi.fn(),
}));

const binaryPath = '/Applications/Agent Teams AI.app/Contents/Resources/runtime/claude-multimodel';
const args = ['runtime', 'status', '--json', '--provider', 'opencode'];
const cwd = '/tmp/TEST-проект с пробелами';
const execMock = vi.mocked(execCliWithOpenCodeRecovery);

async function failureStatus() {
  const error = await readRuntimeStatusCommand(
    binaryPath,
    args,
    { cwd },
    extractRuntimeStatusJsonObject
  ).catch((error: unknown) => error);
  return createRuntimeStatusErrorProviderStatus('opencode', error);
}

beforeEach(() => vi.resetAllMocks());

describe('runtime status command diagnostics', () => {
  it('retains stderr-only failures, exit code, signal and exact executable/project scope', async () => {
    execMock.mockRejectedValue(
      Object.assign(new Error('Command failed'), {
        code: 7,
        signal: 'SIGTERM',
        stderr: 'error: An unknown error occurred (Unexpected)\nOpenCode loader stopped',
        stdout: '',
      })
    );

    const status = await failureStatus();

    expect(status).toMatchObject({
      authenticated: false,
      verificationState: 'error',
      statusCheckOutcome: 'transient_error',
      statusCheckErrorCode: 'unavailable',
      capabilities: { teamLaunch: false },
    });
    expect(status.detailMessage).toContain('Runtime status command failed');
    expect(status.detailMessage).toContain(`Executable: ${binaryPath}`);
    expect(status.detailMessage).toContain('Arguments: runtime status --json --provider opencode');
    expect(status.detailMessage).toContain(`Working directory: ${cwd}`);
    expect(status.detailMessage).toContain('Exit code: 7');
    expect(status.detailMessage).toContain('Signal: SIGTERM');
    expect(status.detailMessage).toContain('stderr: error: An unknown error occurred (Unexpected)');
    expect(status.detailMessage).toContain('(Unexpected)\nOpenCode loader stopped');
    expect(status.detailMessage).not.toContain('auth invalid');
    expect(status.detailMessage).not.toContain('OpenCode missing');
  });

  it.each(['plain output without JSON', '{"providers": malformed}'])(
    'retains both output streams and scope when parsing %s fails',
    async (stdout) => {
      execMock.mockResolvedValue({ stdout, stderr: 'runtime loader warning' });

      const status = await failureStatus();

      expect(status.detailMessage).toContain(`stdout: ${stdout}`);
      expect(status.detailMessage).toContain('stderr: runtime loader warning');
      expect(status.detailMessage).toContain(binaryPath);
      expect(status.detailMessage).toContain(cwd);
      expect(status.statusCheckOutcome).toBe('transient_error');
      expect(status.capabilities.teamLaunch).toBe(false);
    }
  );

  it('keeps timeout classification, recovery copy and safe failure evidence', async () => {
    execMock.mockRejectedValue(
      Object.assign(new Error('Command timed out after 30000ms'), {
        code: 'ETIMEDOUT',
        signal: 'SIGTERM',
        stderr: 'runtime missing\nAuthorization: Bearer timeout-secret',
      })
    );
    const status = await failureStatus();
    expect(status.statusCheckErrorCode).toBe('timeout');
    expect(status.statusMessage).toBe('OpenCode is still loading');
    expect(status.detailMessage).toContain(
      'OpenCode is taking longer than expected to load provider status. Your saved connections were not changed. Retry in a moment.'
    );
    expect(status.detailMessage).toContain(`Working directory: ${cwd}`);
    expect(status.detailMessage).toContain('stderr: runtime missing');
    expect(status.detailMessage).toContain('Signal: SIGTERM');
    expect(status.detailMessage).toContain('Error code: ETIMEDOUT');
    expect(status.detailMessage).not.toContain('timeout-secret');
    expect(status.capabilities.teamLaunch).toBe(false);
  });

  it('never reclassifies an execution failure from diagnostic output alone', async () => {
    execMock.mockRejectedValue(
      Object.assign(new Error('Command failed'), { stderr: 'Previous request timeout' })
    );
    const status = await failureStatus();
    expect(status.statusCheckErrorCode).toBe('unavailable');
    expect(status.detailMessage).toContain('Previous request timeout');
  });

  it('bounds and redacts credentials, headers, URLs and environment evidence before presentation', async () => {
    execMock.mockRejectedValue(
      Object.assign(new Error('Command failed --token "argument-secret"'), {
        code: 'EACCES',
        stderr: [
          'OPENAI_API_KEY=env-secret',
          '{"apiKey":"json-secret","password":"password-secret"}',
          'Authorization: Bearer bearer-secret',
          'https://user:url-password@runtime.test/status?token=url-secret',
          'sk-12345678901234567890',
          'x'.repeat(10_000),
        ].join('\n'),
      })
    );
    const error = await readRuntimeStatusCommand(
      binaryPath,
      args,
      { cwd, env: { SECRET_OPTION: 'not-output-secret' } },
      extractRuntimeStatusJsonObject
    ).catch((error: unknown) => error);
    const status = createRuntimeStatusErrorProviderStatus('opencode', error);
    const details = status.detailMessage ?? '';
    for (const secret of [
      'argument-secret',
      'env-secret',
      'json-secret',
      'password-secret',
      'bearer-secret',
      'url-password',
      'url-secret',
      'sk-12345678901234567890',
      'not-output-secret',
    ]) {
      expect(details).not.toContain(secret);
    }
    expect(details).toContain('Error code: EACCES');
    expect(details).toContain('[redacted]');
    expect(details.length).toBeLessThanOrEqual(6_000);
    expect(details).toContain('...');
    expect(getProviderStatusCheckErrorCode(error)).toBe('unavailable');
  });

  it('suppresses arbitrary auth/config/environment dumps instead of guessing their secret fields', async () => {
    execMock.mockRejectedValue(
      Object.assign(new Error('Command failed'), {
        stdout: '{"config":{"customField":"private-config-value"}}',
        stderr: 'environment dump: CUSTOM_FIELD=private-environment-value',
      })
    );
    const details = (await failureStatus()).detailMessage;
    expect(details).not.toContain('private-config-value');
    expect(details).not.toContain('private-environment-value');
    expect(details).toContain('[configuration/auth/environment dump hidden]');
  });

  it('records the actual inherited working directory when none was supplied', async () => {
    execMock.mockRejectedValue(Object.assign(new Error('Command failed'), { code: 1 }));
    const error = await readRuntimeStatusCommand(
      binaryPath,
      args,
      {},
      extractRuntimeStatusJsonObject
    ).catch((error: unknown) => error);
    const status = createRuntimeStatusErrorProviderStatus('opencode', error);
    expect(status.detailMessage).toContain(`Working directory: ${process.cwd()}`);
    expect(status.detailMessage).not.toContain('[inherited]');
  });

  it('preserves typed deleted-project errors and their recovery classification', async () => {
    execMock.mockRejectedValue(new WorkingDirectoryMissingError(cwd));
    const status = await failureStatus();
    expect(status.statusCheckErrorCode).toBe('project_missing');
    expect(status.detailMessage).toContain(`Project folder not found: ${cwd}`);
  });
});
