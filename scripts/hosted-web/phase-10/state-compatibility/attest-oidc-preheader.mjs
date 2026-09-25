import { attestOidcPreHeaderState } from '../../../../src/features/hosted-state-compatibility/main/infrastructure/attestOidcPreHeaderState.ts';

function argument(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || index + 1 >= process.argv.length) throw new Error(`missing ${name}`);
  return process.argv[index + 1];
}

async function main() {
  if (process.argv.length !== 12 || argument('--confirm-stopped') !== 'yes') {
    throw new Error(
      'usage: attest-oidc-preheader.mjs --state-directory PATH --deployment-id ID --restore-generation NUMBER --database-sha256 SHA256 --confirm-stopped yes'
    );
  }
  const generation = argument('--restore-generation');
  if (!/^(0|[1-9][0-9]*)$/.test(generation) || !Number.isSafeInteger(Number(generation))) {
    throw new Error('invalid restore generation');
  }
  await attestOidcPreHeaderState({
    stateDirectory: argument('--state-directory'),
    deploymentId: argument('--deployment-id'),
    restoreGeneration: Number(generation),
    expectedDatabaseSha256: argument('--database-sha256'),
  });
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
