#!/usr/bin/env node
import { startCoreSandbox } from './run.mjs';

function options(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!['--owner-repo', '--owner-commit', '--registry-image', '--base-image', '--team-id', '--opencode-bin', '--local-provider-base-url', '--uid', '--gid'].includes(name) ||
        !value || Object.hasOwn(values, name)) throw new Error('core-issuer-options-invalid');
    values[name] = value;
  }
  if (!values['--owner-repo'] || !values['--owner-commit'] || !values['--registry-image'] || !values['--base-image']) {
    throw new Error('core-issuer-required-options-missing');
  }
  const uid = Number(values['--uid'] ?? '1000');
  const gid = Number(values['--gid'] ?? '1000');
  if (!Number.isSafeInteger(uid) || uid < 1 || !Number.isSafeInteger(gid) || gid < 1) {
    throw new Error('core-issuer-product-identity-invalid');
  }
  return { ownerRepo: values['--owner-repo'], ownerCommit: values['--owner-commit'], registryImage: values['--registry-image'],
    baseImage: values['--base-image'], teamId: values['--team-id'],
    openCodeBinaryPath: values['--opencode-bin'], localProviderBaseUrl: values['--local-provider-base-url'], uid, gid };
}

let sandbox;
try {
  sandbox = await startCoreSandbox(options(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify({
    kind: 'core-issuer-ready', ownerCommit: sandbox.image.ownerCommit,
    generatedArtifact: sandbox.image.generatedArtifact,
    imageReference: sandbox.image.imageReference,
    ownerArtifactDigest: sandbox.image.ownerArtifactDigest,
    ownerExecutableDigest: sandbox.image.ownerExecutableDigest,
    claudeRoot: sandbox.claudeRoot, runDirectory: sandbox.runDirectory,
    trustDirectory: sandbox.trustDirectory, workspaceRoot: sandbox.workspaceRoot,
    ownerLogPath: sandbox.ownerLogPath,
    ownerRuntimeAttestation: sandbox.ownerRuntimeAttestation,
    officialOpenCodePath: sandbox.officialOpenCodePath,
    localProvider: sandbox.localProvider,
    productEnvironment: sandbox.productEnvironment,
  })}\n`);
  await new Promise(resolve => {
    process.once('SIGINT', resolve);
    process.once('SIGTERM', resolve);
    process.stdin.resume();
    process.stdin.once('end', resolve);
  });
} catch (error) {
  process.stderr.write(`core-issuer-failed:${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  process.stdin.pause();
  await sandbox?.close();
}
