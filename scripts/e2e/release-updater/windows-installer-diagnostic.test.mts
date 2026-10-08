import assert from 'node:assert/strict';
import test from 'node:test';
import { assertInstallerDiagnostic, installerCommand } from './windows-installer-diagnostic.mts';

const env = {
  GITHUB_ACTIONS: 'true',
  GITHUB_REPOSITORY: '777genius/agent-teams-ai',
  GITHUB_EVENT_NAME: 'workflow_dispatch',
  GITHUB_JOB: 'windows-ota',
};
const root = 'C:\\Fixture\\TEST-updater-windows-fixture';
const ps = 'C:\\Windows\\SysWOW64\\WindowsPowerShell\\v1.0\\powershell.exe';
const body =
  '-NoProfile -NonInteractive -C "if (Get-Command Get-CimInstance -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }"';
const command = `"${ps}" ${body}`;
void test('diagnostic route permits only disposable manual ARM warm OTA job', () => {
  assert.doesNotThrow(() => assertInstallerDiagnostic(env, 'arm64', 'warm'));
  for (const [key, value] of Object.entries(env)) {
    assert.throws(() =>
      assertInstallerDiagnostic({ ...env, [key]: value + '-wrong' }, 'arm64', 'warm')
    );
  }
  assert.throws(() => assertInstallerDiagnostic(env, 'x64', 'warm'));
  assert.throws(() => assertInstallerDiagnostic(env, 'arm64', 'cold'));
});
void test('actual SysWOW64 stock availability command retains exact bytes and stage, without authority', () => {
  const result = installerCommand(ps, command, 'C:\\Windows', root);
  assert.equal(result.command, command);
  assert.equal(result.stage, 'IS_POWERSHELL_AVAILABLE/Get-Command');
  assert.equal(result.architecture, 'x86');
  assert.equal(result.stopEligible, false);
});
void test('same basename, secret suffix and command/image mismatch cannot disclose arbitrary arguments', () => {
  for (const [image, args] of [
    [`${root}\\powershell.exe`, command],
    [ps, `${command}; token=secret`],
    [ps, `"C:\\foreign.exe" ${body}`],
    [ps, `"${ps}" -C "Write-Output secret"`],
  ] as const) {
    const result = installerCommand(image, args, 'C:\\Windows', root);
    assert.equal(result.command, '[redacted]');
    assert.equal(result.stage, 'unrecognized-redacted');
    assert.equal(result.stopEligible, false);
  }
});
void test('stock Win32_Process stage matches only the expected TEST install directory', () => {
  const args = `"${ps}" -NoProfile -NonInteractive -C "if ((Get-CimInstance -ClassName Win32_Process | ? {$_.Path -and $_.Path.StartsWith('C:\\Fixture\\TEST-updater-windows-fixture\\install', 'CurrentCultureIgnoreCase')}).Count -gt 0) { exit 0 } else { exit 1 }"`;
  assert.equal(installerCommand(ps, args, 'C:\\Windows', root).stage, 'FIND_PROCESS');
  assert.equal(
    installerCommand(ps, args.replace('fixture\\install', 'foreign\\install'), 'C:\\Windows', root)
      .command,
    '[redacted]'
  );
  assert.throws(() => installerCommand(ps, command, 'C:\\Windows', 'C:\\real-project'));
});
