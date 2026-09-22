import { spawn } from 'node:child_process';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, readlink, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it } from 'vitest';

import {
  isLiveLinuxProcessStat,
  parseLinuxProcStat,
  runPhase10Acceptance,
  sha256Bytes,
} from '../../../../scripts/hosted-web/phase-10/acceptance/run-phase10.mjs';
import { createStoppedStackArchive, restoreStoppedStackArchive, verifyStoppedStackArchive } from '../../../../scripts/hosted-web/phase-10/state-compatibility/stopped-stack-recovery.mjs';

const roots: string[] = [];
const digest = async (path: string) => sha256Bytes(await readFile(path));
const delay = async (milliseconds: number) => new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
async function hasOpenDescriptorUnder(path: string) {
  const targets = await Promise.all((await readdir('/proc/self/fd')).map(async (fd) => {
    try { return await readlink(`/proc/self/fd/${fd}`); } catch { return ''; }
  }));
  return targets.some((target) => target === path || target.startsWith(`${path}/`));
}
const testAuthority = generateKeyPairSync('ed25519');
const testAuthorityPublicKey = testAuthority.publicKey.export({ format: 'pem', type: 'spki' }).toString();
const testRuntimeMountAuthority = generateKeyPairSync('ed25519');
const testRuntimeMountAuthorityPublicKey = testRuntimeMountAuthority.publicKey.export({ format: 'pem', type: 'spki' }).toString();
const testReleaseLockAuthority = generateKeyPairSync('ed25519');
const testReleaseLockAuthorityPublicKey = testReleaseLockAuthority.publicKey.export({ format: 'pem', type: 'spki' }).toString();
const canonical = (value: unknown): string => Array.isArray(value)
  ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object'
    ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`
    : JSON.stringify(value);

async function createDeterministicOwnershipBoundary() {
  // CI containers commonly expose cgroup v2 read-only.  Keep the production
  // path fail-closed and use this explicit test seam to exercise enrollment
  // and cleanup deterministically without pretending that it is cgroup proof.
  const root = await mkdtemp(join(tmpdir(), 'phase10-test-boundary-'));
  const procs = join(root, 'procs');
  await writeFile(procs, '');
  return {
    procs,
    // The production implementation verifies membership from cgroup.procs.
    // This no-cgroup test double cannot emulate kernel membership, so it only
    // exercises the caller's lifecycle ordering and explicit drain hook.
    async assert(_pid?: number) {},
    async drain() {
      const pids = (await readFile(procs, 'utf8')).match(/\d+/gu) ?? [];
      for (const value of pids) {
        try {
          process.kill(Number(value), 'SIGKILL');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
        }
      }
      await writeFile(procs, '');
    },
    async assertQuiescent() {
      if ((await readFile(procs, 'utf8')).trim() !== '') {
        throw new Error('test_ownership_boundary_not_quiescent');
      }
    },
    async release() {
      await unlink(procs).catch(() => {});
      await rm(root, { recursive: true, force: true });
    },
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Phase 10 owned-process watchdog', () => {
  it('parses proc stat after a tricky comm and considers a zombie exited before reap', () => {
    const tail = ['Z', '1', '77', ...Array(16).fill('0'), '424242'];
    const zombie = parseLinuxProcStat(`4242 (controller name ) with ( parentheses)) ${tail.join(' ')}`);
    expect(zombie).toEqual({ pid: 4242, state: 'Z', processGroupId: 77, startTicks: '424242' });
    expect(isLiveLinuxProcessStat(zombie, '424242')).toBe(false);

    const live = parseLinuxProcStat(`4242 (controller name ) with ( parentheses)) S ${tail.slice(1).join(' ')}`);
    expect(isLiveLinuxProcessStat(live, '424242')).toBe(true);
    expect(isLiveLinuxProcessStat(live, 'different-start-time')).toBe(false);
  });

  it('rejects a contender until a SIGKILLed runner\'s detached descendant is drained', async () => {
    const root = await mkdtemp(join(tmpdir(), 'phase10-runner-sigkill-'));
    roots.push(root);
    const lockPath = join(root, 'instance.lock');
    await writeFile(lockPath, 'phase10-lock\n', { mode: 0o600 });
    const script = join(process.cwd(), 'scripts/hosted-web/phase-10/acceptance/run-phase10.mjs');
    const runnerProgram = `
      import { openSync, readFileSync } from 'node:fs';
      import { spawn } from 'node:child_process';
      import { lifecycleLockHolderArguments } from ${JSON.stringify(pathToFileURL(script).href)};
      const stat = readFileSync('/proc/self/stat', 'utf8');
      const startTicks = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\\s+/)[19];
      const fd = openSync(process.argv[1], 'r');
      const descendant = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{});setInterval(() => {}, 1000)"], { detached: true, stdio: 'ignore' });
      descendant.unref();
      const descendantStat = readFileSync('/proc/' + descendant.pid + '/stat', 'utf8');
      const descendantStartTicks = descendantStat.slice(descendantStat.lastIndexOf(')') + 1).trim().split(/\\s+/)[19];
      const holder = spawn('/bin/sh', ['-c',
        'flock -n 3 || exit $?; exec "$@"',
        'phase10-test-lock-holder', process.argv[2], process.argv[3],
        ...lifecycleLockHolderArguments({
          runnerPid: process.pid,
          runnerStartTicks: startTicks,
          expectedMemberPid: descendant.pid,
          expectedMemberStartTicks: descendantStartTicks,
        }),
      ], { detached: true, stdio: ['ignore', 'ignore', 'ignore', fd, 'pipe'] });
      holder.stdio[4].once('data', (chunk) => process.stdout.write(chunk.toString('utf8') + ':' + holder.pid + ':' + descendant.pid + '\\n'));
      setInterval(() => {}, 1000);
    `;
    const runner = spawn(process.execPath, ['--input-type=module', '--eval', runnerProgram, lockPath, process.execPath, script], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let holderPid: number | undefined;
    let descendantPid: number | undefined;
    try {
      await new Promise<void>((resolveAck, rejectAck) => {
        const timer = setTimeout(() => rejectAck(new Error('holder_ack_timeout')), 2_000);
        runner.stdout?.once('data', (chunk) => {
          clearTimeout(timer);
          const [acknowledgement, pid, descendant] = chunk.toString('utf8').trim().split(':');
          holderPid = Number(pid);
          descendantPid = Number(descendant);
          acknowledgement === 'locked' && Number.isSafeInteger(holderPid) && Number.isSafeInteger(descendantPid)
            ? resolveAck()
            : rejectAck(new Error('holder_ack_invalid'));
        });
        runner.once('exit', () => { clearTimeout(timer); rejectAck(new Error('runner_exited_before_ack')); });
      });
      runner.kill('SIGKILL');
      await delay(100);
      const blockedContender = spawn('/usr/bin/flock', ['-n', lockPath, '/bin/true'], { stdio: 'ignore' });
      await new Promise<void>((resolveExit, rejectExit) => {
        blockedContender.once('exit', (code) => code === 1 ? resolveExit() : rejectExit(new Error(`contender_not_rejected_${code}`)));
        blockedContender.once('error', rejectExit);
      });
      await delay(350);
      const releasedContender = spawn('/usr/bin/flock', ['-n', lockPath, '/bin/true'], { stdio: 'ignore' });
      await new Promise<void>((resolveExit, rejectExit) => {
        releasedContender.once('exit', (code) => code === 0 ? resolveExit() : rejectExit(new Error(`contender_after_drain_${code}`)));
        releasedContender.once('error', rejectExit);
      });
    } finally {
      if (runner.exitCode === null) runner.kill('SIGKILL');
      if (holderPid) {
        try { process.kill(-holderPid, 'SIGKILL'); } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
        }
      }
      if (descendantPid) {
        try { process.kill(descendantPid, 'SIGKILL'); } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
        }
      }
    }
  });
});

async function fixture(options: {
  rotatedDatabase?: boolean;
  envEchoController?: boolean;
  descendant?: boolean;
  escapeSession?: boolean;
  httpFailure?: boolean;
  httpTrickle?: boolean;
  markerOnlyAdmission?: boolean;
  secretHealthFields?: boolean;
  malformedPostAdmissionHealth?: boolean;
  missingPostAdmissionRestoreAdmission?: boolean;
} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'phase10-acceptance-'));
  roots.push(root);
  await chmod(root, 0o700);
  await mkdir(join(root, 'artifacts'));
  await mkdir(join(root, 'state', 'data', 'storage'), { recursive: true });
  await mkdir(join(root, 'state', 'data', 'hosted-state-artifact'), { recursive: true });
  await mkdir(join(root, 'state', 'instance-lock'), { recursive: true });
  await mkdir(join(root, 'locks'));
  const currentId = 'phase10-current';
  const precedingId = 'phase10-preceding';
  await writeFile(join(root, '.phase10-disposable-owned'), 'private-test-marker\n', { mode: 0o600 });
  await writeFile(join(root, 'state', 'instance-lock', 'instance.lock'), 'phase10-state-writer\n', { mode: 0o600 });
  await writeFile(join(root, 'state', 'data', 'hosted-state-header.v1.json'), JSON.stringify({
    format: 'hosted-state-header/v1', schemaVersion: 1, deploymentId: currentId, hostedStateSchemaVersion: 1,
  }));
  const stateArtifactManifest = JSON.stringify({
    format: 'hosted-state-compatibility-manifest/v1', schemaVersion: 1,
    manifestId: 'phase10-state-admission-artifact', artifactVersion: 'phase10-test',
    hostedStateSchemaVersion: 1, minimumReadableHostedStateVersion: 1, orderedMigrations: [],
  });
  await writeFile(join(root, 'state', 'data', 'hosted-state-artifact', 'manifest.json'), `${stateArtifactManifest}\n`);
  await writeFile(
    join(root, 'state', 'data', 'hosted-state-artifact', 'manifest.json.sha256'),
    `${createHash('sha256').update(`${stateArtifactManifest}\n`).digest('hex')}\n`
  );
  const database = new DatabaseSync(join(root, 'state', 'data', 'storage', 'app.db'));
  database.exec('CREATE TABLE phase10_probe(value text)');
  database.exec("CREATE TABLE operator_sessions(status text, revoked_at integer, revocation_reason text); INSERT INTO operator_sessions VALUES ('active', null, null)");
  database.exec(`CREATE TABLE hosted_access_authority(singleton integer PRIMARY KEY, state_json text NOT NULL, revision integer NOT NULL, rollback_fence_revision integer NOT NULL);
    INSERT INTO hosted_access_authority VALUES (1, '${JSON.stringify({
      binding: { deploymentId: currentId, restoreGeneration: 0 },
      deviceFamilies: ['old-device'], deviceGrants: ['old-grant'], expectedKeyringId: 'old-keyring',
      pairingChallenges: ['old-challenge'], resetIntent: 'old-reset', revision: 0, sessions: ['old-session'],
    }).replace(/'/gu, "''")}', 0, 0);`);
  database.close();
  const productionAdmissionProgram = Buffer.from(`
    import { createHash, createPublicKey, verify } from 'node:crypto';
    import { readFileSync } from 'node:fs';
    const { createNodeHostedStateCompatibilityAdmission, HostedStateStartupRefusedError } = await import(process.env.PHASE10_PRODUCTION_COMPOSITION_MODULE);
    const stateDirectory = process.env.PHASE10_STATE_ROOT + '/data';
    const canonical = (value) => Array.isArray(value)
      ? '[' + value.map(canonical).join(',') + ']'
      : value && typeof value === 'object'
        ? '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}'
        : JSON.stringify(value);
    const receiptPayload = (receipt) => ({ admissionEpoch: receipt.admissionEpoch, authorityId: receipt.authorityId, bootId: receipt.bootId, deploymentId: receipt.deploymentId, eventEpoch: receipt.eventEpoch, format: receipt.format, operationId: receipt.operationId, restoreGeneration: receipt.restoreGeneration, schemaVersion: receipt.schemaVersion, sourceManifestHash: receipt.sourceManifestHash, targetDeploymentId: receipt.targetDeploymentId });
    const sealedReplayPlan = JSON.parse(readFileSync('/proc/self/fd/11', 'utf8'));
    const requestedProof = JSON.parse(readFileSync(0, 'utf8'));
    const runtimeOptions = {
      immutableRestoreArchiveAuthority: {
        async resolveArchive(request) {
          if (canonical(request) !== canonical(sealedReplayPlan.rotation)) throw new Error('phase10_restore_scope_mismatch');
          return { archiveDirectory: '/proc/self/fd/12', sourceManifestHash: request.sourceManifestHash, restoreGeneration: request.restoreGeneration, replayAuthorityPlan: sealedReplayPlan };
        },
      },
      async verifyAndSettleRuntimeMountAdmission(receipt, request) {
        if (receipt?.format !== 'hosted-runtime-mount-admission-receipt/v1' || receipt.schemaVersion !== 1 || receipt.authorityId !== 'test-runtime-mount-authority' || receipt.deploymentId !== request.deploymentId || receipt.targetDeploymentId !== request.deploymentId || receipt.sourceManifestHash !== request.sourceManifestHash || receipt.restoreGeneration !== request.restoreGeneration || receipt.bootId !== request.bootId || receipt.eventEpoch !== request.eventEpoch || typeof receipt.operationId !== 'string' || typeof receipt.admissionEpoch !== 'string' || typeof receipt.signature !== 'string' || typeof sealedReplayPlan.runtimeMountAuthorityPublicKey !== 'string' || !verify(null, Buffer.from(canonical(receiptPayload(receipt))), createPublicKey(sealedReplayPlan.runtimeMountAuthorityPublicKey), Buffer.from(receipt.signature, 'base64'))) throw new Error('phase10_runtime_mount_admission_rejected');
        const settled = requestedProof.runtimeMountSettlement;
        if (settled?.operationId !== receipt.operationId || settled.admissionEpoch !== receipt.admissionEpoch || settled.receiptSha256 !== createHash('sha256').update(canonical(receipt)).digest('hex')) throw new Error('phase10_runtime_mount_settlement_rejected');
        return { receipt, receiptSha256: settled.receiptSha256, currentOperationId: receipt.operationId, currentAdmissionEpoch: receipt.admissionEpoch, durableHighWaterAdmissionEpoch: receipt.admissionEpoch };
      },
    };
    const composition = createNodeHostedStateCompatibilityAdmission({ artifactDirectory: stateDirectory + '/hosted-state-artifact', stateDirectory, expectedDeploymentId: sealedReplayPlan.rotation.deploymentId, runtimeOptions });
    const rotation = await composition.inspectPendingOfflineRestoreRotation();
    if (!rotation) throw new Error('phase10_production_pending_missing');
    let pendingAdmission;
    try { await composition.admitBeforeListenerExposure(); throw new Error('phase10_production_pending_admitted'); }
    catch (error) {
      if (!(error instanceof HostedStateStartupRefusedError) || error.diagnostic !== 'offline_restore_rotation_pending') throw error;
      pendingAdmission = { diagnostic: error.diagnostic };
    }
    await composition.completeOfflineRestoreRotation({ deploymentId: rotation.deploymentId, restoreGeneration: rotation.restoreGeneration, bootId: rotation.bootId, eventEpoch: rotation.eventEpoch, runtimeMountAdmission: requestedProof.runtimeMountAdmission });
    const startupAdmission = await composition.admitBeforeListenerExposure();
    process.stdout.write(JSON.stringify({ pendingAdmission, startupAdmission }));
  `).toString('base64');
  const controller = (label: string) => `// built controller ${label}
const { existsSync, readFileSync, unlinkSync, writeFileSync } = require('node:fs');
const { fstatSync, openSync, closeSync } = require('node:fs');
const http = require('node:http');
const { spawn, spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
${options.descendant ? "const descendant = spawn(process.execPath, ['-e', 'setInterval(()=>{}, 1000)'], { stdio: 'ignore' }); require('node:fs').appendFileSync(process.env.PHASE10_CGROUP_PROCS, '\\n' + descendant.pid);" : ''}
${options.escapeSession ? "const escaped = spawn(process.execPath, ['-e', 'setInterval(()=>{}, 1000)'], { detached: true, stdio: 'ignore' }); require('node:fs').appendFileSync(process.env.PHASE10_CGROUP_PROCS, '\\n' + escaped.pid); escaped.unref();" : ''}
const deploymentId = process.env.PHASE10_DEPLOYMENT_ID;
const lease = fstatSync(Number(process.env.PHASE10_INSTANCE_LOCK_FD));
const leaseDescriptorIdentity = \`\${lease.dev}:\${lease.ino}\`;
const stateFd = openSync(process.env.PHASE10_STATE_ROOT + '/data/storage/app.db', 'r');
const stateDatabase = fstatSync(stateFd); closeSync(stateFd);
const persisted = new DatabaseSync(process.env.PHASE10_STATE_ROOT + '/data/storage/app.db', { readOnly: true });
const runtimeStateProof = persisted.prepare('SELECT proof_id AS proofId, sentinel, deployment_id AS deploymentId FROM phase10_runtime_state_proof ORDER BY rowid ASC LIMIT 1').get();
persisted.close();
if (!runtimeStateProof) process.exit(79);
let restoreAdmission;
const restoreJournal = process.env.PHASE10_STATE_ROOT + '/data/hosted-restore-journal.v1.json';
const productionCompositionModule = ${JSON.stringify(join(process.cwd(), 'src/features/hosted-state-compatibility/main/composition/createHostedStateCompatibilityAdmission.ts'))};
const tsxLoader = ${JSON.stringify(join(process.cwd(), 'node_modules/tsx/dist/loader.mjs'))};
const productionAdmissionProgram = ${JSON.stringify(productionAdmissionProgram)};
function completeProductionRestoreAdmission(body) {
  const journal = JSON.parse(readFileSync(restoreJournal, 'utf8'));
  const rotation = journal.rotation;
  if (journal.phase !== 'completed' || rotation?.deploymentId !== deploymentId || body?.rotation?.sourceManifestHash !== rotation.sourceManifestHash || body?.rotation?.restoreGeneration !== rotation.restoreGeneration) throw new Error('admission_binding_invalid');
  ${options.markerOnlyAdmission ? "const markerOnlyCompleted = process.env.PHASE10_STATE_ROOT + '/data/hosted-restore-rotation.completed.v1.' + rotation.sourceManifestHash + '.g-' + rotation.restoreGeneration + '.json'; const markerOnlyPending = process.env.PHASE10_STATE_ROOT + '/data/hosted-restore-rotation.v1.' + rotation.sourceManifestHash + '.g-' + rotation.restoreGeneration + '.json'; if (!existsSync(markerOnlyCompleted)) writeFileSync(markerOnlyCompleted, JSON.stringify(rotation)); unlinkSync(markerOnlyPending); unlinkSync(restoreJournal); return { status: 'admitted', deploymentId, sourceManifestHash: rotation.sourceManifestHash, restoreGeneration: rotation.restoreGeneration, browserSessionsRevoked: true, runtimeAuthorityRotated: true, mountBindingsRotated: true, pendingAdmission: { diagnostic: 'offline_restore_rotation_pending' }, startupAdmission: { status: 'read_write' } };" : ''}
  const restored = new DatabaseSync(process.env.PHASE10_STATE_ROOT + '/data/storage/app.db');
  const scope = rotation.sourceManifestHash + '.g-' + rotation.restoreGeneration;
  const durableRotation = restored.prepare('SELECT rotation_json AS rotationJson FROM phase10_restore_rotation WHERE rotation_scope = ?').get(scope);
  const activeSessions = restored.prepare("SELECT count(*) AS count FROM operator_sessions WHERE status = 'active'").get().count;
  if (!durableRotation || activeSessions !== 0) throw new Error('admission_effects_invalid');
  restored.close();
  const processAdmission = spawnSync(process.execPath, ['--import', tsxLoader, '--input-type=module', '--eval', Buffer.from(productionAdmissionProgram, 'base64').toString('utf8')], { encoding: 'utf8', input: JSON.stringify({ runtimeMountAdmission: body.runtimeMountAdmission, runtimeMountSettlement: { ...body.runtimeMountSettlement, receiptSha256: body.runtimeMountSettlement.receiptSha256.slice('sha256:'.length) } }), stdio: ['pipe', 'pipe', 'pipe', 'ignore', 4, 'ignore', 'ignore', 'ignore', 'ignore', 'ignore', 'ignore', 11, 12], env: { PHASE10_PRODUCTION_COMPOSITION_MODULE: productionCompositionModule, PHASE10_STATE_ROOT: process.env.PHASE10_STATE_ROOT } }); if (processAdmission.status !== 0) throw new Error(processAdmission.stderr || 'production_admission_failed'); const productionAdmission = JSON.parse(processAdmission.stdout); return { status: 'admitted', deploymentId, sourceManifestHash: rotation.sourceManifestHash, restoreGeneration: rotation.restoreGeneration, browserSessionsRevoked: true, runtimeAuthorityRotated: true, mountBindingsRotated: true, ...productionAdmission };
}
const server = http.createServer((request, response) => { ${options.httpFailure ? "response.statusCode = 503; return response.end('unhealthy');" : ''} ${options.httpTrickle ? "response.write('{'); return setInterval(() => response.write(' '), 50);" : ''} if (request.method === 'POST' && request.url === '/restore-admission') { let raw = ''; request.on('data', (chunk) => raw += chunk); return request.on('end', () => { try { restoreAdmission = completeProductionRestoreAdmission(JSON.parse(raw)); response.end(JSON.stringify(restoreAdmission)); } catch (error) { response.statusCode = 409; response.end(JSON.stringify({ error: String(error.message || error) })); } }); } const health = { deploymentId, status: 'healthy', leaseDescriptorIdentity, runtimeStateProof: { ...runtimeStateProof, databaseIdentity: \`\${stateDatabase.dev}:\${stateDatabase.ino}\` }, restoreAdmission ${options.secretHealthFields ? ", providerResponse: { accessToken: 'health-secret-token', nested: { arbitrary: 'do-not-persist' } }, diagnostic: 'untrusted-controller-diagnostic'" : ''} }; ${options.missingPostAdmissionRestoreAdmission ? "if (restoreAdmission) delete health.restoreAdmission;" : ''} ${options.malformedPostAdmissionHealth ? "if (restoreAdmission) health.status = { diagnostic: 'nested-post-admission-diagnostic' };" : ''} response.end(JSON.stringify(health)); });
server.listen(0, '127.0.0.1', () => writeFileSync(process.env.PHASE10_READY_FILE, JSON.stringify({ deploymentId, port: server.address().port })));
setInterval(() => {}, 1000);
`;
  const envEchoController = `const { writeFileSync } = require('node:fs');
const http = require('node:http');
const deploymentId = process.env.PHASE10_DEPLOYMENT_ID;
const server = http.createServer((request, response) => response.end(JSON.stringify({ deploymentId, status: 'healthy', leaseDescriptorIdentity: process.env.PHASE10_INSTANCE_LOCK_ID, runtimeStateProof: { proofId: process.env.PHASE10_PROOF_ID, sentinel: process.env.PHASE10_PROOF_SENTINEL, deploymentId, databaseIdentity: process.env.PHASE10_STATE_DATABASE_ID } })));
server.listen(0, '127.0.0.1', () => writeFileSync(process.env.PHASE10_READY_FILE, JSON.stringify({ deploymentId, port: server.address().port })));
setInterval(() => {}, 1000);
`;
  await writeFile(join(root, 'artifacts', 'current.cjs'), options.envEchoController ? envEchoController : controller('current'));
  await writeFile(join(root, 'artifacts', 'preceding.cjs'), controller('preceding'));
  const currentArtifactSha = await digest(join(root, 'artifacts', 'current.cjs'));
  const precedingArtifactSha = await digest(join(root, 'artifacts', 'preceding.cjs'));
  const locks = [];
  for (const name of ['hosted-lifecycle-owner.lock.json', 'hosted-stack.lock.json', 'opencode-runtime.lock.json']) {
    const path = join(root, 'locks', name);
    await writeFile(path, name);
    const sha256 = await digest(path);
    const provenance = {
      format: 'phase10-release-lock-provenance/v1', schemaVersion: 1,
      authorityId: 'test-release-lock-authority', lockName: name,
      lockPath: `locks/${name}`, lockSha256: sha256,
    };
    locks.push({ ...provenance, name, path: `locks/${name}`, sha256, provenance: {
      ...provenance,
      signature: sign(null, Buffer.from(canonical(provenance)), testReleaseLockAuthority.privateKey).toString('base64'),
    } });
  }
  const common = { stackId: 'stack', teamId: 'team', workspaceId: 'workspace', ownerId: 'owner' };
  const preceding = {
    ...common, deploymentId: precedingId,
    image: { reference: 'built-test-artifact/phase10', digest: precedingArtifactSha },
    controllerArtifact: { path: 'artifacts/preceding.cjs', sha256: precedingArtifactSha },
  };
  await writeFile(join(root, 'preceding-deployment.json'), JSON.stringify(preceding));
  const manifest = {
    format: 'hosted-phase10-stack-manifest/v2', schemaVersion: 2, immutable: true,
    deployment: {
      ...common, deploymentId: currentId,
      image: { reference: 'built-test-artifact/phase10', digest: currentArtifactSha },
      controllerArtifact: { path: 'artifacts/current.cjs', sha256: currentArtifactSha },
    },
    locks,
    precedingManifest: { path: 'preceding-deployment.json', sha256: await digest(join(root, 'preceding-deployment.json')) },
    disposableSandbox: { markerPath: '.phase10-disposable-owned', markerSha256: await digest(join(root, '.phase10-disposable-owned')) },
    releaseLockAuthority: { authorityId: 'test-release-lock-authority' },
    evidenceAuthority: { authorityId: 'test-independent-authority', publicKeyPem: testAuthorityPublicKey, publicKeySha256: sha256Bytes(Buffer.from(testAuthorityPublicKey, 'utf8')) },
    runtimeMountAdmissionAuthority: { authorityId: 'test-runtime-mount-authority' },
  };
  await writeFile(join(root, 'hosted-phase10-stack-manifest.json'), JSON.stringify(manifest));
  return { root, manifest, manifestPath: join(root, 'hosted-phase10-stack-manifest.json') };
}

async function execute(
  input: Awaited<ReturnType<typeof fixture>>,
  onStage?: (stage: string) => Promise<void>,
  onEvidenceStage?: (stage: string) => Promise<void>,
  runtimeMountAuthorityOverride?: Record<string, unknown>
) {
  const bytes = await readFile(input.manifestPath);
  return runPhase10Acceptance({
    manifest: input.manifest,
    manifestPath: input.manifestPath,
    manifestDirectory: input.root,
    manifestSha256: sha256Bytes(bytes),
    sandboxRoot: input.root,
    onStage,
    onEvidenceStage,
    createOwnershipBoundary: createDeterministicOwnershipBoundary,
    digestAuthority: {
      authorityId: 'test-independent-authority',
      async pin({ generation, sha256 }: { generation: string; sha256: string }) {
        const receipt = { authorityId: 'test-independent-authority', generation, sha256, receiptId: `receipt-${generation}` };
        return { ...receipt, signature: sign(null, Buffer.from(canonical(receipt)), testAuthority.privateKey).toString('base64') };
      },
    },
    releaseLockAuthority: {
      authorityId: 'test-release-lock-authority',
      async readTrustedIdentity() {
        return {
          authorityId: 'test-release-lock-authority',
          anchorId: 'test-release-lock-authority-anchor',
          publicKeyPem: testReleaseLockAuthorityPublicKey,
          publicKeySha256: sha256Bytes(Buffer.from(testReleaseLockAuthorityPublicKey, 'utf8')),
        };
      },
    },
    runtimeMountAuthority: runtimeMountAuthorityOverride ?? (() => {
      const settledOperationIds = new Set<string>();
      let highWaterEpoch = 0n;
      return {
      authorityId: 'test-runtime-mount-authority',
      async readTrustedIdentity() {
        return { authorityId: 'test-runtime-mount-authority', anchorId: 'test-preprovisioned-authority-fd-identity', publicKeyPem: testRuntimeMountAuthorityPublicKey, publicKeySha256: sha256Bytes(Buffer.from(testRuntimeMountAuthorityPublicKey, 'utf8')) };
      },
      async readCurrentOperation(rotation: { deploymentId: string; sourceManifestHash: string; restoreGeneration: number; bootId: string; eventEpoch: string }) {
        return { authorityId: 'test-runtime-mount-authority', operationId: `runtime-mount-${rotation.sourceManifestHash}-${rotation.restoreGeneration}`, admissionEpoch: `${rotation.restoreGeneration}`, deploymentId: rotation.deploymentId, targetDeploymentId: rotation.deploymentId, sourceManifestHash: rotation.sourceManifestHash, restoreGeneration: rotation.restoreGeneration, bootId: rotation.bootId, eventEpoch: rotation.eventEpoch };
      },
      async rotateAndAdmit(rotation: { deploymentId: string; sourceManifestHash: string; restoreGeneration: number; bootId: string; eventEpoch: string }, current: { operationId: string; admissionEpoch: string }) {
        // This test authority is owned outside the controller fixture. Its
        // signed receipt is the bounded runtime/mount operation that the
        // controller must submit to the production composition.
        const receipt = {
          format: 'hosted-runtime-mount-admission-receipt/v1', schemaVersion: 1,
          authorityId: 'test-runtime-mount-authority', operationId: current.operationId,
          deploymentId: rotation.deploymentId, sourceManifestHash: rotation.sourceManifestHash,
          restoreGeneration: rotation.restoreGeneration, bootId: rotation.bootId, eventEpoch: rotation.eventEpoch,
          targetDeploymentId: rotation.deploymentId, admissionEpoch: current.admissionEpoch,
        };
        return { ...receipt, signature: sign(null, Buffer.from(canonical(receipt)), testRuntimeMountAuthority.privateKey).toString('base64') };
      },
      async settleReceipt(receipt: { operationId: string; admissionEpoch: string; targetDeploymentId: string }, current: { operationId: string; admissionEpoch: string }) {
        const epoch = BigInt(receipt.admissionEpoch);
        if (receipt.operationId !== current.operationId || receipt.admissionEpoch !== current.admissionEpoch || settledOperationIds.has(receipt.operationId) || epoch <= highWaterEpoch) throw new Error('test_runtime_mount_replay_rejected');
        settledOperationIds.add(receipt.operationId); highWaterEpoch = epoch;
        return { authorityId: 'test-runtime-mount-authority', operationId: receipt.operationId, admissionEpoch: receipt.admissionEpoch, targetDeploymentId: receipt.targetDeploymentId, receiptSha256: sha256Bytes(Buffer.from(canonical(receipt))), replayLedgerHighWaterEpoch: `${highWaterEpoch}` };
      },
    };
    })(),
  });
}

describe('phase 10 disposable acceptance', () => {
  it('rejects a caller-supplied verifier key in the manifest', async () => {
    const input = await fixture();
    const callerKey = generateKeyPairSync('ed25519').publicKey.export({ format: 'pem', type: 'spki' }).toString();
    input.manifest.runtimeMountAdmissionAuthority = {
      authorityId: 'test-runtime-mount-authority',
      publicKeyPem: callerKey,
      publicKeySha256: sha256Bytes(Buffer.from(callerKey, 'utf8')),
    };
    await writeFile(input.manifestPath, JSON.stringify(input.manifest));
    await expect(execute(input)).rejects.toThrow('phase10_runtime_mount_admission_authority_caller_key_forbidden');
  });

  it('rejects an old same-scope signed receipt when the trusted current operation differs', async () => {
    const input = await fixture();
    const authority = {
      authorityId: 'test-runtime-mount-authority',
      async readTrustedIdentity() {
        return { authorityId: 'test-runtime-mount-authority', anchorId: 'test-preprovisioned-authority-fd-identity', publicKeyPem: testRuntimeMountAuthorityPublicKey, publicKeySha256: sha256Bytes(Buffer.from(testRuntimeMountAuthorityPublicKey, 'utf8')) };
      },
      async readCurrentOperation(rotation: Record<string, unknown>) {
        return { authorityId: 'test-runtime-mount-authority', operationId: 'current-operation', admissionEpoch: '2', deploymentId: rotation.deploymentId, targetDeploymentId: rotation.deploymentId, sourceManifestHash: rotation.sourceManifestHash, restoreGeneration: rotation.restoreGeneration, bootId: rotation.bootId, eventEpoch: rotation.eventEpoch };
      },
      async rotateAndAdmit(rotation: Record<string, unknown>) {
        const receipt = { format: 'hosted-runtime-mount-admission-receipt/v1', schemaVersion: 1, authorityId: 'test-runtime-mount-authority', operationId: 'old-operation', admissionEpoch: '1', deploymentId: rotation.deploymentId, targetDeploymentId: rotation.deploymentId, sourceManifestHash: rotation.sourceManifestHash, restoreGeneration: rotation.restoreGeneration, bootId: rotation.bootId, eventEpoch: rotation.eventEpoch };
        return { ...receipt, signature: sign(null, Buffer.from(canonical(receipt)), testRuntimeMountAuthority.privateKey).toString('base64') };
      },
      async settleReceipt() { throw new Error('old_receipt_must_not_settle'); },
    };
    await expect(execute(input, undefined, undefined, authority)).rejects.toThrow('phase10_rollback_runtime_mount_receipt_not_current');
  });

  it('rejects duplicate operation IDs and rollback admission epochs at atomic settlement', async () => {
    const input = await fixture();
    const authority = {
      authorityId: 'test-runtime-mount-authority',
      async readTrustedIdentity() {
        return { authorityId: 'test-runtime-mount-authority', anchorId: 'test-preprovisioned-authority-fd-identity', publicKeyPem: testRuntimeMountAuthorityPublicKey, publicKeySha256: sha256Bytes(Buffer.from(testRuntimeMountAuthorityPublicKey, 'utf8')) };
      },
      async readCurrentOperation(rotation: Record<string, unknown>) {
        return { authorityId: 'test-runtime-mount-authority', operationId: 'already-settled-operation', admissionEpoch: '1', deploymentId: rotation.deploymentId, targetDeploymentId: rotation.deploymentId, sourceManifestHash: rotation.sourceManifestHash, restoreGeneration: rotation.restoreGeneration, bootId: rotation.bootId, eventEpoch: rotation.eventEpoch };
      },
      async rotateAndAdmit(rotation: Record<string, unknown>, current: { operationId: string; admissionEpoch: string }) {
        const receipt = { format: 'hosted-runtime-mount-admission-receipt/v1', schemaVersion: 1, authorityId: 'test-runtime-mount-authority', operationId: current.operationId, admissionEpoch: current.admissionEpoch, deploymentId: rotation.deploymentId, targetDeploymentId: rotation.deploymentId, sourceManifestHash: rotation.sourceManifestHash, restoreGeneration: rotation.restoreGeneration, bootId: rotation.bootId, eventEpoch: rotation.eventEpoch };
        return { ...receipt, signature: sign(null, Buffer.from(canonical(receipt)), testRuntimeMountAuthority.privateKey).toString('base64') };
      },
      async settleReceipt() { throw new Error('authority_duplicate_operation_or_epoch'); },
    };
    await expect(execute(input, undefined, undefined, authority)).rejects.toThrow('authority_duplicate_operation_or_epoch');
  });

  it('executes held, descriptor-bound artifacts and rolls back to the actual preceding deployment', async () => {
    const input = await fixture();
    // The host Node binary is deliberately larger than the metadata/control
    // cap.  This makes the acceptance proof cover executable streaming rather
    // than accidentally reusing the 1 MiB control-file reader.
    expect((await lstat(process.execPath)).size).toBeGreaterThan(1024 * 1024);
    expect((await lstat('/bin/sh')).isSymbolicLink()).toBe(true);
    const result = await execute(input);

    expect(result.status).toBe('passed');
    expect(result.evidence.rollback.selectedDeploymentId).toBe('phase10-preceding');
    expect(result.evidence.rollback.health.deploymentId).toBe('phase10-preceding');
    expect(result.evidence.current.restart.health.deploymentId).toBe('phase10-current');
    expect(result.evidence.current.restart.health).not.toHaveProperty('restoreAdmission');
    expect(result.evidence.backup.sourceDeploymentIdentity.deploymentId).toBe('phase10-current');
    expect(result.evidenceSha256).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(result.evidencePath).toBe(join(input.root, 'evidence', result.evidence.terminalEvidence.generation, 'phase10-evidence.json'));
    expect((await lstat(join(input.root, 'evidence', result.evidence.terminalEvidence.generation, 'phase10-evidence.json'))).mode & 0o777).toBe(0o400);
    expect((await lstat(join(input.root, 'evidence', 'phase10-commit.json'))).mode & 0o777).toBe(0o400);
  });

  it('proves one pre-crash database record through restart, backup, restore, and rollback', async () => {
    const input = await fixture();
    const result = await execute(input);
    const proofId = result.evidence.continuity.proofId;
    expect(result.evidence.current.restart.health.runtimeStateProof.proofId).toBe(proofId);
    expect(result.evidence.rollback.health.runtimeStateProof.proofId).toBe(proofId);
    const restored = new DatabaseSync(join(input.root, 'restored-state', 'data', 'storage', 'app.db'));
    try {
      expect(restored.prepare('SELECT proof_id AS proofId FROM phase10_runtime_state_proof WHERE proof_id = ?').get(proofId))
        .toEqual({ proofId });
    } finally { restored.close(); }
  });

  it('rejects a marker-only substituted restored database before rollback startup', async () => {
    const input = await fixture();
    await expect(execute(input, async (stage) => {
      if (stage !== 'restored_state_proof_verified') return;
      const replacementPath = join(input.root, 'replacement-valid.db');
      const replacement = new DatabaseSync(replacementPath);
      try { replacement.exec('CREATE TABLE phase10_restore_rotation(rotation_scope TEXT PRIMARY KEY, rotation_json TEXT NOT NULL)'); }
      finally { replacement.close(); }
      const target = join(input.root, 'restored-state', 'data', 'storage', 'app.db');
      await rename(target, `${target}.quarantined`);
      await rename(replacementPath, target);
    })).rejects.toThrow('phase10_rollback_state_proof_');
  });

  it('closes the restore target descriptor when rollback preparation fails after restore', async () => {
    const input = await fixture();
    await expect(execute(input, async (stage) => {
      if (stage === 'restored_state_proof_verified') throw new Error('stop_after_restore_target_bound');
    })).rejects.toThrow('stop_after_restore_target_bound');
    expect(await hasOpenDescriptorUnder(join(input.root, 'restored-state'))).toBe(false);
  });

  it('rejects controller diagnostics and nested secrets at the health evidence boundary', async () => {
    const input = await fixture({ secretHealthFields: true });
    await expect(execute(input)).rejects.toThrow('phase10_current_health_invalid');
  });

  it('revalidates the complete second rollback health response after admission', async () => {
    const input = await fixture({ malformedPostAdmissionHealth: true });
    await expect(execute(input)).rejects.toThrow('phase10_rollback_health_invalid');
  });

  it('requires restore admission in the second rollback health response', async () => {
    const input = await fixture({ missingPostAdmissionRestoreAdmission: true });
    await expect(execute(input)).rejects.toThrow('phase10_rollback_restore_admission_invalid');
  });

  it('rejects a controller that only echoes environment values instead of opening persisted state', async () => {
    const input = await fixture({ envEchoController: true });
    await expect(execute(input)).rejects.toThrow('phase10_current_health_invalid');
  });

  it('does not inherit NODE_OPTIONS preload injection into the sealed controller', async () => {
    const input = await fixture();
    const injected = join(input.root, 'node-options-ran');
    const preload = join(input.root, 'node-options-preload.cjs');
    await writeFile(preload, `require('node:fs').writeFileSync(${JSON.stringify(injected)}, 'injected');`);
    const prior = process.env.NODE_OPTIONS;
    process.env.NODE_OPTIONS = `--require=${preload}`;
    try {
      await expect(execute(input)).resolves.toMatchObject({ status: 'passed' });
      await expect(lstat(injected)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      if (prior === undefined) delete process.env.NODE_OPTIONS;
      else process.env.NODE_OPTIONS = prior;
    }
  });

  it('rejects an arbitrary image digest even when the manifest otherwise names a valid controller', async () => {
    const input = await fixture();
    input.manifest.deployment.image.digest = `sha256:${'f'.repeat(64)}`;
    await writeFile(input.manifestPath, JSON.stringify(input.manifest));
    await expect(execute(input)).rejects.toThrow('phase10_current_image_artifact_provenance_invalid');
  });

  it('rejects an unsigned release-lock digest placeholder before lifecycle ownership starts', async () => {
    const input = await fixture();
    delete (input.manifest.locks[0].provenance as { signature?: string }).signature;
    await writeFile(input.manifestPath, JSON.stringify(input.manifest));
    await expect(execute(input)).rejects.toThrow('phase10_release_lock_provenance_invalid');
  });

  it('rejects a substituted controller digest before it can be sealed for execution', async () => {
    const input = await fixture();
    const substituted = `sha256:${'e'.repeat(64)}`;
    input.manifest.deployment.controllerArtifact.sha256 = substituted;
    input.manifest.deployment.image.digest = substituted;
    await writeFile(input.manifestPath, JSON.stringify(input.manifest));
    await expect(execute(input)).rejects.toThrow('phase10_current_artifact_digest_mismatch');
  });

  it('refuses archive substitution after source identity is pinned', async () => {
    const input = await fixture();
    await expect(execute(input, async (stage) => {
      if (stage !== 'quiescent_before_backup') return;
      // The runner's archive check must bind current deployment identity rather
      // than trusting a substituted archive produced by a different deployment.
      await writeFile(join(input.root, 'state', 'data', 'hosted-state-header.v1.json'), JSON.stringify({
        format: 'hosted-state-header/v1', schemaVersion: 1, deploymentId: 'substituted', hostedStateSchemaVersion: 1,
      }));
    })).rejects.toThrow('stopped_stack_archive_source_deployment_mismatch');
  });

  it('rejects archive replacement even when the replacement recomputes valid checksums', async () => {
    const input = await fixture();
    const identity = {
      deploymentId: input.manifest.deployment.deploymentId,
      imageDigest: input.manifest.deployment.image.digest,
      deploymentManifestSha256: await digest(input.manifestPath),
      controllerArtifactSha256: input.manifest.deployment.controllerArtifact.sha256,
    };
    const original = join(input.root, 'archive-original');
    const replacement = join(input.root, 'archive-replacement');
    const pinned = await createStoppedStackArchive({ sourceRoot: join(input.root, 'state'), archiveRoot: original, sourceDeploymentIdentity: identity });
    await writeFile(join(input.root, 'state', 'data', 'hosted-state-header.v1.json'), JSON.stringify({
      format: 'hosted-state-header/v1', schemaVersion: 1, deploymentId: 'replacement', hostedStateSchemaVersion: 1,
    }));
    await createStoppedStackArchive({ sourceRoot: join(input.root, 'state'), archiveRoot: replacement });
    await rm(original, { recursive: true, force: true }); await rename(replacement, original);
    await expect(verifyStoppedStackArchive({ archiveRoot: original, expectedManifestHash: pinned.manifestHash, expectedSourceDeploymentIdentity: identity })).rejects.toThrow('stopped_stack_archive_source_deployment_mismatch');
  });

  it('refuses an exec swap race and preserves a failure outcome instead of following it', async () => {
    const input = await fixture();
    await expect(execute(input, async (stage) => {
      if (stage !== 'writer_acquired') return;
      await rm(join(input.root, 'artifacts', 'current.cjs'));
      await symlink('/etc/passwd', join(input.root, 'artifacts', 'current.cjs'));
    })).rejects.toThrow(/current_artifact_(changed|replaced)/);
    const commit = JSON.parse(await readFile(join(input.root, 'evidence', 'phase10-commit.json'), 'utf8'));
    expect(await readFile(join(input.root, 'evidence', commit.generation, 'phase10-evidence.json'), 'utf8')).toContain('"status":"failed"');
  });

  it('does not publish a partial terminal result when an existing publication is present', async () => {
    const input = await fixture();
    await mkdir(join(input.root, 'evidence'));
    await writeFile(join(input.root, 'evidence', 'phase10-evidence.json'), 'partial');
    await expect(execute(input)).rejects.toThrow('phase10_evidence_exists');
    expect(await readFile(join(input.root, 'evidence', 'phase10-evidence.json'), 'utf8')).toBe('partial');
  });

  it('does not expose terminal success when evidence publication is interrupted', async () => {
    const input = await fixture();
    await expect(execute(input, undefined, async (stage) => {
      if (stage === 'generation_durable') throw new Error('interrupted_evidence_commit');
    })).rejects.toThrow('interrupted_evidence_commit');
    await expect(lstat(join(input.root, 'evidence', 'phase10-commit.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rotates durable database sessions before restart against restored state', async () => {
    const input = await fixture({ rotatedDatabase: true });
    const result = await execute(input);
    expect(result.evidence.backup.restored.rotation.restoreGeneration).toBe(1);
    const restored = new DatabaseSync(join(input.root, 'restored-state', 'data', 'storage', 'app.db'));
    try {
      expect(restored.prepare('SELECT status, revocation_reason FROM operator_sessions').get()).toEqual({ status: 'revoked', revocation_reason: 'offline_restore' });
    } finally { restored.close(); }
  });

  it('rejects a marker-only restore acknowledgement that bypasses production admission', async () => {
    const input = await fixture({ markerOnlyAdmission: true });
    await expect(execute(input)).rejects.toThrow('phase10_rollback_restore_admission_invalid');
  });

  it('holds the actual instance lock against a contending lifecycle writer', async () => {
    const input = await fixture();
    const holder = spawn('/usr/bin/flock', ['-n', join(input.root, 'state', 'instance-lock', 'instance.lock'), '/bin/sleep', 'infinity'], { detached: true, stdio: 'ignore' });
    try {
      await delay(40);
      await expect(execute(input)).rejects.toThrow('phase10_lifecycle_writer_busy');
    } finally {
      if (holder.pid) process.kill(-holder.pid, 'SIGKILL');
    }
  });

  it('aborts when the verified lifecycle lock descriptor is replaced after acknowledgement', async () => {
    const input = await fixture();
    await expect(execute(input, async (stage) => {
      if (stage !== 'writer_acquired') return;
      await rm(join(input.root, 'state', 'instance-lock', 'instance.lock'));
      await writeFile(join(input.root, 'state', 'instance-lock', 'instance.lock'), 'replacement', { mode: 0o600 });
    })).rejects.toThrow(/phase10_lifecycle_writer_(changed|replaced|lease_lost)/);
  });

  it('uses an absolute HTTP deadline even while a controller trickles bytes', async () => {
    const input = await fixture({ httpTrickle: true });
    await expect(execute(input)).rejects.toThrow('phase10_current_health_http_deadline_exceeded');
  });

  it('reaps HTTP-failure descendants before publishing failed evidence', async () => {
    const input = await fixture({ descendant: true, httpFailure: true });
    await expect(execute(input)).rejects.toThrow('phase10_current_health_http_invalid');
    const commit = JSON.parse(await readFile(join(input.root, 'evidence', 'phase10-commit.json'), 'utf8'));
    const evidence = JSON.parse(await readFile(join(input.root, 'evidence', commit.generation, 'phase10-evidence.json'), 'utf8'));
    expect(evidence.cleanup.quiescent).toBe(true);
  });

  it('reaps exact-owned descendants after the controller leader is terminated', async () => {
    const input = await fixture({ descendant: true });
    const result = await execute(input);
    expect(result.cleanup.quiescent).toBe(true);
    expect(result.evidence.current.first.quiescent).toBe(true);
    expect(result.evidence.rollback.cleanup.quiescent).toBe(true);
  });

  it('contains a detached new-session descendant in the dedicated ownership boundary', async () => {
    const input = await fixture({ escapeSession: true });
    await expect(execute(input)).resolves.toMatchObject({ status: 'passed', cleanup: { quiescent: true } });
  });

  it('resumes a real SQLite transaction/journal crash window without rerotating state', async () => {
    const input = await fixture({ rotatedDatabase: true });
    const archive = join(input.root, 'resume.archive');
    const target = join(input.root, 'resume-target');
    await mkdir(target);
    await createStoppedStackArchive({ sourceRoot: join(input.root, 'state'), archiveRoot: archive });
    await expect(restoreStoppedStackArchive({
      archiveRoot: archive,
      targetRoot: target,
      restoreGeneration: 1,
      onRestoreStage(stage: string) { if (stage === 'database_transaction_committed') throw new Error('sqlite_commit_before_journal'); },
    })).rejects.toThrow('sqlite_commit_before_journal');
    await expect(restoreStoppedStackArchive({ archiveRoot: archive, targetRoot: target, restoreGeneration: 1 })).resolves.toMatchObject({ status: 'restored' });
    const db = new DatabaseSync(join(target, 'data', 'storage', 'app.db'));
    try {
      expect(db.prepare("SELECT count(*) AS count FROM operator_sessions WHERE status = 'active'").get()).toEqual({ count: 0 });
      expect(db.prepare('SELECT count(*) AS count FROM phase10_restore_rotation').get()).toEqual({ count: 1 });
    } finally { db.close(); }
  });

  it('supersedes a completed restore only for a later source/generation scope', async () => {
    const input = await fixture({ rotatedDatabase: true });
    const archive = join(input.root, 'generation-a.archive');
    const newerArchive = join(input.root, 'generation-b.archive');
    const target = join(input.root, 'generation-target');
    await mkdir(target);
    await createStoppedStackArchive({ sourceRoot: join(input.root, 'state'), archiveRoot: archive });
    await expect(restoreStoppedStackArchive({ archiveRoot: archive, targetRoot: target, restoreGeneration: 1 })).resolves.toMatchObject({ rotation: { restoreGeneration: 1 } });
    await expect(restoreStoppedStackArchive({ archiveRoot: archive, targetRoot: target, restoreGeneration: 2 }))
      .rejects.toThrow('stopped_stack_restore_journal_mismatch');
    await writeFile(join(input.root, 'state', 'data', 'newer-source-proof'), 'source-b');
    await createStoppedStackArchive({ sourceRoot: join(input.root, 'state'), archiveRoot: newerArchive });
    await expect(restoreStoppedStackArchive({ archiveRoot: newerArchive, targetRoot: target, restoreGeneration: 2 })).resolves.toMatchObject({ rotation: { restoreGeneration: 2 } });
    const db = new DatabaseSync(join(target, 'data', 'storage', 'app.db'));
    try {
      expect(db.prepare('SELECT count(*) AS count FROM phase10_restore_rotation').get()).toEqual({ count: 1 });
    } finally { db.close(); }
    expect((await readdir(join(target, 'data'))).filter((entry) => entry.startsWith('hosted-restore-rotation.'))).toHaveLength(4);
  });

  it('runs foreign_key_check while verifying a resumed rotation', async () => {
    const input = await fixture({ rotatedDatabase: true });
    const archive = join(input.root, 'resume-foreign.archive');
    const target = join(input.root, 'resume-foreign-target');
    await mkdir(target);
    await createStoppedStackArchive({ sourceRoot: join(input.root, 'state'), archiveRoot: archive });
    await expect(restoreStoppedStackArchive({
      archiveRoot: archive,
      targetRoot: target,
      restoreGeneration: 1,
      onRestoreStage(stage: string) { if (stage === 'database_transaction_committed') throw new Error('sqlite_commit_before_journal'); },
    })).rejects.toThrow('sqlite_commit_before_journal');
    const db = new DatabaseSync(join(target, 'data', 'storage', 'app.db'));
    try {
      db.exec('PRAGMA foreign_keys = ON; CREATE TABLE resume_parent(id INTEGER PRIMARY KEY); CREATE TABLE resume_child(parent_id INTEGER REFERENCES resume_parent(id)); PRAGMA foreign_keys = OFF; INSERT INTO resume_child(parent_id) VALUES (404)');
    } finally { db.close(); }
    await expect(restoreStoppedStackArchive({ archiveRoot: archive, targetRoot: target, restoreGeneration: 1 })).rejects.toThrow('stopped_stack_restore_foreign_key_failed');
  });

  it('refuses an app.db final-component symlink substituted before SQLite opens', async () => {
    const input = await fixture();
    const archive = join(input.root, 'database-symlink.archive');
    const target = join(input.root, 'database-symlink-target');
    await mkdir(target);
    await createStoppedStackArchive({ sourceRoot: join(input.root, 'state'), archiveRoot: archive });
    await expect(restoreStoppedStackArchive({
      archiveRoot: archive,
      targetRoot: target,
      restoreGeneration: 1,
      async onRestoreStage(stage: string) {
        if (stage !== 'payload_restored') return;
        const database = join(target, 'data', 'storage', 'app.db');
        await rename(database, `${database}.held`);
        await symlink(`${database}.held`, database);
      },
    })).rejects.toThrow('stopped_stack_restore_database_replaced');
  });

  it('rejects a real SQLite foreign-key violation during rotation', async () => {
    const input = await fixture();
    const db = new DatabaseSync(join(input.root, 'state', 'data', 'storage', 'app.db'));
    try {
      db.exec('PRAGMA foreign_keys = ON; CREATE TABLE parent(id INTEGER PRIMARY KEY); CREATE TABLE child(parent_id INTEGER REFERENCES parent(id)); PRAGMA foreign_keys = OFF; INSERT INTO child(parent_id) VALUES (404)');
    } finally { db.close(); }
    const archive = join(input.root, 'foreign.archive');
    const target = join(input.root, 'foreign-target');
    await mkdir(target);
    await createStoppedStackArchive({ sourceRoot: join(input.root, 'state'), archiveRoot: archive });
    await expect(restoreStoppedStackArchive({ archiveRoot: archive, targetRoot: target, restoreGeneration: 1 })).rejects.toThrow('stopped_stack_restore_foreign_key_failed');
  });
});
