import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { validateW11DiagnosticUpload } from './windows-diagnostic-upload.mts';
import { validateWindowsProducerUpload } from './windows-plan-producer.mts';
import type { WindowsProducerJob } from './windows-plan-producer.mts';
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

const fixture = JSON.parse(
  await readFile(new URL('./fixtures/w11-diagnostic-upload.json', import.meta.url), 'utf8')
) as { job: WindowsProducerJob; artifactCreatedAt: string; log: string };
void test('actual W11 quantized API clocks fail old rule, exact successful upload proves custody', () => {
  assert.throws(() =>
    validateWindowsProducerUpload(
      fixture.job,
      37704738528,
      'Run actions/upload-artifact@v7',
      fixture.artifactCreatedAt
    )
  );
  const proof = validateW11DiagnosticUpload(fixture.job, fixture.artifactCreatedAt, fixture.log);
  assert.equal(proof.uploadLogFinalizedAt, '2026-10-08T00:06:24.9460193Z');
  assert.equal(proof.artifactId, 11519836033);
  assert.equal(proof.qualifying, false);
});
void test('wrong, missing, repeated or reordered upload identity cannot establish custody', () => {
  for (const token of [
    '11519836033',
    'TEST-windows-ota-inputs-37704738528-1',
    'f527dc188ebd821b243b84c4531d719bc700474df977111f0a6958dc25ff20f1',
    '874799445',
  ]) {
    assert.throws(() =>
      validateW11DiagnosticUpload(
        fixture.job,
        fixture.artifactCreatedAt,
        fixture.log.replaceAll(token, 'wrong')
      )
    );
  }
  assert.throws(() =>
    validateW11DiagnosticUpload(fixture.job, fixture.artifactCreatedAt, fixture.log + fixture.log)
  );
  const reversed = fixture.log.trim().split('\n').reverse().join('\n');
  assert.throws(() =>
    validateW11DiagnosticUpload(fixture.job, fixture.artifactCreatedAt, reversed)
  );
});
void test('job identity, outcome and artifact creation remain bounded independently of upload log', () => {
  for (const job of [
    { ...fixture.job, id: 1 },
    { ...fixture.job, run_id: 1 },
    { ...fixture.job, conclusion: 'failure' },
  ]) {
    assert.throws(() => validateW11DiagnosticUpload(job, fixture.artifactCreatedAt, fixture.log));
  }
  for (const created of ['invalid', '2026-10-08T00:06:23Z', '2026-10-08T00:06:30Z']) {
    assert.throws(() => validateW11DiagnosticUpload(fixture.job, created, fixture.log));
  }
  assert.throws(() =>
    validateW11DiagnosticUpload(
      fixture.job,
      fixture.artifactCreatedAt,
      fixture.log.replace('00:06:24.9460193Z', '00:06:25.9460193Z')
    )
  );
});

void test('known System32 and SysWOW64 aliases accept quoted or unquoted executable tokens only', () => {
  const native = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
  for (const image of [ps, native]) {
    for (const token of [ps, native.toUpperCase()]) {
      for (const quoted of [true, false]) {
        const executableToken = quoted ? `"${token}"` : token;
        const args = `${executableToken} ${body}`;
        const result = installerCommand(image, args, 'C:\\Windows', root);
        assert.equal(result.command, args);
        assert.equal(result.stage, 'IS_POWERSHELL_AVAILABLE/Get-Command');
        assert.equal(result.format.knownExecutableToken, true);
        assert.equal(result.format.quotedExecutableToken, quoted);
        assert.equal(result.stopEligible, false);
      }
    }
  }
});
void test('executable-token grammar and exact approved body never disclose unknown arguments', () => {
  for (const args of [
    `${ps} ${body}\n`,
    `${ps} ${body}\r\n`,
    `${ps}.evil ${body}`,
    `"${ps}"suffix ${body}`,
    `"${ps}"\n${body}`,
    `${ps} ${body}; secret=value`,
    `${ps} -noprofile -NonInteractive ${body.slice(27)}`,
    `C:\\secret-token.exe ${body}`,
    `${ps} -C "Write-Output secret-body"`,
  ]) {
    const result = installerCommand(ps, args, 'C:\\Windows', root);
    assert.equal(result.command, '[redacted]');
    assert.equal(result.stage, 'unrecognized-redacted');
    assert.equal(result.stopEligible, false);
    assert(!JSON.stringify(result.format).includes('secret'));
  }
});
