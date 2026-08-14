#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const [gitDirectoryInput, commit, admissionInput] = process.argv.slice(2);
if (!gitDirectoryInput || !/^[0-9a-f]{40}$/u.test(commit ?? '') || !admissionInput) {
  throw new Error('usage: verify-hosted-approval-runtime-admission-authority <git-dir> <commit> <admission-json>');
}

const gitDirectory = resolve(gitDirectoryInput);
const admissionPath = resolve(admissionInput);
const root = await mkdtemp(join(tmpdir(), 'hosted-approval-authority-'));
const authorityFiles = [
  'HostedApprovalRuntimeAdmission.ts',
  'HostedApprovalWire.ts',
  'ownerProof.ts',
  'protocol.ts',
];

try {
  for (const file of authorityFiles) {
    const objectPath = `src/services/hostedControl/${file}`;
    const { stdout } = await run('/usr/bin/git', [
      `--git-dir=${gitDirectory}`,
      'show',
      `${commit}:${objectPath}`,
    ]);
    await writeFile(join(root, file), stdout, { mode: 0o600 });
  }
  const admission = JSON.parse(await readFile(admissionPath, 'utf8'));
  const runner = `
    import { PrivateFileHostedApprovalRuntimeAdmissionStore } from './HostedApprovalRuntimeAdmission.ts';
    import { readFile } from 'node:fs/promises';
    void (async () => {
    const admission = JSON.parse(await readFile(${JSON.stringify(admissionPath)}, 'utf8'));
    const outer = admission.outerAuthority;
    const loaded = await new PrivateFileHostedApprovalRuntimeAdmissionStore(${JSON.stringify(admissionPath)}).load({
      deploymentId: outer.deploymentId,
      bootId: outer.bootId,
      workspaceId: outer.workspaceId,
      teamId: outer.teamId,
      restoreGeneration: outer.restoreGeneration,
      mountBinding: outer.mountBinding,
    });
    if (!(await loaded.isCurrent())) throw new Error('external-authority-drift');
    })();
  `;
  await writeFile(join(root, 'verify.ts'), runner, { mode: 0o600 });
  await run(process.execPath, ['--import', 'tsx', join(root, 'verify.ts')], {
    cwd: process.cwd(),
  });
  const source = await readFile(join(root, 'HostedApprovalRuntimeAdmission.ts'));
  const admissionBytes = await readFile(admissionPath);
  process.stdout.write(`${JSON.stringify({
    verified: true,
    authorityCommit: commit,
    authorityBlobSha256: createHash('sha256').update(source).digest('hex'),
    admissionSha256: createHash('sha256').update(admissionBytes).digest('hex'),
    approvalGeneration: admission.admissionGeneration,
  })}\n`);
} finally {
  await rm(root, { recursive: true, force: true });
}
