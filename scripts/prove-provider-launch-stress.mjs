#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

import { preflightOpenCodeLiveEnvironment } from './lib/opencode-live-preflight.mjs';

const scriptPath = fileURLToPath(import.meta.url);
const scriptDir = path.dirname(scriptPath);
const repoRoot = path.resolve(scriptDir, '..');
const DEFAULT_OPENCODE_MODEL = 'opencode/big-pickle';
const DEFAULT_GEMINI_MODEL = 'gemini-2.5-flash';
const REQUIRED_PROVIDER_ORDER = ['anthropic', 'codex', 'gemini', 'opencode'];
const GEMINI_BACKENDS = new Set(['auto', 'api', 'cli-sdk']);
const INVALID_GEMINI_CONFIG = Symbol('invalid-gemini-config');
const SHA256_RE = /^[a-f0-9]{64}$/i;
// This key authenticates the immutable built-artifact receipt only. It is
// evidence about bytes, never runtime authority to spend against a provider.
const PROVIDER_LAUNCH_STRESS_RELEASE_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEApTJEnS2GTDnCBUUvl65rESizxY+045STS26S2laRCXM=
-----END PUBLIC KEY-----
`;
// A separate offline launcher capability signs a fresh statement about the
// exact wrapper process for every run. Its private half is provisioned only
// to the trusted launcher on fixed FD 6 and is never a worker bootstrap key.
const PROVIDER_LAUNCH_STRESS_TRUSTED_LAUNCHER_CAPABILITY_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA+THE0SAcPPSjg7aEY0mYMY/bEbzULrxKpP00J76iu78=
-----END PUBLIC KEY-----
`;
const TRUSTED_LAUNCHER_CAPABILITY_FD = 6;
// Fixed descriptor ABI for the wrapper-opened project directory.  It is never
// selected through a worker-controlled environment variable.
const PROJECT_DIRECTORY_CAPABILITY_FD = 4;
// The launcher signs a detached, canonical statement over every authority
// bearing field of a runtime capability.  This is deliberately distinct from
// both the wrapper-artifact receipt and the wrapper-local issuer signature:
// neither of those proves that the independently trusted launcher admitted
// the exact auth, project, accounting, issuer, and attestor selection below.
const TRUSTED_LAUNCHER_CAPABILITY_ADMISSION_DOMAIN =
  'agent-teams.provider-launch-stress.runtime-capability-admission/v1';
const PROVIDER_LAUNCH_STRESS_RELEASE_IDENTITY_FILE =
  'prove-provider-launch-stress.release-identity.json';
// Node does not expose O_ACCMODE on every supported platform.  POSIX access
// modes occupy the O_WRONLY/O_RDWR bits, while O_RDONLY is zero.
const FILE_ACCESS_MODE_MASK =
  fs.constants.O_RDONLY | fs.constants.O_WRONLY | fs.constants.O_RDWR;
// Keep every value used by release verification initialized before any of the
// fail-closed exits below.  A valid invocation must never reach verification
// with a temporal-dead-zone binding for its descriptor limit.
const MAX_RELEASE_DESCRIPTOR_BYTES = 64 * 1024 * 1024;
const CGROUP_DRAIN_TIMEOUT_MS = 30_000;
// The live suite has its own 30-minute deadline.  Keep the wrapper deadline
// finite and slightly larger so a wedged Electron worker cannot leave its
// process subtree or inherited output descriptors behind indefinitely.
const ISOLATED_OUTPUT_WORKER_TIMEOUT_MS = 35 * 60_000;
const ISOLATED_OUTPUT_WORKER_READY_TIMEOUT_MS = 5_000;
const ISOLATED_OUTPUT_WORKER_REAP_TIMEOUT_MS = 5_000;
// The collector is deliberately placed in a *different Linux user namespace*.
// A pre-exec PR_SET_DUMPABLE is not a security boundary: execve
// resets dumpability for a normal executable.  Namespace credentials are
// evaluated by ptrace_may_access after exec and therefore keep the collector's
// unlinked descriptor table inaccessible to same-host-UID canary workers.
// This is Linux-only and intentionally fail-closed when unshare is unavailable.
const COLLECTOR_NAMESPACE_ARGS = ['--user', '--map-root-user'];
// The outer mount namespace owns a private tmpfs copy of the verified closure.
// Vitest then runs in a nested user namespace, which has no CAP_SYS_ADMIN in
// the owner namespace and therefore cannot remount it read-write. DAC modes
// alone are insufficient: the same UID which owns a 0400 host file can chmod
// it back to 0600 from a sibling namespace.
const SEALED_PAYLOAD_LAUNCHER = String.raw`
import ctypes, fcntl, hashlib, json, os, shutil, sys, tempfile
root = os.path.realpath(sys.argv[1])
libc = ctypes.CDLL(None, use_errno=True)
MS_RDONLY, MS_BIND, MS_REMOUNT, MS_REC = 1, 4096, 32, 16384
private_root = tempfile.mkdtemp(prefix='provider-launch-stress-private-release-')
if libc.mount(b'tmpfs', private_root.encode(), b'tmpfs', 0, b'mode=0700,size=128m') != 0:
    raise OSError(ctypes.get_errno(), 'cannot create private verified release backing')
shutil.copytree(root, private_root, dirs_exist_ok=True, copy_function=shutil.copy2)
if libc.mount(private_root.encode(), private_root.encode(), None, MS_BIND | MS_REC, None) != 0:
    raise OSError(ctypes.get_errno(), 'cannot bind private verified release payload')
if libc.mount(None, private_root.encode(), None, MS_BIND | MS_REMOUNT | MS_RDONLY | MS_REC, None) != 0:
    raise OSError(ctypes.get_errno(), 'cannot seal verified release payload read-only')
# The verified closure is a serialized set of absolute paths. Rewrite only
# values rooted in the copied closure before the worker sees them; no host
# pathname remains executable after this point.
for key, value in list(os.environ.items()):
    if root in value:
        os.environ[key] = value.replace(root, private_root)
# Copying into tmpfs necessarily changes device/inode identities.  Re-issue the
# *complete* closure receipt from the sealed backing, rather than forwarding
# metadata captured for the mutable host copy.  The child can only consume the
# rewritten values after this mount has become read-only.
payload_key = 'PROVIDER_LAUNCH_STRESS_VERIFIED_RELEASE_PAYLOAD'
manifest_key = 'PROVIDER_LAUNCH_STRESS_VERIFIED_RELEASE_MANIFEST_PATH'
if payload_key not in os.environ or manifest_key not in os.environ:
    raise RuntimeError('sealed release closure metadata is unavailable')
payload = json.loads(os.environ[payload_key])
if not isinstance(payload, list) or not payload:
    raise RuntimeError('sealed release closure payload is malformed')
for entry in payload:
    if not isinstance(entry, dict) or not isinstance(entry.get('realPath'), str):
        raise RuntimeError('sealed release closure entry is malformed')
    member = entry['realPath']
    if not member.startswith(private_root + os.sep):
        raise RuntimeError('sealed release closure escaped its backing')
    st = os.stat(member, follow_symlinks=False)
    if not os.path.isfile(member) or os.path.islink(member):
        raise RuntimeError('sealed release closure member is unsafe')
    with open(member, 'rb') as handle:
        entry['sha256'] = hashlib.sha256(handle.read()).hexdigest()
    entry['dev'] = str(st.st_dev)
    entry['ino'] = str(st.st_ino)
    entry['size'] = str(st.st_size)
payload.sort(key=lambda entry: entry['realPath'])
manifest_path = os.environ[manifest_key]
if not manifest_path.startswith(private_root + os.sep):
    raise RuntimeError('sealed release manifest escaped its backing')
with open(manifest_path, 'rb') as handle:
    manifest_sha = hashlib.sha256(handle.read()).hexdigest()
os.environ['PROVIDER_LAUNCH_STRESS_VERIFIED_RELEASE_MANIFEST_SHA256'] = manifest_sha
canonical = ['manifest\0%s\0%s' % (manifest_path, manifest_sha)]
canonical.extend('%s\0%s\0%s' % (entry['realPath'], entry['sha256'], entry.get('role', '')) for entry in payload)
os.environ[payload_key] = json.dumps(payload, separators=(',', ':'))
os.environ['PROVIDER_LAUNCH_STRESS_VERIFIED_RELEASE_CLOSURE_SHA256'] = hashlib.sha256('\n'.join(canonical).encode()).hexdigest()
# A regular inherited file is forgeable by the worker's mapped owner: it can
# chmod and reopen /proc/self/fd/N writable. Build the trust-root descriptor in
# this wrapper-controlled pre-exec stage and seal every write/grow/shrink path
# before Vitest exists. The worker receives only a read-only duplicate.
bootstrap = os.environ.pop('PROVIDER_LAUNCH_STRESS_ATTESTATION_BOOTSTRAP_JSON', '')
if bootstrap:
    sealed = os.memfd_create('provider-launch-stress-attestation', os.MFD_ALLOW_SEALING | os.MFD_CLOEXEC)
    os.write(sealed, bootstrap.encode())
    fcntl.fcntl(sealed, fcntl.F_ADD_SEALS, fcntl.F_SEAL_SEAL | fcntl.F_SEAL_WRITE | fcntl.F_SEAL_GROW | fcntl.F_SEAL_SHRINK)
    reader = os.open('/proc/self/fd/%d' % sealed, os.O_RDONLY | os.O_CLOEXEC)
    if reader != 3:
        os.dup2(reader, 3)
        os.close(reader)
    if sealed != 3:
        os.close(sealed)
os.execvp('unshare', ['unshare', '--user', '--map-root-user', '--'] + sys.argv[2:])
`;
// This tiny pre-exec launcher moves itself into a child cgroup before it can
// create the namespace or any provider process.  Its readiness byte is sent
// before exec, making the parent-side kill boundary an observed kernel fact
// rather than an assumption about spawn ordering.
const ISOLATED_OUTPUT_WORKER_LAUNCHER = String.raw`
import os, sys
cgroup_procs = os.path.join(sys.argv[1], 'cgroup.procs')
with open(cgroup_procs, 'w', encoding='ascii') as handle:
    handle.write(str(os.getpid()) + '\n')
os.write(3, b'joined\n')
os.execvp(sys.argv[2], sys.argv[2:])
`;
const requestedOrder =
  process.env.PROVIDER_LAUNCH_STRESS_ORDER?.trim() || REQUIRED_PROVIDER_ORDER.join(',');
// Declared before private fault-fixture dispatch because the fixture exercises
// the same ownership publication used by the release wrapper.
let launchCgroup;

// This mode is intentionally entered before the release command's guards.
// It is a private child of the wrapper, never a user-selectable canary mode.
if (process.argv[2] === '--provider-launch-stress-accounting-collector') {
  // `runAuthenticatedAccountingCollector` owns the server lifetime.  In
  // particular it resolves only after SIGTERM/SIGINT has closed the listener,
  // all accepted sockets, stdout, and the inherited observation descriptors.
  // Do not strand this private helper behind a never-settling promise: doing
  // so keeps a successful release wrapper alive after its final snapshot.
  await runAuthenticatedAccountingCollector();
  process.exit(0);
}

if (process.argv[2] === '--provider-launch-stress-accounting-producer') {
  await runAuthenticatedAccountingProducer();
  process.exit(0);
}

if (process.argv[2] === '--provider-launch-stress-capability-attestor') {
  // This helper is deliberately separate from the worker namespace.  The
  // worker receives a fresh signed attestation over a Unix socket, never a
  // capability, issuer, or ancestor-process descriptor it could reopen.
  await runCapabilityAttestationService();
  process.exit(0);
}

// This private fixture exercises the same cgroup admission cleanup boundary
// with a fault injected immediately after join.  It has no provider, release,
// credential, or worker behavior and exists solely to keep the exceptional
// ownership path observable without a writable host cgroup hierarchy.
if (process.argv[2] === '--provider-launch-stress-cgroup-init-fault-fixture') {
  const result = runDedicatedLaunchCgroupInitializationFaultFixture();
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exit(result.ok ? 0 : 1);
}

// This private fixture exercises the real descriptor guards against unlinked
// files. It is intentionally local-only and exits before any release, provider,
// credential, or worker authority is allocated.
if (process.argv[2] === '--provider-launch-stress-descriptor-access-fixture') {
  const result = runDescriptorAccessModeFixture();
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exit(result.ok ? 0 : 1);
}

// This local-only fixture makes the signal/preflight interleaving observable
// without opening a descriptor, cgroup, provider, or worker.  It exercises
// the same post-await admission rule the release path uses: once cleanup has
// begun, a completed preflight is not permission to allocate a worker.
if (process.argv[2] === '--provider-launch-stress-signal-during-preflight-fixture') {
  const result = await runSignalDuringPreflightFixture();
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exit(result.ok ? 0 : 1);
}

// Lightweight test runs may prove only that an absent or malformed fixed
// descriptor is rejected. Positive launcher authority is asserted solely by
// the authenticated live/disposable worker after release identity admission.
if (process.argv[2] === '--provider-launch-stress-fd6-negative-fixture') {
  const capability = readTrustedLauncherPrivateCapability();
  if (capability) fs.closeSync(TRUSTED_LAUNCHER_CAPABILITY_FD);
  const result = { ok: !capability, authorized: Boolean(capability) };
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exit(result.ok ? 0 : 1);
}

// This is deliberately the *release* entry point.  A test flag must never
// turn a paid live command into a green synthetic check (including when a
// caller supplies an unknown self-test value).
if (Object.keys(process.env).some((name) => name.startsWith('PROVIDER_LAUNCH_STRESS_SELF_TEST'))) {
  console.error('Provider launch stress release canary rejects all self-test inputs.');
  process.exit(1);
}

const trustedWrapperRelease = verifyTrustedWrapperReleaseIdentity();
if (!trustedWrapperRelease.ok) {
  console.error(
    `Provider launch stress cannot verify its signed release identity: ${trustedWrapperRelease.reason}`
  );
  process.exit(1);
}
// This fixture proves the actual wrapper descriptor/closure guard, rather
// than maintaining a test-side lookalike.  It still verifies the signed
// wrapper identity first; it merely stops before FD 6 or any provider-facing
// allocation because its only purpose is a local release-closure assertion.
if (process.argv[2] === '--provider-launch-stress-release-closure-fixture') {
  const artifact = verifyReleaseOrchestratorArtifact({ env: process.env });
  process.stdout.write(`${JSON.stringify(artifact)}\n`);
  process.exit(artifact.ok ? 0 : 1);
}
const trustedLauncherCapability = readTrustedLauncherPrivateCapability();
if (!trustedLauncherCapability) {
  console.error(
    'Provider launch stress requires the independently trusted launcher private capability on FD 6.'
  );
  process.exit(1);
}

const env = {
  ...process.env,
  PROVIDER_LAUNCH_STRESS_LIVE: '1',
  PROVIDER_LAUNCH_STRESS_ORDER: requestedOrder,
  PROVIDER_LAUNCH_STRESS_MEMBER_COUNT:
    process.env.PROVIDER_LAUNCH_STRESS_MEMBER_COUNT?.trim() || '5',
  PROVIDER_LAUNCH_STRESS_ANTHROPIC_AUTH:
    process.env.PROVIDER_LAUNCH_STRESS_ANTHROPIC_AUTH?.trim() ||
    (process.env.ANTHROPIC_API_KEY?.trim() ? 'api-key' : 'subscription'),
  CLAUDE_TEAM_PROCESS_RUNTIME_READY_TIMEOUT_MS:
    process.env.CLAUDE_TEAM_PROCESS_RUNTIME_READY_TIMEOUT_MS?.trim() || '90000',
  CLAUDE_TEAM_PROCESS_INBOX_POLLER_READY_TIMEOUT_MS:
    process.env.CLAUDE_TEAM_PROCESS_INBOX_POLLER_READY_TIMEOUT_MS?.trim() || '30000',
  PROVIDER_LAUNCH_STRESS_OPENCODE_MODEL:
    process.env.PROVIDER_LAUNCH_STRESS_OPENCODE_MODEL?.trim() || DEFAULT_OPENCODE_MODEL,
  PROVIDER_LAUNCH_STRESS_GEMINI_MODEL:
    process.env.PROVIDER_LAUNCH_STRESS_GEMINI_MODEL?.trim() || DEFAULT_GEMINI_MODEL,
  OPENCODE_E2E: '1',
  OPENCODE_E2E_USE_REAL_APP_CREDENTIALS: '1',
  OPENCODE_DISABLE_AUTOUPDATE: process.env.OPENCODE_DISABLE_AUTOUPDATE ?? '1',
};
let preserveRunEvidence = false;
// A failed targeted scrub changes the cleanup authority: the invocation root
// itself must be erased even when the signed release closure has since become
// unavailable.  A release receipt authorizes provider execution and retained
// evidence, never keeping copied credentials alive after their removal failed.
let credentialScrubFailureDetected = false;
let disposableRunRoot = '';
let disposableRunProject = null;
let immutableExecutionPayload = null;
let accountingCollectorStopped = false;
let accountingCollector;
let capabilityAttestor;
let capabilityDir = '';
let capabilityFd;
let capabilityIssuerFd;
let wrapperProcFd;
let isolatedOutputWorker;
let isolatedOutputWorkerCgroup;
let earlyFailureCleanupSuperseded = false;
let failureCleanupInProgress = false;
let providerLaunchStressCleanupPromise = null;
let providerLaunchStressAsyncCleanupComplete = false;
let providerLaunchStressSignal = null;

function assertProviderLaunchStressAdmissionOpen(boundary) {
  if (
    providerLaunchStressSignal ||
    providerLaunchStressCleanupPromise ||
    failureCleanupInProgress
  ) {
    throw new Error(`Provider launch stress cleanup already began; refusing ${boundary}.`);
  }
}

// Install ownership cleanup before any collector, disposable project, auth
// copy, or attestor allocation. The complete handler below supersedes this
// narrow bootstrap guard once every resource has been initialized; until
// then, no partial credential copy is allowed to outlive a fail-closed exit.
process.once('exit', () => {
  if (earlyFailureCleanupSuperseded) return;
  try {
    if (disposableRunProject) {
      scrubCopiedProviderCredentialsBeforeEvidence();
      eraseCredentialBearingDisposableRunRoot(disposableRunProject);
    }
  } catch {
    process.exitCode = 1;
  }
  for (const child of [accountingCollector?.process, accountingCollector?.producer]) {
    try {
      if (child?.exitCode === null && child?.signalCode === null) child.kill('SIGKILL');
    } catch {
      process.exitCode = 1;
    }
  }
});

// Several bootstrap steps intentionally throw (rather than returning a
// synthetic result) when a descriptor, sealed payload, or preflight helper is
// malformed. Route those uncaught failures through the same awaited sibling
// cleanup as explicit rejections; the superseded `exit` registration is only
// a last-resort credential scrub, never the primary collector lifecycle.
const failFromUnhandledProviderLaunchStressError = async (error) => {
  if (failureCleanupInProgress) {
    process.exitCode = 1;
    return;
  }
  try {
    await failClosedProviderLaunchStress(
      `Provider launch stress bootstrap failed: ${compactOutput(error?.message || error)}`
    );
  } catch {
    // The fail-closed path has already emitted the actionable failure and
    // completed the owned-resource teardown. Keep Node's natural exit rather
    // than calling process.exit() while descriptors are still observable.
  }
};
process.once('uncaughtException', failFromUnhandledProviderLaunchStressError);
process.once('unhandledRejection', failFromUnhandledProviderLaunchStressError);

// SIGINT/SIGTERM are normal operational exits, not an excuse to abandon the
// independently-owned accounting siblings or the launch cgroup.  Re-raise
// the original signal only after the bounded, idempotent teardown has reaped
// every child and removed credential-bearing state, preserving shell signal
// semantics without relying on an async-impossible `exit` callback.
for (const signal of ['SIGINT', 'SIGTERM']) {
  const handleProviderLaunchStressSignal = () => {
    if (providerLaunchStressSignal) return;
    providerLaunchStressSignal = signal;
    void (async () => {
      try {
        await cleanupProviderLaunchStress(`received ${signal}`);
      } catch (error) {
        process.exitCode = 1;
        console.error(
          `Provider launch stress ${signal} cleanup failed: ${compactOutput(error?.message || error)}`
        );
      } finally {
        process.removeListener(signal, handleProviderLaunchStressSignal);
        process.kill(process.pid, signal);
      }
    })();
  };
  process.on(signal, handleProviderLaunchStressSignal);
}

if (process.platform !== 'linux') {
  console.error(
    `Provider launch stress live canary is unsupported on ${process.platform}; refusing to run.`
  );
  process.exit(1);
}

// This is the ownership boundary for the complete canary, not an observation
// made after a provider has already started.  The wrapper joins an otherwise
// empty delegated cgroup before it starts preflight or Vitest; consequently
// every provider, setsid child, and reparented descendant inherits this kernel
// membership.  Refuse to run when the runner has not delegated a writable v2
// cgroup rather than silently replacing this guarantee with /proc ancestry.
// A release run observes provider charges only through an independently-owned
// collector.  These are unlinked, read-only descriptors, never a caller
// pathname that a task or this suite could replace or append to.
try {
  assertProviderLaunchStressAdmissionOpen('accounting collector sibling allocation');
  accountingCollector = await startAuthenticatedAccountingCollector();
} catch (error) {
  await failClosedProviderLaunchStress(
    `Provider launch stress requires write-isolated accounting collector descriptors: ${compactOutput(error?.message || error)}`
  );
}
// Start the collector before entering the provider launch cgroup.  It is a
// sibling observer, never a launch descendant: cgroup teardown cannot kill it
// before the final signed accounting snapshot is obtained.
try {
  assertProviderLaunchStressAdmissionOpen('dedicated launch cgroup allocation');
  launchCgroup = establishDedicatedLaunchCgroup();
} catch (error) {
  await failClosedProviderLaunchStress(
    `Provider launch stress requires delegated cgroup v2 write access: ${compactOutput(error?.message || error)}`
  );
}

capabilityDir = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-launch-stress-capability-'));
const capabilityPath = path.join(capabilityDir, 'capability');
const capabilityIssuerPath = path.join(capabilityDir, 'issuer');
const capabilityToken = crypto.randomBytes(32).toString('hex');
// The wrapper alone retains the private key.  A worker receives only the
// unlinked public-key descriptor and a signed envelope, so an envelope which
// merely hashes itself cannot grant live authority.
const capabilityIssuer = crypto.generateKeyPairSync('ed25519');
const capabilityIssuerPublicKey = capabilityIssuer.publicKey
  .export({ type: 'spki', format: 'pem' })
  .toString();
const capabilityIssuerId = crypto
  .createHash('sha256')
  .update(capabilityIssuerPublicKey)
  .digest('hex');
// Pin a wrapper-process object before capability construction. This anchor is
// signed by the wrapper-held issuer and cannot be synthesized by a worker from
// its own PID namespace or mutable environment strings.
wrapperProcFd = fs.openSync('/proc/self', fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
const wrapperIdentity = readLinuxProcessIdentity(`/proc/self/fd/${wrapperProcFd}`);
const wrapperProcStat = fs.fstatSync(wrapperProcFd, { bigint: true });
const wrapperIdentityAnchor = crypto
  .createHash('sha256')
  .update(`${wrapperProcStat.dev}:${wrapperProcStat.ino}:${wrapperIdentity?.startTicks ?? ''}:${capabilityToken}`)
  .digest('hex');
if (!wrapperIdentity?.startTicks) {
  await failClosedProviderLaunchStress('Provider launch stress cannot bind wrapper process identity.');
}
// This is a capability, rather than merely a description of FD 3.  The
// sealed descriptor tells the worker how to contact the attestor, while this
// nonce is signed by the wrapper issuer and is bound to the real wrapper
// process below.  In particular, an arbitrary read-only file or a separately
// created sealed memfd is not an authorization substitute.
const wrapperTrustAnchor = crypto.randomBytes(32).toString('hex');
// The built artifact receipt remains useful release evidence. Runtime
// admission instead comes from the separate launcher capability below.
const wrapperScriptPath = fs.realpathSync(scriptPath);
const wrapperScriptSha256 = trustedWrapperRelease.sha256;
// Do not leave a reopenable private-capability descriptor in the wrapper when
// it creates the untrusted worker namespace. The signed, process-bound
// admission is the only descendant-visible form of that authority.
fs.closeSync(TRUSTED_LAUNCHER_CAPABILITY_FD);
// Capture these before Vitest's global setup can change HOME or any provider
// configuration.  The descriptor is the authority; its payload is never
// printed and contains paths/auth modes only, never tokens or credentials.
const sourceAuthContext = {
  home: process.env.HOME?.trim() || process.env.USERPROFILE?.trim() || '',
  userProfile: process.env.USERPROFILE?.trim() || process.env.HOME?.trim() || '',
  claudeConfigDir: process.env.CLAUDE_CONFIG_DIR?.trim() || '',
  codexHome:
    process.env.PROVIDER_LAUNCH_STRESS_CODEX_HOME?.trim() || process.env.CODEX_HOME?.trim() || '',
  anthropicAuth:
    process.env.PROVIDER_LAUNCH_STRESS_ANTHROPIC_AUTH?.trim() ||
    (process.env.ANTHROPIC_API_KEY?.trim() ? 'api-key' : 'subscription'),
  googleApplicationCredentials: process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim() || '',
};
if (!sourceAuthContext.home || !sourceAuthContext.userProfile) {
  await failClosedProviderLaunchStress(
    'Provider launch stress requires explicit HOME or USERPROFILE from the invoking wrapper.'
  );
}
if (!sourceAuthContext.claudeConfigDir) {
  sourceAuthContext.claudeConfigDir = path.join(sourceAuthContext.home, '.claude');
}
if (!sourceAuthContext.codexHome) {
  sourceAuthContext.codexHome = path.join(sourceAuthContext.home, '.codex');
}
// Every provider sees a private home/config tree.  The source locations above
// are read-only inputs: only the small auth/config descriptors required by the
// providers are copied, and no invoking-user path is ever written or restored.
let disposableProject;
let projectDirectoryCapabilityFd;
let isolatedProviderRoots;
try {
  disposableProject = createDisposableProjectRoot();
  // Publish ownership before opening the lease or copying one credential: a
  // partial initialization now has a descriptor-authenticated cleanup target.
  disposableRunRoot = disposableProject.root;
  disposableRunProject = disposableProject;
  projectDirectoryCapabilityFd = openOwnedProjectDirectoryLease(disposableProject);
  isolatedProviderRoots = createIsolatedProviderRoots(disposableProject, sourceAuthContext);
} catch (error) {
  await failClosedProviderLaunchStress(
    `Provider launch stress could not initialize its isolated provider roots: ${compactOutput(error?.message || error)}`
  );
}
const capturedAuthContext = {
  home: isolatedProviderRoots.home,
  userProfile: isolatedProviderRoots.home,
  claudeConfigDir: isolatedProviderRoots.claudeConfigDir,
  codexHome: isolatedProviderRoots.codexHome,
  anthropicAuth: sourceAuthContext.anthropicAuth,
  xdgDataHome: isolatedProviderRoots.xdgDataHome,
  xdgConfigHome: isolatedProviderRoots.xdgConfigHome,
  googleApplicationCredentials: isolatedProviderRoots.googleApplicationCredentials,
};
// Generate the isolated attestor identity before issuing the capability.  Its
// endpoint and verification key are authority-bearing inputs, so they must be
// covered by the independent launcher admission rather than merely appearing
// in the mutable bootstrap locator.
const capabilityAttestorIdentity = createCapabilityAttestationIdentity();
const runtimeCapability = {
  version: 1,
  token: capabilityToken,
  wrapperIdentity: wrapperIdentityAnchor,
  wrapperTrustAnchor,
  wrapperScriptSha256,
  issuer: { version: 1, id: capabilityIssuerId, publicKey: capabilityIssuerPublicKey },
  attestor: {
    id: capabilityAttestorIdentity.id,
    publicKey: capabilityAttestorIdentity.publicKey,
    endpoint: capabilityAttestorIdentity.socketPath,
  },
  // This is read through the wrapper-owned /proc descriptor by the isolated
  // attestor. It is an executing-launcher capability, not an argv claim.
  launcher: {
    pid: wrapperIdentity.pid,
    startTicks: wrapperIdentity.startTicks,
    procDev: String(wrapperProcStat.dev),
    procIno: String(wrapperProcStat.ino),
  },
  auth: capturedAuthContext,
  cgroup: {
    mountPath: launchCgroup.mountPath,
    relativePath: launchCgroup.relativePath,
    dev: launchCgroup.dev,
    ino: launchCgroup.ino,
  },
  project: {
    root: disposableProject.root,
    projectPath: disposableProject.projectPath,
    token: disposableProject.token,
    invocationId: disposableProject.invocationId,
    rootDev: disposableProject.rootDev,
    rootIno: disposableProject.rootIno,
    projectDev: disposableProject.projectDev,
    projectIno: disposableProject.projectIno,
    markerDev: disposableProject.markerDev,
    markerIno: disposableProject.markerIno,
  },
  accounting: accountingCollector.capability,
};
const trustedLauncherAdmissionPayload = canonicalizeTrustedLauncherCapabilityAdmission(
  runtimeCapability
);
const trustedLauncherAdmission = {
  payload: trustedLauncherAdmissionPayload,
  signature: crypto
    .sign(null, Buffer.from(trustedLauncherAdmissionPayload), trustedLauncherCapability)
    .toString('base64'),
};
// The wrapper-local issuer transports this exact capability to the isolated
// attestor.  The independently trusted signature above remains the admission
// decision and covers every runtime authority field, excluding only itself.
const capabilityPayload = canonicalizeJson({ ...runtimeCapability, trustedLauncherAdmission });
const capabilityEnvelope = canonicalizeJson({
  version: 2,
  issuerId: capabilityIssuerId,
  payload: capabilityPayload,
  signature: crypto.sign(null, Buffer.from(capabilityPayload), capabilityIssuer.privateKey).toString('base64'),
});
const capabilityPayloadSha256 = crypto.createHash('sha256').update(capabilityEnvelope).digest('hex');
fs.writeFileSync(capabilityPath, capabilityEnvelope, { mode: 0o600 });
fs.writeFileSync(
  capabilityIssuerPath,
  JSON.stringify({ version: 1, id: capabilityIssuerId, publicKey: capabilityIssuerPublicKey }),
  { mode: 0o600 }
);
capabilityFd = fs.openSync(capabilityPath, 'r');
capabilityIssuerFd = fs.openSync(capabilityIssuerPath, 'r');
// Only the wrapper and the separately namespaced attestor receive these
// descriptors. Removing the pathnames makes their backing non-replaceable;
// Vitest receives a fresh signed response, never an inheritable descriptor.
fs.unlinkSync(capabilityPath);
fs.unlinkSync(capabilityIssuerPath);
try {
  assertProviderLaunchStressAdmissionOpen('capability attestor sibling allocation');
  capabilityAttestor = await startCapabilityAttestationService({
    capabilityFd,
    capabilityIssuerFd,
    wrapperIdentity: wrapperIdentityAnchor,
    wrapperTrustAnchor,
    wrapperScriptPath,
    wrapperScriptSha256,
    wrapperPid: process.pid,
    wrapperStartTicks: wrapperIdentity.startTicks,
    wrapperProcFd,
    launchCgroup,
    identity: capabilityAttestorIdentity,
  });
} catch (error) {
  await failClosedProviderLaunchStress(
    `Provider launch stress could not bootstrap capability attestation: ${compactOutput(error?.message || error)}`
  );
}
env.PROVIDER_LAUNCH_STRESS_ATTESTATION_BOOTSTRAP_JSON = JSON.stringify({
  version: 2,
  endpoint: capabilityAttestor.socketPath,
  publicKey: capabilityAttestor.publicKey,
  id: capabilityAttestor.id,
  // The worker independently verifies this issuer-bound anchor after proving
  // that its process is descended from the exact wrapper process.  Do not put
  // this in a caller-selectable environment variable.
  // Keep the bootstrap issuer byte-for-byte compatible with the issuer that
  // signed the capability.  Omitting the version here made a genuine
  // bootstrap look like an older issuer shape even though the capability it
  // locates requires issuer.version === 1.
  issuer: { version: 1, id: capabilityIssuerId, publicKey: capabilityIssuerPublicKey },
  wrapperPid: process.pid,
  wrapperStartTicks: wrapperIdentity.startTicks,
  wrapperTrustAnchor,
  wrapperScriptSha256,
  signature: crypto
    .sign(
      null,
      Buffer.from(
        JSON.stringify({
          version: 2,
          endpoint: capabilityAttestor.socketPath,
          publicKey: capabilityAttestor.publicKey,
          id: capabilityAttestor.id,
          issuerVersion: 1,
          issuerId: capabilityIssuerId,
          wrapperPid: process.pid,
          wrapperStartTicks: wrapperIdentity.startTicks,
          wrapperTrustAnchor,
          wrapperScriptSha256,
        })
      ),
      capabilityIssuer.privateKey
    )
    .toString('base64'),
});
process.on('exit', () => {
  if (providerLaunchStressAsyncCleanupComplete) return;
  // The worker and all of its descendants must have left before the wrapper
  // returns to its original cgroup.  This makes a successful run's cgroup
  // removal a meaningful assertion that no owned process escaped cleanup.
  try {
    releaseDedicatedLaunchCgroup(launchCgroup);
  } catch (error) {
    enableEvidenceRetention('dedicated launch cgroup deletion failure');
    process.exitCode = 1;
    console.error(
      `Provider launch stress could not release its cgroup: ${compactOutput(error?.message || error)}`
    );
  }
  // A retained root is failure evidence, never a credential backup.  This
  // must happen after all provider descendants are drained and before either
  // the root or a failure bundle is allowed to survive this invocation.
  if (preserveRunEvidence && !scrubCopiedProviderCredentialsBeforeEvidence()) {
    // Failing closed means retaining no evidence rather than retaining a raw
    // credential. The normal authenticated root tombstone path below remains
    // available because this only changes preservation intent.
    preserveRunEvidence = false;
    credentialScrubFailureDetected = true;
    process.exitCode = 1;
    console.error('Refused to retain disposable canary evidence because copied credentials could not be scrubbed.');
  }
  // Keep the authenticated release descriptors available until the disposable
  // canary root has been authenticated and removed.  Deleting the copied
  // payload first used to make the final root cleanup unverifiable.
  if (disposableRunRoot && !preserveRunEvidence) {
    const removed = credentialScrubFailureDetected
      ? eraseCredentialBearingDisposableRunRoot(disposableRunProject)
      : assertOwnedDisposableRunRoot(disposableRunProject) &&
        withVerifiedReleaseDescriptorsImmediatelyBeforeEffect('delete disposable canary root', () =>
          tombstoneOwnedDirectory(
            disposableRunRoot,
            disposableRunProject.rootDev,
            disposableRunProject.rootIno
          )
        );
    if (removed) {
      // The callback above performed the deletion with the verified closure
      // descriptors still open. No pathname re-read follows the revalidation.
    } else {
      // A root whose credential scrub failed is never failure evidence. In
      // particular, do not turn a later release-closure verification failure
      // into retention of the copied provider credential tree.
      if (!credentialScrubFailureDetected) {
        enableEvidenceRetention('disposable canary root deletion failure');
      }
      process.exitCode = 1;
      console.error(
        credentialScrubFailureDetected
          ? `Could not erase credential-bearing disposable canary root: ${disposableRunRoot}`
          : `Retained disposable canary evidence: ${disposableRunRoot}`
      );
    }
  }
  if (immutableExecutionPayload && !preserveRunEvidence) {
    try {
      // The copied release closure is deliberately traversal-only while the
      // worker runs.  Once the cgroup drain above proves every execution
      // descendant has exited, reopen every immutable directory by its bound
      // identity and restore owner write access *through those descriptors*.
      // This is not a pathname chmod: a rename/symlink substitution cannot
      // make the cleanup grant write access to a different directory.
      restoreVerifiedReleaseDirectoryWritePermissions(immutableExecutionPayload);
      tombstoneOwnedDirectory(
        immutableExecutionPayload.root,
        immutableExecutionPayload.rootDev,
        immutableExecutionPayload.rootIno
      );
    } catch (error) {
      enableEvidenceRetention('immutable release payload deletion failure');
      process.exitCode = 1;
      console.error(
        `Provider launch stress could not tombstone immutable release payload: ${compactOutput(error?.message || error)}`
      );
    }
  }
  // Do not leave a stale in-memory payload authority reachable from another
  // exit callback after its root has been removed.
  immutableExecutionPayload = null;
  for (const [label, fd] of [
    ['capability', capabilityFd],
    ['wrapper process', wrapperProcFd],
    ['capability issuer', capabilityIssuerFd],
  ]) {
    try {
      fs.closeSync(fd);
    } catch (error) {
      process.exitCode = 1;
      console.error(
        `Provider launch stress could not close ${label} descriptor: ${compactOutput(error?.message || error)}`
      );
    }
  }
  // Normal completion closes and waits for this sibling before `exit`.  This
  // synchronous fallback is solely for fail-closed early exits; it must not
  // be the success path because a signal without reaping can leave stdout or
  // the UNIX listener alive and make the wrapper hang.
  if (!accountingCollectorStopped) {
    for (const child of [accountingCollector.process, accountingCollector.producer]) {
      try {
        child?.kill('SIGTERM');
      } catch {
        // The explicit fail-closed path reaps both siblings before exit. This
        // last-ditch exit callback only covers an unexpected synchronous exit.
      }
    }
  }
  if (capabilityAttestor.process.exitCode === null && capabilityAttestor.process.signalCode === null) {
    try {
      capabilityAttestor.process.kill('SIGTERM');
    } catch {
      // Normal completion reaps this channel before exit; this is only the
      // fail-closed path for an early wrapper exit.
    }
  }
  try {
    fs.rmdirSync(capabilityDir);
  } catch (error) {
    process.exitCode = 1;
    console.error(
      `Provider launch stress could not remove capability directory: ${compactOutput(error?.message || error)}`
    );
  }
});

earlyFailureCleanupSuperseded = true;

// Bind authorization to the wrapper's signed process anchor. A direct Vitest
// invocation receives neither this sealed descriptor nor the signing key.
delete env.PROVIDER_LAUNCH_STRESS_WRAPPER_PID;
delete env.PROVIDER_LAUNCH_STRESS_WRAPPER_START_TICKS;
env.PROVIDER_LAUNCH_STRESS_CGROUP_PATH = launchCgroup.path;
env.PROVIDER_LAUNCH_STRESS_CGROUP_RELATIVE_PATH = launchCgroup.relativePath;
env.PROVIDER_LAUNCH_STRESS_CGROUP_DEV = launchCgroup.dev;
env.PROVIDER_LAUNCH_STRESS_CGROUP_INO = launchCgroup.ino;
// Never export an endpoint or key selection knob to the worker. The sealed
// memfd is the only way the suite discovers this public channel.
delete env.PROVIDER_LAUNCH_STRESS_CAPABILITY_ATTESTOR_ENDPOINT;
delete env.PROVIDER_LAUNCH_STRESS_CAPABILITY_ATTESTOR_PUBLIC_KEY;
delete env.PROVIDER_LAUNCH_STRESS_CAPABILITY_ATTESTOR_ID;
delete env.PROVIDER_LAUNCH_STRESS_ACCOUNTING_RECEIPT_PATH;
delete env.PROVIDER_LAUNCH_STRESS_ACCOUNTING_RECEIPT_FD;
delete env.PROVIDER_LAUNCH_STRESS_ACCOUNTING_PROVENANCE_FD;
delete env.PROVIDER_LAUNCH_STRESS_ACCOUNTING_COLLECTOR_ENDPOINT;
delete env.PROVIDER_LAUNCH_STRESS_ACCOUNTING_COLLECTOR_PUBLIC_KEY;
delete env.PROVIDER_LAUNCH_STRESS_ACCOUNTING_COLLECTOR_ID;

// A caller-controlled Node preload/loader can execute before the suite or
// redirect module lookup outside the descriptor-inventoried release closure.
// The wrapper itself has already started, so reject these only for every
// downstream process we create; do not merely overwrite them with an empty
// value that a child loader could still interpret.
for (const name of [
  'NODE_OPTIONS',
  'NODE_PATH',
  'NODE_REPL_EXTERNAL_MODULE',
  'NODE_PRESERVE_SYMLINKS',
  'NODE_PRESERVE_SYMLINKS_MAIN',
  'NODE_COMPILE_CACHE',
]) {
  delete env[name];
}

// Resolve one explicit auth environment before either preflight or Vitest sees
// it. This is intentionally identical for subscription and API-key modes.
const effectiveHome = capturedAuthContext.home;
env.HOME = effectiveHome;
env.USERPROFILE = effectiveHome;
env.CLAUDE_CONFIG_DIR = capturedAuthContext.claudeConfigDir;
env.CODEX_HOME = capturedAuthContext.codexHome;
env.PROVIDER_LAUNCH_STRESS_CODEX_HOME = capturedAuthContext.codexHome;
env.XDG_DATA_HOME = capturedAuthContext.xdgDataHome;
env.XDG_CONFIG_HOME = capturedAuthContext.xdgConfigHome;
// Never pass the invoking user's ADC pathname through to a provider process.
// createIsolatedProviderRoots only returns an invocation-owned descriptor.
if (isolatedProviderRoots.googleApplicationCredentials) {
  env.GOOGLE_APPLICATION_CREDENTIALS = isolatedProviderRoots.googleApplicationCredentials;
} else {
  delete env.GOOGLE_APPLICATION_CREDENTIALS;
}
writeCapabilityReceipt({
  project: disposableProject,
  capabilityFd,
  expectedSha256: capabilityPayloadSha256,
  downstreamGoogleApplicationCredentials: env.GOOGLE_APPLICATION_CREDENTIALS ?? '',
});
env.PROVIDER_LAUNCH_STRESS_ANTHROPIC_AUTH = capturedAuthContext.anthropicAuth;
const configuredGeminiConfig = readGeminiConfigIfExists(
  path.join(env.CLAUDE_CONFIG_DIR, '.config.json')
);
const normalizedGeminiBackend = normalizeGeminiBackend(
  env.PROVIDER_LAUNCH_STRESS_GEMINI_BACKEND ??
    env.CLAUDE_CODE_GEMINI_BACKEND ??
    readStringProperty(configuredGeminiConfig, 'geminiBackendPreference') ??
    readStringProperty(configuredGeminiConfig, 'geminiResolvedBackend')
);
if (!normalizedGeminiBackend.ok) {
  await failClosedProviderLaunchStress(
    `Invalid Gemini backend configuration: ${normalizedGeminiBackend.reason}`
  );
}
env.PROVIDER_LAUNCH_STRESS_GEMINI_BACKEND = normalizedGeminiBackend.value;
env.CLAUDE_CODE_GEMINI_BACKEND = normalizedGeminiBackend.value;

// A release canary is never allowed to choose a source launcher, a default
// launcher, or a similarly-named executable from PATH.  CI supplies all three
// values from its signed build manifest; the worker receives the verified
// realpath and digest as immutable evidence.
const artifact = verifyReleaseOrchestratorArtifact({ env });
if (!artifact.ok) {
  await failClosedProviderLaunchStress(`Provider launch stress release artifact rejected: ${artifact.reason}`);
}
// Do not execute the mutable release pathname that was just verified.  Copy
// the complete, descriptor-verified closure into a private 0700 directory
// and execute that byte-for-byte payload.  The original build tree can now be
// replaced without changing either the executable or any dependency lookup
// used by this invocation.
const executionPayload = materializeVerifiedReleasePayload(artifact);
immutableExecutionPayload = executionPayload;
// The sealed namespace necessarily receives new inode metadata.  Bind the
// stable metadata that survives that copy (relative member path, role, and
// hash) to the same private issuer as the launch capability.  The worker
// verifies this signature only after it has independently matched that issuer
// descriptor to the live wrapper process.
const sealedReleaseAssertion = JSON.stringify({
  version: 1,
  wrapperTrustAnchor,
  wrapperSha256: artifact.sha256,
  manifestSha256: executionPayload.manifestSha256,
  payloadSha256: hashReleasePayloadSemantics(executionPayload.root, executionPayload.payload),
});
env.CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH = executionPayload.wrapperPath;
env.PROVIDER_LAUNCH_STRESS_VERIFIED_ORCHESTRATOR_PATH = executionPayload.wrapperPath;
env.PROVIDER_LAUNCH_STRESS_VERIFIED_ORCHESTRATOR_SHA256 = artifact.sha256;
env.PROVIDER_LAUNCH_STRESS_VERIFIED_RELEASE_PAYLOAD = JSON.stringify(executionPayload.payload);
env.PROVIDER_LAUNCH_STRESS_VERIFIED_RELEASE_ROOT = executionPayload.root;
env.PROVIDER_LAUNCH_STRESS_VERIFIED_RELEASE_MANIFEST_PATH = executionPayload.manifestPath;
env.PROVIDER_LAUNCH_STRESS_VERIFIED_RELEASE_MANIFEST_SHA256 = executionPayload.manifestSha256;
env.PROVIDER_LAUNCH_STRESS_VERIFIED_RELEASE_CLOSURE_SHA256 = executionPayload.closureSha256;
env.PROVIDER_LAUNCH_STRESS_SEALED_RELEASE_ASSERTION = sealedReleaseAssertion;
env.PROVIDER_LAUNCH_STRESS_SEALED_RELEASE_ASSERTION_SIGNATURE = crypto
  .sign(null, Buffer.from(sealedReleaseAssertion), capabilityIssuer.privateKey)
  .toString('base64');

// This is the sole project root for this invocation.  It is deliberately
// created before preflight: model discovery, auth checks and the OpenCode
// server all receive this cwd, never the repository or a caller-provided path.
if (process.env.PROVIDER_LAUNCH_STRESS_PROJECT_PATH?.trim()) {
  await failClosedProviderLaunchStress(
    'PROVIDER_LAUNCH_STRESS_PROJECT_PATH is not accepted by the release canary.'
  );
}
env.PROVIDER_LAUNCH_STRESS_PROJECT_ROOT = disposableProject.root;
env.PROVIDER_LAUNCH_STRESS_PROJECT_PATH = disposableProject.projectPath;
env.PROVIDER_LAUNCH_STRESS_PROJECT_TOKEN = disposableProject.token;
env.PROVIDER_LAUNCH_STRESS_INVOCATION_ID = disposableProject.invocationId;
env.PROVIDER_LAUNCH_STRESS_FAILURE_RESERVATION_MANIFEST =
  disposableProject.failureReservationManifest;
env.PROVIDER_LAUNCH_STRESS_XDG_DATA_HOME = isolatedProviderRoots.xdgDataHome;
env.PROVIDER_LAUNCH_STRESS_XDG_CONFIG_HOME = isolatedProviderRoots.xdgConfigHome;

console.log('Running provider launch stress live smoke');
console.log(`Requested order: ${env.PROVIDER_LAUNCH_STRESS_ORDER}`);
console.log(`Members per scenario: ${env.PROVIDER_LAUNCH_STRESS_MEMBER_COUNT}`);
console.log(`Anthropic auth: ${env.PROVIDER_LAUNCH_STRESS_ANTHROPIC_AUTH}`);
console.log(
  `Models: anthropic=${env.PROVIDER_LAUNCH_STRESS_ANTHROPIC_MODEL || 'haiku'}, codex=${
    env.PROVIDER_LAUNCH_STRESS_CODEX_MODEL || 'gpt-5.4-mini'
  }, gemini=${env.PROVIDER_LAUNCH_STRESS_GEMINI_MODEL}, opencode=${env.PROVIDER_LAUNCH_STRESS_OPENCODE_MODEL}`
);
console.log(`Orchestrator CLI: ${executionPayload.wrapperPath} sha256=${artifact.sha256}`);
console.log(
  `Release payload manifest: ${executionPayload.manifestPath} sha256=${executionPayload.manifestSha256} files=${executionPayload.payload.length}`
);
console.log(`Release payload closure: sha256=${executionPayload.closureSha256}`);
console.log(`Disposable project root: ${disposableProject.projectPath}`);

const preflight = await preflightProviderLaunchStress({
  repoRoot: disposableProject.projectPath,
  requestedOrder,
});
assertProviderLaunchStressAdmissionOpen('post-preflight worker admission');
for (const line of preflight.messages) {
  console.log(line);
}
if (!preflight.ok || preflight.skipped.length > 0) {
  const message = 'Provider launch stress preflight failed; required providers cannot be skipped.';
  if (enableEvidenceRetention('required provider preflight failure')) {
    console.error(`Retained disposable canary evidence: ${disposableRunRoot}`);
  }
  await failClosedProviderLaunchStress(message);
}
env.PROVIDER_LAUNCH_STRESS_ORDER = preflight.order.join(',');
// The test must only execute after this exact preflight has established the
// runnable provider set; config/environment heuristics in Vitest are not a
// sufficient substitute and can otherwise produce a false-green skip.
// The inherited wrapper PID is checked against the child's actual process
// ancestry by the live suite; ordinary environment/path values are not enough.
console.log(`Runnable order: ${env.PROVIDER_LAUNCH_STRESS_ORDER}`);

// Do not insert pnpm/npx or a process-pool fork between this descriptor and
// the executing test.  The live suite runs in a single worker-thread pool;
// worker threads share these descriptors and the suite verifies that fact.
const vitestEntry = path.join(repoRoot, 'node_modules', 'vitest', 'vitest.mjs');
if (!fs.existsSync(vitestEntry)) {
  await failClosedProviderLaunchStress(
    `Provider launch stress cannot find pinned Vitest entry: ${vitestEntry}`
  );
}
const result = await runIsolatedOutputWorker({
  launchCgroup,
  cwd: repoRoot,
  env,
  projectDirectoryCapabilityFd,
  executionPayload,
  vitestEntry,
});
fs.closeSync(projectDirectoryCapabilityFd);

if (result.error) {
  console.error(`Failed to run provider launch stress smoke: ${result.error.message}`);
  if (enableEvidenceRetention('isolated output worker failure')) {
    packageLatestLaunchFailureArtifacts();
    if (preserveRunEvidence) console.error(`Retained disposable canary evidence: ${disposableRunRoot}`);
  }
}

if ((result.status ?? 1) !== 0) {
  if (enableEvidenceRetention('isolated output worker unsuccessful exit')) {
    packageLatestLaunchFailureArtifacts();
    if (preserveRunEvidence) console.error(`Retained disposable canary evidence: ${disposableRunRoot}`);
  }
}

try {
  await stopCapabilityAttestationService(capabilityAttestor);
} catch (error) {
  enableEvidenceRetention('capability attestor shutdown failure');
  await failClosedProviderLaunchStress(
    `Provider launch stress could not close capability attestor: ${compactOutput(error?.message || error)}`
  );
}

try {
  assertDedicatedLaunchCgroupDrained(launchCgroup);
} catch (error) {
  enableEvidenceRetention('launch cgroup drain failure');
  await failClosedProviderLaunchStress(
    `Provider launch stress ownership boundary was not drained: ${compactOutput(error?.message || error)}`
  );
}

// The collector is outside cgroup.kill on purpose.  Its final signed snapshot
// is also a fence: once accepted it closes the only snapshot authority before
// comparison, so no valid late debit can arrive after the final observation.
try {
  await verifyFinalAuthenticatedAccountingSnapshot(accountingCollector.capability);
} catch (error) {
  enableEvidenceRetention('final accounting verification failure');
  await failClosedProviderLaunchStress(
    `Provider launch stress could not verify final accounting snapshot: ${compactOutput(error?.message || error)}`
  );
}

try {
  await stopAuthenticatedAccountingCollector(accountingCollector);
  accountingCollectorStopped = true;
} catch (error) {
  enableEvidenceRetention('accounting collector shutdown failure');
  await failClosedProviderLaunchStress(
    `Provider launch stress could not close accounting collector: ${compactOutput(error?.message || error)}`
  );
}

// Explicit process.exit(status) would prevent an exit-handler cgroup failure
// from changing a nominally-green status.  Let the exit handler drain and
// remove the complete subtree, and make any failure observable as command
// failure instead of a misleading success line.
process.exitCode = result.status ?? 1;

async function runIsolatedOutputWorker(input) {
  // A signal can land after preflight resolves but before this function gets
  // its first turn.  Check both sides of the cgroup/worker boundary: neither
  // the child cgroup nor its pre-exec launcher may be allocated once cleanup
  // owns the invocation.
  assertProviderLaunchStressAdmissionOpen('isolated output worker cgroup allocation');
  const cgroup = establishIsolatedOutputWorkerCgroup(input.launchCgroup);
  let child;
  try {
    assertProviderLaunchStressAdmissionOpen('isolated output worker allocation');
    child = spawn(
      'python3',
      [
        '-c',
        ISOLATED_OUTPUT_WORKER_LAUNCHER,
        cgroup.path,
        'unshare',
        '--user',
        '--map-root-user',
        '--mount',
        '--fork',
        '--',
        'python3',
        '-c',
        SEALED_PAYLOAD_LAUNCHER,
        input.executionPayload.root,
        process.execPath,
        input.vitestEntry,
        'run',
        '--maxWorkers=1',
        '--pool=threads',
        '--poolOptions.threads.singleThread=true',
        'test/main/services/team/ProviderLaunchStress.live-e2e.test.ts',
      ],
      {
        cwd: input.cwd,
        // Electron's executable otherwise starts a GUI process instead of
        // evaluating Vitest. Set this only for the isolated output worker;
        // the wrapper and its authority siblings retain their native mode.
        env: { ...input.env, ELECTRON_RUN_AS_NODE: '1' },
        // FD 3 is a one-byte launch receipt until the sealed-payload launcher
        // deliberately replaces it with its read-only capability memfd. FD 4
        // remains the wrapper-opened no-follow provider working-directory lease.
        stdio: ['ignore', 'inherit', 'inherit', 'pipe', input.projectDirectoryCapabilityFd],
      }
    );
    isolatedOutputWorker = child;
    isolatedOutputWorkerCgroup = cgroup;
    await readIsolatedOutputWorkerReady(child, cgroup);
    const exit = await waitForIsolatedOutputWorkerExit(child);
    if (exit.timedOut) {
      await killAndReapIsolatedOutputWorker(child, cgroup);
      return {
        status: null,
        error: new Error(
          `isolated output worker exceeded ${ISOLATED_OUTPUT_WORKER_TIMEOUT_MS}ms and its cgroup subtree was killed`
        ),
      };
    }
    // The worker's direct child has been reaped by the exit event above. A
    // clean direct exit is insufficient when a forked or setsid descendant
    // remains, so drain the exact child cgroup before reporting completion.
    try {
      assertDedicatedLaunchCgroupDrained(cgroup);
    } catch {
      await killAndReapIsolatedOutputWorker(child, cgroup);
      return {
        status: null,
        error: new Error('isolated output worker exited with surviving descendants; cgroup subtree was killed'),
      };
    }
    if (exit.signal !== null) {
      return {
        status: null,
        error: new Error(`isolated output worker exited by ${exit.signal}`),
      };
    }
    return { status: exit.code, error: null };
  } catch (error) {
    if (child) {
      try {
        await killAndReapIsolatedOutputWorker(child, cgroup);
      } catch (cleanupError) {
        return {
          status: null,
          error: new Error(
            `isolated output worker failed and its process tree could not be reaped: ${compactOutput(cleanupError?.message || cleanupError)}`,
            { cause: error }
          ),
        };
      }
    }
    return {
      status: null,
      error: error instanceof Error ? error : new Error(String(error)),
    };
  } finally {
    if (isolatedOutputWorker === child) {
      isolatedOutputWorker = undefined;
      isolatedOutputWorkerCgroup = undefined;
    }
  }
}

function establishIsolatedOutputWorkerCgroup(launchCgroup) {
  const name = `output-worker-${crypto.randomBytes(12).toString('hex')}`;
  const outputPath = path.join(launchCgroup.path, name);
  fs.mkdirSync(outputPath, { mode: 0o700 });
  try {
    const stat = fs.statSync(outputPath, { bigint: true });
    if (!stat.isDirectory()) throw new Error('isolated output worker cgroup is not a directory');
    return {
      path: outputPath,
      parentPath: launchCgroup.path,
      mountPath: launchCgroup.mountPath,
      relativePath: `${launchCgroup.relativePath}/${name}`,
      dev: String(stat.dev),
      ino: String(stat.ino),
    };
  } catch (error) {
    try {
      fs.rmdirSync(outputPath);
    } catch {
      /* the launch-cgroup teardown will fail closed if this subtree remains */
    }
    throw error;
  }
}

function readIsolatedOutputWorkerReady(child, cgroup) {
  return new Promise((resolve, reject) => {
    const stream = child.stdio[3];
    if (!stream) {
      reject(new Error('isolated output worker has no launch-receipt pipe'));
      return;
    }
    let output = '';
    const timeout = setTimeout(
      () => reject(new Error('isolated output worker did not join its cgroup before the deadline')),
      ISOLATED_OUTPUT_WORKER_READY_TIMEOUT_MS
    );
    const finish = (callback) => (...args) => {
      clearTimeout(timeout);
      stream.removeAllListeners();
      child.removeListener('error', onError);
      child.removeListener('exit', onExit);
      callback(...args);
    };
    const onError = finish(reject);
    const onExit = finish((code, signal) =>
      reject(new Error(`isolated output worker exited before cgroup readiness (${code ?? signal ?? 'unknown'})`))
    );
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      output += chunk;
      if (!output.includes('\n')) return;
      finish(() => {
        if (output !== 'joined\n') {
          reject(new Error('isolated output worker emitted an invalid cgroup launch receipt'));
          return;
        }
        try {
          const relativePath = readUnifiedCgroupRelativePathForProcess(child.pid);
          if (relativePath !== cgroup.relativePath) {
            throw new Error('isolated output worker did not enter its dedicated cgroup');
          }
          resolve(undefined);
        } catch (error) {
          reject(error);
        }
      })();
    });
    child.once('error', onError);
    child.once('exit', onExit);
  });
}

function waitForIsolatedOutputWorkerExit(child) {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve({ code: child.exitCode, signal: child.signalCode, timedOut: false });
      return;
    }
    const timeout = setTimeout(
      () => resolve({ code: null, signal: null, timedOut: true }),
      ISOLATED_OUTPUT_WORKER_TIMEOUT_MS
    );
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal, timedOut: false });
    });
  });
}

async function killAndReapIsolatedOutputWorker(child, cgroup) {
  // The root worker has already written its cgroup receipt before this path
  // is usable. cgroup.kill reaches forked, reparented, and setsid descendants
  // alike; then waiting for the direct child exit reaps the only child owned
  // by this wrapper instead of treating a sent signal as a completed cleanup.
  drainDedicatedLaunchCgroupSubtree(cgroup);
  if (child.exitCode !== null || child.signalCode !== null) return;
  // A readiness failure can occur before the tiny pre-exec launcher has
  // written its cgroup receipt. The direct ChildProcess handle is still
  // authoritative for that one root, so kill it as well rather than waiting
  // for an empty child cgroup while an unadmitted launcher survives.
  if (!child.kill('SIGKILL')) {
    throw new Error('isolated output worker root could not receive SIGKILL');
  }
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error('isolated output worker root was not reaped after cgroup kill')),
      ISOLATED_OUTPUT_WORKER_REAP_TIMEOUT_MS
    );
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('exit', () => {
      clearTimeout(timeout);
      resolve(undefined);
    });
  });
}

async function verifyFinalAuthenticatedAccountingSnapshot(capability) {
  const nonce = crypto.randomBytes(32).toString('hex');
  const responseLine = await new Promise((resolve, reject) => {
    const socket = net.createConnection(capability.endpoint);
    let received = '';
    socket.setEncoding('utf8');
    socket.setTimeout(5_000);
    socket.once('connect', () => socket.write(`finalize ${nonce}\n`));
    socket.on('data', (chunk) => {
      received += chunk;
      const newline = received.indexOf('\n');
      if (newline < 0) return;
      socket.end();
      resolve(received.slice(0, newline));
    });
    socket.once('timeout', () => reject(new Error('collector final snapshot timed out')));
    socket.once('error', reject);
  });
  const response = JSON.parse(responseLine);
  if (typeof response?.payload !== 'string' || typeof response?.signature !== 'string')
    throw new Error('collector omitted its final signed snapshot');
  if (!crypto.verify(null, Buffer.from(response.payload), capability.publicKey, Buffer.from(response.signature, 'base64')))
    throw new Error('collector final snapshot signature is invalid');
  const payload = JSON.parse(response.payload);
  if (
    payload?.version !== 1 ||
    payload.collectorId !== capability.collectorId ||
    payload.nonce !== nonce ||
    payload.sealed !== true ||
    payload?.ledger?.dev !== capability.ledger.dev ||
    payload?.ledger?.ino !== capability.ledger.ino ||
    payload?.provenance?.dev !== capability.provenance.dev ||
    payload?.provenance?.ino !== capability.provenance.ino ||
    payload?.provenance?.sha256 !== capability.provenance.sha256 ||
    payload?.terminalAcknowledgement?.version !== 1 ||
    payload.terminalAcknowledgement?.producerTerminal !== true ||
    payload.terminalAcknowledgement?.noWritableProducerDescriptor !== true ||
    payload.terminalAcknowledgement?.ledgerSha256 !== payload?.ledger?.sha256 ||
    payload?.baseline?.accepted !== true ||
    !SHA256_RE.test(payload.baseline?.ledgerSha256 ?? '') ||
    !Number.isSafeInteger(payload.baseline?.receiptCount) ||
    !Number.isSafeInteger(payload.baseline?.settlementCount) ||
    !Number.isSafeInteger(payload.baseline?.providerSettlementCount) ||
    !Number.isSafeInteger(payload.baseline?.credentialLockSettlementCount) ||
    payload.baseline.providerSettlementCount !== REQUIRED_PROVIDER_ORDER.length ||
    payload.baseline.credentialLockSettlementCount !== REQUIRED_PROVIDER_ORDER.length ||
    payload.baseline.settlementCount !==
      payload.baseline.providerSettlementCount + payload.baseline.credentialLockSettlementCount ||
    !SHA256_RE.test(payload.baseline?.identityDigest ?? '') ||
    payload?.ledger?.sha256 !== payload.baseline.ledgerSha256 ||
    payload?.finalReconciliation?.baselineLedgerSha256 !== payload.baseline.ledgerSha256 ||
    payload?.finalReconciliation?.baselineReceiptCount !== payload.baseline.receiptCount ||
    payload?.finalReconciliation?.baselineSettlementCount !== payload.baseline.settlementCount ||
    payload?.finalReconciliation?.baselineProviderSettlementCount !==
      payload.baseline.providerSettlementCount ||
    payload?.finalReconciliation?.baselineCredentialLockSettlementCount !==
      payload.baseline.credentialLockSettlementCount ||
    payload?.finalReconciliation?.baselineIdentityDigest !== payload.baseline.identityDigest ||
    payload?.finalReconciliation?.finalIdentityDigest !== payload.baseline.identityDigest ||
    !Number.isSafeInteger(payload.terminalAcknowledgement?.finalSequence) ||
    typeof payload.terminalAcknowledgement?.payload !== 'string' ||
    typeof payload.terminalAcknowledgement?.signature !== 'string' ||
    !crypto.verify(
      null,
      Buffer.from(payload.terminalAcknowledgement.payload),
      capability.producer?.publicKey,
      Buffer.from(payload.terminalAcknowledgement.signature, 'base64')
    ) ||
    typeof payload.receipts !== 'string'
  ) {
    throw new Error('collector final snapshot does not match its pinned provenance');
  }
  let acknowledgement;
  try {
    acknowledgement = JSON.parse(payload.terminalAcknowledgement.payload);
  } catch {
    throw new Error('collector terminal acknowledgement is malformed');
  }
  if (
    acknowledgement?.version !== 1 ||
    acknowledgement.producerId !== capability.producer?.id ||
    acknowledgement.nonce !== nonce ||
    acknowledgement.ledgerSha256 !== payload.ledger.sha256 ||
    acknowledgement.producerTerminal !== true ||
    acknowledgement.noWritableProducerDescriptor !== true ||
    acknowledgement.finalSequence !== payload.terminalAcknowledgement.finalSequence ||
    payload.terminalAcknowledgement.settlementCount !== payload.baseline.settlementCount ||
    payload.terminalAcknowledgement.providerSettlementCount !== payload.baseline.providerSettlementCount ||
    payload.terminalAcknowledgement.credentialLockSettlementCount !==
      payload.baseline.credentialLockSettlementCount
  ) {
    throw new Error('collector terminal acknowledgement does not bind the sealed ledger');
  }
}

async function stopAuthenticatedAccountingCollector(collector) {
  try {
    await terminateAndReapAccountingChild(collector.process, 'accounting collector', true);
    await terminateAndReapAccountingChild(collector.producer, 'accounting producer', true);
  } catch (error) {
    // A failed orderly shutdown must not strand either sibling. Both calls
    // are bounded and reap their owned handles before this failure escapes.
    await Promise.allSettled([
      terminateAndReapAccountingChild(collector.process, 'accounting collector', false),
      terminateAndReapAccountingChild(collector.producer, 'accounting producer', false),
    ]);
    throw error;
  }
  // The collector has closed the listener before exiting.  A surviving socket
  // would mean a late observer can still read a mutable ledger after success.
  if (fs.existsSync(collector.socketPath)) {
    throw new Error('accounting collector listener survived its orderly shutdown');
  }
  fs.rmdirSync(collector.socketDir);
}

// `exit` handlers cannot await a ChildProcess exit event. Every intentional
// failure after collector allocation must therefore arrive here first, while
// the event loop is still live. This also makes the early bootstrap cleanup
// registration safe to supersede: it is no longer responsible for reaping a
// collector/producer pair with an inherited listener or ledger descriptor.
async function failClosedProviderLaunchStress(message) {
  failureCleanupInProgress = true;
  console.error(message);
  try {
    await cleanupProviderLaunchStress('fail-closed bootstrap or runtime error');
  } catch (error) {
    console.error(
      `Provider launch stress could not complete fail-closed cleanup: ${compactOutput(error?.message || error)}`
    );
  }
  process.exitCode = 1;
  // Callers intentionally do not continue after a failed allocation. Throwing
  // lets top-level await unwind naturally, unlike process.exit(), which would
  // cut short socket closure, child reaping, and cgroup release.
  throw new Error(message);
}

async function cleanupProviderLaunchStress(reason) {
  if (providerLaunchStressCleanupPromise) return providerLaunchStressCleanupPromise;
  providerLaunchStressCleanupPromise = (async () => {
    const failures = [];
    const recordFailure = (label, error) => {
      failures.push(`${label}: ${compactOutput(error?.message || error)}`);
    };

    // The output worker is inside the cgroup, while collector/producer are
    // intentionally siblings. Reap both classes before moving this wrapper
    // back to the parent cgroup and deleting its kernel ownership boundary.
    if (isolatedOutputWorker && isolatedOutputWorkerCgroup) {
      try {
        await killAndReapIsolatedOutputWorker(isolatedOutputWorker, isolatedOutputWorkerCgroup);
      } catch (error) {
        recordFailure('isolated output worker reap', error);
      }
    }
    if (capabilityAttestor) {
      try {
        await terminateAndReapAccountingChild(
          capabilityAttestor.process,
          'capability attestor',
          false
        );
        fs.rmSync(capabilityAttestor.directory, { recursive: true, force: true });
      } catch (error) {
        recordFailure('capability attestor reap', error);
      }
    }
    if (accountingCollector && !accountingCollectorStopped) {
      const results = await Promise.allSettled([
        terminateAndReapAccountingChild(accountingCollector.process, 'accounting collector', false),
        terminateAndReapAccountingChild(accountingCollector.producer, 'accounting producer', false),
      ]);
      const rejected = results.find((result) => result.status === 'rejected');
      accountingCollectorStopped = !rejected;
      try {
        fs.rmSync(accountingCollector.socketDir, { recursive: true, force: true });
      } catch (error) {
        recordFailure('accounting collector socket directory removal', error);
      }
      if (rejected) recordFailure('accounting sibling reap', rejected.reason);
    }
    if (launchCgroup) {
      try {
        // releaseDedicatedLaunchCgroup first moves this wrapper out, then
        // kills/drains every nested cgroup and removes the exact inode.
        releaseDedicatedLaunchCgroup(launchCgroup);
      } catch (error) {
        recordFailure('dedicated launch cgroup release', error);
      }
    }
    if (disposableRunProject && !preserveRunEvidence) {
      try {
        if (!scrubCopiedProviderCredentialsBeforeEvidence()) {
          credentialScrubFailureDetected = true;
          throw new Error('copied provider credentials could not be scrubbed');
        }
        if (!eraseCredentialBearingDisposableRunRoot(disposableRunProject)) {
          throw new Error('credential-bearing disposable run root could not be erased');
        }
        disposableRunRoot = '';
      } catch (error) {
        recordFailure('credential-bearing disposable root cleanup', error);
      }
    } else if (disposableRunProject) {
      // Retained failure evidence is permissible only after its credentials
      // have been erased; never let a signal turn a retained root into a
      // credential backup.
      try {
        if (!scrubCopiedProviderCredentialsBeforeEvidence()) {
          credentialScrubFailureDetected = true;
          preserveRunEvidence = false;
          if (!eraseCredentialBearingDisposableRunRoot(disposableRunProject)) {
            throw new Error('credential-bearing retained run root could not be erased');
          }
          disposableRunRoot = '';
        }
      } catch (error) {
        recordFailure('retained evidence credential scrub', error);
      }
    }
    if (immutableExecutionPayload && !preserveRunEvidence) {
      try {
        restoreVerifiedReleaseDirectoryWritePermissions(immutableExecutionPayload);
        tombstoneOwnedDirectory(
          immutableExecutionPayload.root,
          immutableExecutionPayload.rootDev,
          immutableExecutionPayload.rootIno
        );
        immutableExecutionPayload = null;
      } catch (error) {
        recordFailure('immutable release payload cleanup', error);
      }
    }
    for (const [label, fd] of [
      ['capability', capabilityFd],
      ['wrapper process', wrapperProcFd],
      ['capability issuer', capabilityIssuerFd],
    ]) {
      if (!Number.isInteger(fd)) continue;
      try {
        fs.closeSync(fd);
      } catch (error) {
        // An already-closed descriptor is expected on a partial bootstrap.
        if (error?.code !== 'EBADF') recordFailure(`${label} descriptor close`, error);
      }
    }
    if (capabilityDir) {
      try {
        fs.rmSync(capabilityDir, { recursive: true, force: true });
      } catch (error) {
        recordFailure('capability directory cleanup', error);
      }
    }
    if (failures.length) {
      throw new Error(`${reason}: ${failures.join('; ')}`);
    }
    providerLaunchStressAsyncCleanupComplete = true;
  })();
  return providerLaunchStressCleanupPromise;
}

async function terminateAndReapAccountingChild(child, label, requireCleanExit) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const waitForExit = (timeoutMs) =>
    new Promise((resolve, reject) => {
      // A child can exit in the tiny interval between kill() and listener
      // registration. Read the authoritative handle first so cleanup never
      // waits for an event that has already been delivered.
      if (child.exitCode !== null || child.signalCode !== null) {
        if (requireCleanExit && (child.exitCode !== 0 || child.signalCode !== null)) {
          reject(
            new Error(`${label} exited unsuccessfully (${child.exitCode ?? child.signalCode ?? 'unknown'})`)
          );
        } else {
          resolve(undefined);
        }
        return;
      }
      const timeout = setTimeout(
        () => reject(new Error(`${label} was not reaped within ${timeoutMs}ms`)),
        timeoutMs
      );
      child.once('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.once('exit', (code, signal) => {
        clearTimeout(timeout);
        if (requireCleanExit && (code !== 0 || signal !== null)) {
          reject(new Error(`${label} exited unsuccessfully (${code ?? signal ?? 'unknown'})`));
        } else {
          resolve(undefined);
        }
      });
    });
  try {
    if (!child.kill('SIGTERM')) throw new Error(`${label} could not receive SIGTERM`);
    await waitForExit(5_000);
  } catch (error) {
    // A signal is not cleanup evidence. Escalate and wait for the exact
    // ChildProcess handle so all startup/failure paths have a finite reap.
    if (child.exitCode === null && child.signalCode === null) {
      try {
        child.kill('SIGKILL');
      } catch {
        // The handle may have exited in the SIGTERM race; wait below decides.
      }
      await waitForExit(5_000);
    }
    if (requireCleanExit) throw error;
  }
}

async function startCapabilityAttestationService(input) {
  const { identity } = input;
  const privateKeyPath = path.join(identity.directory, 'signing-key');
  fs.writeFileSync(
    privateKeyPath,
    identity.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    { mode: 0o600 }
  );
  const privateKeyFd = fs.openSync(privateKeyPath, 'r');
  fs.unlinkSync(privateKeyPath);
  assertProviderLaunchStressAdmissionOpen('capability attestor sibling process allocation');
  const child = spawn(
    'unshare',
    [
      ...COLLECTOR_NAMESPACE_ARGS,
      '--',
      process.execPath,
      process.argv[1],
      '--provider-launch-stress-capability-attestor',
    ],
    {
      env: {
        PROVIDER_LAUNCH_STRESS_CAPABILITY_ATTESTOR_SOCKET: identity.socketPath,
        PROVIDER_LAUNCH_STRESS_CAPABILITY_ATTESTOR_ID: identity.id,
        PROVIDER_LAUNCH_STRESS_CAPABILITY_ATTESTOR_PUBLIC_KEY: identity.publicKey,
        PROVIDER_LAUNCH_STRESS_WRAPPER_IDENTITY: input.wrapperIdentity,
        PROVIDER_LAUNCH_STRESS_WRAPPER_TRUST_ANCHOR: input.wrapperTrustAnchor,
        PROVIDER_LAUNCH_STRESS_WRAPPER_PID: String(input.wrapperPid),
        PROVIDER_LAUNCH_STRESS_WRAPPER_START_TICKS: input.wrapperStartTicks,
        PROVIDER_LAUNCH_STRESS_WRAPPER_SCRIPT_PATH: input.wrapperScriptPath,
        PROVIDER_LAUNCH_STRESS_WRAPPER_SCRIPT_SHA256: input.wrapperScriptSha256,
        PROVIDER_LAUNCH_STRESS_CAPABILITY_ATTESTOR_CGROUP: JSON.stringify({
          mountPath: input.launchCgroup.mountPath,
          relativePath: input.launchCgroup.relativePath,
          dev: input.launchCgroup.dev,
          ino: input.launchCgroup.ino,
        }),
      },
      stdio: [
        'ignore',
        'pipe',
        'inherit',
        input.capabilityFd,
        privateKeyFd,
        input.capabilityIssuerFd,
        input.wrapperProcFd,
      ],
    }
  );
  // Publish ownership before the first readiness await. A SIGINT/SIGTERM can
  // otherwise land after spawn but before this async factory returns, leaving
  // the signal wrapper no authoritative handle to reap.
  const attestor = {
    process: child,
    directory: identity.directory,
    socketPath: identity.socketPath,
    publicKey: identity.publicKey,
    id: identity.id,
  };
  capabilityAttestor = attestor;
  try {
    // The attestor is authority, not a launch descendant. Move it back to the
    // wrapper's parent cgroup before it begins serving so cgroup teardown of a
    // provider cannot kill or replace the verification channel.
    fs.writeFileSync(path.join(input.launchCgroup.parentPath, 'cgroup.procs'), `${child.pid}\n`, {
      encoding: 'utf8',
    });
    assertProcessOutsideDedicatedLaunchCgroup(child.pid, input.launchCgroup);
    const ready = await readCapabilityAttestorReady(child, identity.socketPath);
    if (ready?.version !== 1 || ready.id !== identity.id) {
      throw new Error('capability attestor returned malformed readiness evidence');
    }
    return attestor;
  } catch (error) {
    // Attestor readiness is an allocation boundary too. Do not leave its
    // private signer process or socket behind when bootstrap/authentication
    // fails before the caller can install normal shutdown ownership.
    await terminateAndReapAccountingChild(child, 'capability attestor', false);
    try {
      fs.rmSync(identity.directory, { recursive: true, force: true });
    } catch {
      /* startup failure is reported below */
    }
    throw error;
  } finally {
    fs.closeSync(privateKeyFd);
  }
}

function createCapabilityAttestationIdentity() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-launch-stress-attestor-'));
  return {
    privateKey,
    publicKey: publicKeyPem,
    id: crypto.createHash('sha256').update(publicKeyPem).digest('hex'),
    directory,
    socketPath: path.join(directory, 'attestor.sock'),
  };
}

function readCapabilityAttestorReady(child, socketPath) {
  return new Promise((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(
      () => reject(new Error('capability attestor readiness timed out')),
      5_000
    );
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      output += chunk;
      const line = output.indexOf('\n');
      if (line < 0) return;
      clearTimeout(timeout);
      try {
        if (!fs.existsSync(socketPath)) throw new Error('capability attestor socket was not created');
        resolve(JSON.parse(output.slice(0, line)));
      } catch (error) {
        reject(error);
      }
    });
    child.once('exit', (code) => {
      if (!output.includes('\n')) {
        clearTimeout(timeout);
        reject(new Error(`capability attestor exited before readiness (${code ?? 'signal'})`));
      }
    });
  });
}

async function stopCapabilityAttestationService(attestor) {
  const child = attestor.process;
  if (child.exitCode !== null || child.signalCode !== null) {
    throw new Error('capability attestor exited before orderly shutdown');
  }
  const exited = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('capability attestor did not exit')), 5_000);
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timeout);
      if (code === 0 && signal === null) resolve(undefined);
      else reject(new Error(`capability attestor exited unsuccessfully (${code ?? signal ?? 'unknown'})`));
    });
  });
  if (!child.kill('SIGTERM')) throw new Error('capability attestor could not receive SIGTERM');
  await exited;
  if (fs.existsSync(attestor.socketPath)) {
    throw new Error('capability attestor listener survived its orderly shutdown');
  }
  fs.rmdirSync(attestor.directory);
}

async function runCapabilityAttestationService() {
  const capabilityFd = 3;
  const privateKeyFd = 4;
  const issuerFd = 5;
  const wrapperProcFd = 6;
  const socketPath = process.env.PROVIDER_LAUNCH_STRESS_CAPABILITY_ATTESTOR_SOCKET;
  const id = process.env.PROVIDER_LAUNCH_STRESS_CAPABILITY_ATTESTOR_ID;
  const publicKey = process.env.PROVIDER_LAUNCH_STRESS_CAPABILITY_ATTESTOR_PUBLIC_KEY;
  const wrapperIdentity = process.env.PROVIDER_LAUNCH_STRESS_WRAPPER_IDENTITY;
  const wrapperTrustAnchor = process.env.PROVIDER_LAUNCH_STRESS_WRAPPER_TRUST_ANCHOR;
  const wrapperPid = Number(process.env.PROVIDER_LAUNCH_STRESS_WRAPPER_PID);
  const wrapperStartTicks = process.env.PROVIDER_LAUNCH_STRESS_WRAPPER_START_TICKS;
  const wrapperScriptPath = process.env.PROVIDER_LAUNCH_STRESS_WRAPPER_SCRIPT_PATH;
  const wrapperScriptSha256 = process.env.PROVIDER_LAUNCH_STRESS_WRAPPER_SCRIPT_SHA256;
  const serializedCgroup = process.env.PROVIDER_LAUNCH_STRESS_CAPABILITY_ATTESTOR_CGROUP;
  if (
    !socketPath ||
    !id ||
    !publicKey ||
    !publicKey.includes('BEGIN PUBLIC KEY') ||
    crypto.createHash('sha256').update(publicKey).digest('hex') !== id ||
    !wrapperIdentity ||
    !wrapperTrustAnchor ||
    !Number.isSafeInteger(wrapperPid) ||
    wrapperPid <= 1 ||
    !wrapperStartTicks ||
    !wrapperScriptPath ||
    !SHA256_RE.test(wrapperScriptSha256 ?? '') ||
    !serializedCgroup
  ) {
    throw new Error('capability attestor bootstrap metadata is unavailable');
  }
  const capability = readBoundedReleaseDescriptor(
    capabilityFd,
    verifyUnlinkedReadOnlyCollectorDescriptor(capabilityFd, 'capability attestation payload').size
  ).toString('base64');
  const issuer = readBoundedReleaseDescriptor(
    issuerFd,
    verifyUnlinkedReadOnlyCollectorDescriptor(issuerFd, 'capability attestation issuer').size
  ).toString('base64');
  const privateKey = readBoundedReleaseDescriptor(
    privateKeyFd,
    verifyUnlinkedReadOnlyCollectorDescriptor(privateKeyFd, 'capability attestation key').size
  ).toString('utf8');
  let cgroup;
  let capabilityEnvelope;
  let capabilityIssuer;
  try {
    cgroup = JSON.parse(serializedCgroup);
    capabilityEnvelope = JSON.parse(Buffer.from(capability, 'base64').toString('utf8'));
    capabilityIssuer = JSON.parse(Buffer.from(issuer, 'base64').toString('utf8'));
  } catch {
    throw new Error('capability attestor received malformed wrapper bootstrap evidence');
  }
  if (
    !capabilityIssuer ||
    capabilityIssuer.version !== 1 ||
    capabilityIssuer.id !== capabilityEnvelope?.issuerId ||
    typeof capabilityIssuer.publicKey !== 'string' ||
    typeof capabilityEnvelope?.payload !== 'string' ||
    typeof capabilityEnvelope?.signature !== 'string' ||
    !crypto.verify(
      null,
      Buffer.from(capabilityEnvelope.payload),
      capabilityIssuer.publicKey,
      Buffer.from(capabilityEnvelope.signature, 'base64')
    )
  ) {
    throw new Error('capability attestor could not authenticate wrapper capability evidence');
  }
  const capabilityPayload = JSON.parse(capabilityEnvelope.payload);
  if (
    capabilityPayload?.wrapperIdentity !== wrapperIdentity ||
    capabilityPayload?.wrapperTrustAnchor !== wrapperTrustAnchor ||
    capabilityPayload?.wrapperScriptSha256 !== wrapperScriptSha256 ||
    capabilityPayload?.cgroup?.mountPath !== cgroup?.mountPath ||
    capabilityPayload?.cgroup?.relativePath !== cgroup?.relativePath ||
    capabilityPayload?.cgroup?.dev !== cgroup?.dev ||
    capabilityPayload?.cgroup?.ino !== cgroup?.ino
  ) {
    throw new Error('capability attestor cgroup receipt does not match wrapper capability');
  }
  if (
    capabilityPayload?.issuer?.version !== 1 ||
    capabilityPayload.issuer.id !== capabilityIssuer.id ||
    capabilityPayload.issuer.publicKey !== capabilityIssuer.publicKey ||
    capabilityPayload?.attestor?.id !== id ||
    capabilityPayload.attestor.publicKey !== publicKey ||
    capabilityPayload.attestor.endpoint !== socketPath
  ) {
    throw new Error('capability attestor identity is not bound by the launcher capability');
  }
  // Authorization is bound to this inherited, wrapper-owned proc descriptor.
  // `/proc/<pid>/cmdline` is deliberately never consulted: argv is chosen by
  // the invoking process and an attacker can forge a plausible ancestor
  // command line. The descriptor was opened by the already-running wrapper,
  // carried privately into this isolated attestor, and is checked against the
  // issuer-signed capability before the attestor will sign for a worker.
  const launcher = capabilityPayload?.launcher;
  const launcherStat = fs.fstatSync(wrapperProcFd, { bigint: true });
  const liveWrapperIdentity = readLinuxProcessIdentity(`/proc/self/fd/${wrapperProcFd}`);
  if (
    !launcher ||
    launcher.pid !== liveWrapperIdentity?.pid ||
    launcher.startTicks !== liveWrapperIdentity?.startTicks ||
    launcher.procDev !== String(launcherStat.dev) ||
    launcher.procIno !== String(launcherStat.ino) ||
    liveWrapperIdentity.pid !== wrapperPid ||
    liveWrapperIdentity.startTicks !== wrapperStartTicks
  ) {
    throw new Error('capability attestor lost the wrapper launcher capability');
  }
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    let request = '';
    socket.setEncoding('utf8');
    socket.once('data', async (chunk) => {
      request += chunk;
      const match = /^attest ([a-f0-9]{64})\n$/.exec(request);
      if (!match) return socket.destroy();
      const payload = JSON.stringify({
        version: 1,
        id,
        nonce: match[1],
        wrapperIdentity,
        wrapperTrustAnchor,
        wrapperPid,
        wrapperStartTicks,
        wrapperScriptSha256,
        cgroup,
        attestor: { id, publicKey, endpoint: socketPath },
        capability,
        issuer,
      });
      socket.end(
        `${JSON.stringify({ payload, signature: crypto.sign(null, Buffer.from(payload), privateKey).toString('base64') })}\n`
      );
    });
  });
  await new Promise((resolve, reject) => server.once('error', reject).listen(socketPath, resolve));
  fs.chmodSync(socketPath, 0o600);
  process.stdout.write(`${JSON.stringify({ version: 1, id })}\n`);
  await new Promise((resolve) => {
    const close = () => {
      for (const socket of sockets) socket.destroy();
      server.close(() => resolve(undefined));
    };
    process.once('SIGTERM', close);
    process.once('SIGINT', close);
  });
}

function establishDedicatedLaunchCgroup(input = {}) {
  const cgroupFs = input.fs ?? fs;
  const cgroupProcessId = input.processId ?? process.pid;
  const readRelativePath = input.readRelativePath ?? readUnifiedCgroupRelativePath;
  const findMountPath = input.findMountPath ?? findUnifiedCgroupMount;
  const relativePath = readRelativePath();
  const mountPath = findMountPath();
  if (!relativePath || !mountPath) {
    throw new Error('a mounted cgroup v2 hierarchy is unavailable');
  }
  const parentPath = path.join(mountPath, relativePath.replace(/^\//, ''));
  const name =
    input.name ?? `provider-launch-stress-${cgroupProcessId}-${crypto.randomBytes(12).toString('hex')}`;
  const cgroupPath = path.join(parentPath, name);
  let cgroup;
  let wrapperMayHaveJoined = false;
  try {
    const parent = cgroupFs.statSync(parentPath, { bigint: true });
    if (!parent.isDirectory()) throw new Error('dedicated cgroup parent is not a directory');
    cgroupFs.mkdirSync(cgroupPath, { mode: 0o700 });
    const stat = cgroupFs.statSync(cgroupPath, { bigint: true });
    if (!stat.isDirectory()) throw new Error('dedicated cgroup is not a directory');
    cgroup = {
      path: cgroupPath,
      mountPath,
      relativePath: `${relativePath.replace(/\/$/, '')}/${name}`,
      parentPath,
      parentRelativePath: relativePath,
      parentDev: String(parent.dev),
      parentIno: String(parent.ino),
      dev: String(stat.dev),
      ino: String(stat.ino),
    };
    // Publish the exact object before cgroup.procs can move this wrapper.
    // A later receipt/stat failure must remain visible to the shared cleanup
    // owner instead of stranding a joined wrapper behind an unassigned local.
    launchCgroup = cgroup;
    // cgroup.procs is the kernel launch receipt: write before *any* child is
    // started, then verify the wrapper is a member of the exact inode.
    // Treat a throwing write as potentially admitted too: the kernel may have
    // consumed the PID before userspace reports a later write-side failure.
    wrapperMayHaveJoined = true;
    cgroupFs.writeFileSync(path.join(cgroupPath, 'cgroup.procs'), `${cgroupProcessId}\n`, {
      encoding: 'utf8',
    });
    const admitted = cgroupFs.statSync(cgroupPath, { bigint: true });
    if (
      !admitted.isDirectory() ||
      String(admitted.dev) !== cgroup.dev ||
      String(admitted.ino) !== cgroup.ino ||
      readRelativePath() !== cgroup.relativePath ||
      !cgroupFs
        .readFileSync(path.join(cgroupPath, 'cgroup.procs'), 'utf8')
        .split(/\s+/)
        .includes(String(cgroupProcessId))
    ) {
      throw new Error('wrapper was not admitted to the dedicated cgroup');
    }
    return cgroup;
  } catch (error) {
    // Once joined, cgroup rmdir is both invalid and unsafe until this wrapper
    // has returned to the exact parent it occupied before admission.  Keep
    // the published receipt on any recovery failure so fail-closed cleanup can
    // drain/remove the kernel-owned subtree rather than losing its authority.
    let restoredToVerifiedParent = !wrapperMayHaveJoined;
    if (cgroup && wrapperMayHaveJoined) {
      try {
        returnWrapperToVerifiedDedicatedLaunchCgroupParent(cgroup, {
          cgroupFs,
          cgroupProcessId,
          readRelativePath,
        });
        restoredToVerifiedParent = true;
      } catch {
        // Do not attempt rmdir while the wrapper may still be a member.
      }
    }
    if (cgroup && restoredToVerifiedParent) {
      try {
        cgroupFs.rmdirSync(cgroup.path);
        if (launchCgroup === cgroup) launchCgroup = undefined;
      } catch {
        // The published cgroup object remains cleanup-owned for a retry.
      }
    }
    throw error;
  }
}

function releaseDedicatedLaunchCgroup(cgroup) {
  const stat = fs.statSync(cgroup.path, { bigint: true });
  if (!stat.isDirectory() || String(stat.dev) !== cgroup.dev || String(stat.ino) !== cgroup.ino) {
    throw new Error('dedicated cgroup identity changed');
  }
  returnWrapperToVerifiedDedicatedLaunchCgroupParent(cgroup);
  drainDedicatedLaunchCgroupSubtree(cgroup);
  removeDedicatedLaunchCgroupSubtree(cgroup);
}

function returnWrapperToVerifiedDedicatedLaunchCgroupParent(
  cgroup,
  { cgroupFs = fs, cgroupProcessId = process.pid, readRelativePath = readUnifiedCgroupRelativePath } = {}
) {
  const parent = cgroupFs.statSync(cgroup.parentPath, { bigint: true });
  if (
    !parent.isDirectory() ||
    String(parent.dev) !== cgroup.parentDev ||
    String(parent.ino) !== cgroup.parentIno
  ) {
    throw new Error('dedicated cgroup parent identity changed');
  }
  cgroupFs.writeFileSync(path.join(cgroup.parentPath, 'cgroup.procs'), `${cgroupProcessId}\n`, {
    encoding: 'utf8',
  });
  const restored = cgroupFs.statSync(cgroup.parentPath, { bigint: true });
  if (
    !restored.isDirectory() ||
    String(restored.dev) !== cgroup.parentDev ||
    String(restored.ino) !== cgroup.parentIno ||
    readRelativePath() !== cgroup.parentRelativePath ||
    !cgroupFs
      .readFileSync(path.join(cgroup.parentPath, 'cgroup.procs'), 'utf8')
      .split(/\s+/)
      .includes(String(cgroupProcessId))
  ) {
    throw new Error('wrapper was not restored to its verified cgroup parent');
  }
}

function runDedicatedLaunchCgroupInitializationFaultFixture() {
  const fixturePid = 4242;
  const mountPath = '/fixture-cgroup';
  const parentRelativePath = '/fixture-parent';
  const parentPath = path.join(mountPath, parentRelativePath.slice(1));
  const name = 'provider-launch-stress-injected-fault';
  const cgroupPath = path.join(parentPath, name);
  const execute = (failRemoval) => {
    let currentRelativePath = parentRelativePath;
    let childExists = false;
    const operations = [];
    const fakeFs = {
      mkdirSync(target) {
        if (target !== cgroupPath) throw new Error('unexpected fixture cgroup mkdir');
        childExists = true;
      },
      statSync(target) {
        if (target === parentPath) return { isDirectory: () => true, dev: 71n, ino: 72n };
        if (target === cgroupPath && childExists)
          return { isDirectory: () => true, dev: 71n, ino: 73n };
        throw new Error('unexpected fixture cgroup stat');
      },
      writeFileSync(target, contents) {
        if (target === path.join(cgroupPath, 'cgroup.procs') && contents === `${fixturePid}\n`) {
          currentRelativePath = `${parentRelativePath}/${name}`;
          operations.push('joined');
          return;
        }
        if (target === path.join(parentPath, 'cgroup.procs') && contents === `${fixturePid}\n`) {
          currentRelativePath = parentRelativePath;
          operations.push('restored');
          return;
        }
        throw new Error('unexpected fixture cgroup write');
      },
      readFileSync(target) {
        if (target === path.join(cgroupPath, 'cgroup.procs')) {
          throw new Error('injected post-join cgroup receipt failure');
        }
        if (target === path.join(parentPath, 'cgroup.procs')) return `${fixturePid}\n`;
        throw new Error('unexpected fixture cgroup read');
      },
      rmdirSync(target) {
        if (target !== cgroupPath || currentRelativePath !== parentRelativePath) {
          throw new Error('fixture attempted cgroup removal before parent restoration');
        }
        operations.push('rmdir');
        if (failRemoval) throw new Error('injected cgroup rmdir failure');
        childExists = false;
      },
    };
    launchCgroup = undefined;
    try {
      establishDedicatedLaunchCgroup({
        fs: fakeFs,
        processId: fixturePid,
        readRelativePath: () => currentRelativePath,
        findMountPath: () => mountPath,
        name,
      });
      throw new Error('fixture expected post-join receipt failure');
    } catch (error) {
      if (!String(error?.message || error).includes('injected post-join')) throw error;
    }
    const ownershipExposed = failRemoval && launchCgroup?.path === cgroupPath;
    const result = {
      operations,
      returnedToParentBeforeRmdir:
        operations.indexOf('restored') >= 0 &&
        operations.indexOf('rmdir') > operations.indexOf('restored'),
      ownershipExposed,
    };
    launchCgroup = undefined;
    return result;
  };
  const removed = execute(false);
  const retained = execute(true);
  return {
    ok:
      removed.returnedToParentBeforeRmdir &&
      retained.returnedToParentBeforeRmdir &&
      retained.ownershipExposed,
    removed,
    retained,
  };
}

function assertDedicatedLaunchCgroupDrained(cgroup) {
  for (const group of listDedicatedLaunchCgroupSubtree(cgroup)) {
    const members = fs
      .readFileSync(path.join(group.path, 'cgroup.procs'), 'utf8')
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    const allowed =
      group.path === cgroup.path && readUnifiedCgroupRelativePath() === cgroup.relativePath
        ? String(process.pid)
        : null;
    if (members.some((pid) => pid !== allowed)) {
      throw new Error(
        `owned cgroup subtree is not empty at ${group.relativePath}: ${members.join(',')}`
      );
    }
  }
}

function listDedicatedLaunchCgroupSubtree(cgroup) {
  const root = fs.statSync(cgroup.path, { bigint: true });
  if (!root.isDirectory() || String(root.dev) !== cgroup.dev || String(root.ino) !== cgroup.ino) {
    throw new Error('dedicated cgroup identity changed');
  }
  const groups = [{ path: cgroup.path, relativePath: cgroup.relativePath }];
  for (let index = 0; index < groups.length; index += 1) {
    const parent = groups[index];
    for (const entry of fs.readdirSync(parent.path, { withFileTypes: true })) {
      // cgroup control files are regular files; only real cgroup directories
      // are descendants.  Refuse a symlink rather than following it outside
      // our kernel-owned tree.
      if (!entry.isDirectory()) continue;
      const childPath = path.join(parent.path, entry.name);
      const child = fs.lstatSync(childPath, { bigint: true });
      if (!child.isDirectory() || child.isSymbolicLink()) {
        throw new Error(`unsafe cgroup subtree entry: ${childPath}`);
      }
      groups.push({ path: childPath, relativePath: `${parent.relativePath}/${entry.name}` });
    }
  }
  return groups;
}

function drainDedicatedLaunchCgroupSubtree(cgroup) {
  const deadline = Date.now() + CGROUP_DRAIN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const groups = listDedicatedLaunchCgroupSubtree(cgroup).reverse();
    for (const group of groups) {
      const killPath = path.join(group.path, 'cgroup.kill');
      if (fs.existsSync(killPath)) fs.writeFileSync(killPath, '1\n', { encoding: 'utf8' });
    }
    try {
      assertDedicatedLaunchCgroupDrained(cgroup);
      return;
    } catch {
      // cgroup.kill is asynchronous; re-enumerate so a nested child cannot
      // remain invisible behind its parent's cgroup.procs file.
    }
  }
  assertDedicatedLaunchCgroupDrained(cgroup);
}

function removeDedicatedLaunchCgroupSubtree(cgroup) {
  const groups = listDedicatedLaunchCgroupSubtree(cgroup).sort(
    (left, right) => right.path.length - left.path.length
  );
  for (const group of groups) {
    fs.rmdirSync(group.path);
  }
}

async function startAuthenticatedAccountingCollector() {
  assertProviderLaunchStressAdmissionOpen('accounting collector sibling setup');
  // These are an admission-time ABI, not descriptor numbers nominated by the
  // command environment.  The launcher receives its pre-provisioned ledger,
  // provenance and independent authority on fixed inherited descriptors; a
  // task cannot redirect the accounting issuer merely by selecting different
  // FD numbers in an environment variable.
  const ledgerFd = 3;
  const provenanceFd = 4;
  const authorityFd = 5;
  for (const name of [
    'PROVIDER_LAUNCH_STRESS_ACCOUNTING_COLLECTOR_FD',
    'PROVIDER_LAUNCH_STRESS_ACCOUNTING_PROVENANCE_SOURCE_FD',
    'PROVIDER_LAUNCH_STRESS_ACCOUNTING_AUTHORITY_FD',
  ]) {
    const selected = process.env[name];
    if (selected !== undefined && selected !== String({
      PROVIDER_LAUNCH_STRESS_ACCOUNTING_COLLECTOR_FD: ledgerFd,
      PROVIDER_LAUNCH_STRESS_ACCOUNTING_PROVENANCE_SOURCE_FD: provenanceFd,
      PROVIDER_LAUNCH_STRESS_ACCOUNTING_AUTHORITY_FD: authorityFd,
    }[name])) {
      throw new Error(`${name} cannot select an accounting authority descriptor`);
    }
  }
  const ledger = verifyUnlinkedReadOnlyCollectorDescriptor(ledgerFd, 'accounting ledger');
  const provenance = verifyUnlinkedReadOnlyCollectorDescriptor(
    provenanceFd,
    'accounting provenance'
  );
  const authority = verifyUnlinkedReadOnlyCollectorDescriptor(
    authorityFd,
    'independent accounting authority'
  );
  let authorityRecord;
  try {
    authorityRecord = JSON.parse(readBoundedReleaseDescriptor(authorityFd, authority.size).toString('utf8'));
  } catch {
    throw new Error('independent accounting authority descriptor is not JSON');
  }
  if (!isAuthenticatedAccountingIssuer(authorityRecord)) {
    throw new Error('independent accounting authority is malformed');
  }
  const authorityId = crypto.createHash('sha256').update(authorityRecord.publicKey).digest('hex');
  if (authorityRecord.id !== authorityId) {
    throw new Error('independent accounting authority fingerprint is invalid');
  }
  const bytes = readBoundedReleaseDescriptor(provenanceFd, provenance.size);
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  let record;
  try {
    record = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error('accounting provenance descriptor is not JSON');
  }
  if (
    record?.version !== 2 ||
    record?.ledger?.dev !== ledger.dev ||
    record?.ledger?.ino !== ledger.ino ||
    !isAuthenticatedAccountingIssuer(record.issuer) ||
    typeof record.handoffPayload !== 'string' ||
    typeof record.handoffSignature !== 'string'
  ) {
    throw new Error('accounting provenance does not bind the collector ledger inode');
  }
  // The producer issuer is trusted only when it matches a third, separately
  // provisioned authority descriptor. Never let the provenance record or an
  // environment variable nominate the key that validates its own receipts.
  const trustedIssuerPublicKey = authorityRecord.publicKey;
  const expectedIssuerId = authorityId;
  if (
    record.issuer.id !== expectedIssuerId ||
    record.issuer.publicKey !== trustedIssuerPublicKey ||
    !crypto.verify(
      null,
      Buffer.from(record.handoffPayload),
      trustedIssuerPublicKey,
      Buffer.from(record.handoffSignature, 'base64')
    )
  ) {
    throw new Error('accounting provenance issuer handoff is not authenticated');
  }
  const handoff = JSON.parse(record.handoffPayload);
  if (
    handoff?.version !== 1 ||
    handoff.issuerId !== record.issuer.id ||
    handoff?.ledger?.dev !== ledger.dev ||
    handoff?.ledger?.ino !== ledger.ino
  ) {
    throw new Error('accounting provenance handoff does not bind this ledger');
  }
  // The worker must never inherit either descriptor.  Read-only inherited
  // descriptors are not isolation: a provider can reopen /proc/<parent>/fd
  // and ask the kernel for a fresh writable description.  Transfer the two
  // pinned descriptors to a sibling collector, close our copies before
  // Vitest starts, and expose only a signed read-only snapshot protocol.
  const socketDir = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-launch-stress-collector-'));
  const socketPath = path.join(socketDir, 'collector.sock');
  // The producer is a sibling authority. The collector may request terminal
  // state, but it cannot manufacture the producer's signed acknowledgement.
  const producerSocketPath = path.join(socketDir, 'producer.sock');
  const producerKeyPair = crypto.generateKeyPairSync('ed25519');
  const producerPublicKey = producerKeyPair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const producerId = crypto.createHash('sha256').update(producerPublicKey).digest('hex');
  const producerKeyPath = path.join(socketDir, 'producer-terminal-key');
  fs.writeFileSync(producerKeyPath, producerKeyPair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), { mode: 0o600 });
  const producerKeyFd = fs.openSync(producerKeyPath, 'r');
  fs.unlinkSync(producerKeyPath);
  // Only the producer receives a writable accounting description. The
  // collector's descriptor is observation-only, so it cannot forge the seal
  // acknowledgement or race a post-seal append.
  const producerLedgerFd = fs.openSync(`/proc/self/fd/${ledgerFd}`, 'r+');
  // Existing external writer descriptions retain their authority, but a fresh
  // /proc reopen by a worker now fails DAC even if a host does not enforce
  // ptrace_scope. The collector receives only observation descriptors.
  fs.fchmodSync(ledgerFd, 0o000);
  fs.fchmodSync(provenanceFd, 0o000);
  fs.fchmodSync(authorityFd, 0o000);
  let producer;
  let child;
  try {
    assertProviderLaunchStressAdmissionOpen('accounting producer sibling allocation');
  producer = spawn(
    'unshare',
    [...COLLECTOR_NAMESPACE_ARGS, '--', process.execPath, process.argv[1], '--provider-launch-stress-accounting-producer'],
    {
      env: {
        ...process.env,
        PROVIDER_LAUNCH_STRESS_PRODUCER_SOCKET: producerSocketPath,
        PROVIDER_LAUNCH_STRESS_PRODUCER_ID: producerId,
      },
      stdio: ['ignore', 'ignore', 'inherit', producerLedgerFd, producerKeyFd],
    }
  );
  fs.closeSync(producerKeyFd);
  fs.closeSync(producerLedgerFd);
  assertProviderLaunchStressAdmissionOpen('accounting collector sibling process allocation');
  child = spawn(
    'unshare',
    [
      ...COLLECTOR_NAMESPACE_ARGS,
      '--',
      process.execPath,
      process.argv[1],
      '--provider-launch-stress-accounting-collector',
    ],
    {
      env: {
        ...process.env,
        PROVIDER_LAUNCH_STRESS_COLLECTOR_SOCKET: socketPath,
        PROVIDER_LAUNCH_STRESS_PRODUCER_SOCKET: producerSocketPath,
        PROVIDER_LAUNCH_STRESS_PRODUCER_ID: producerId,
        PROVIDER_LAUNCH_STRESS_PRODUCER_PUBLIC_KEY: producerPublicKey,
      },
      stdio: ['ignore', 'pipe', 'inherit', ledgerFd, provenanceFd, authorityFd],
    }
  );
  // From this point the collector is the only process with these descriptor
  // capabilities.  This close is deliberately before any provider/worker is
  // spawned, not an exit-time best effort.
  fs.closeSync(ledgerFd);
  fs.closeSync(provenanceFd);
  fs.closeSync(authorityFd);
  // The collector was spawned before this wrapper joined its dedicated launch
  // cgroup.  Check the kernel receipt, rather than assuming spawn ordering,
  // so an implementation change cannot accidentally put an accounting
  // authority into the teardown kill set.
  assertCollectorOutsideLaunchCgroup(child.pid);
  // As with the attestor, publish both sibling handles before readiness can
  // yield to the event loop. Signal cleanup must cover this allocation window
  // rather than assuming the outer assignment has already completed.
  accountingCollector = {
    process: child,
    producer,
    socketDir,
    socketPath,
  };
  const ready = await readCollectorReady(child, socketPath);
  if (
    ready.version !== 1 ||
    typeof ready.collectorId !== 'string' ||
    !SHA256_RE.test(ready.collectorId) ||
    typeof ready.publicKey !== 'string' ||
    !ready.publicKey.includes('BEGIN PUBLIC KEY')
  ) {
    throw new Error('accounting collector did not establish authenticated provenance');
  }
  return {
    process: child,
    producer,
    socketDir,
    socketPath,
    capability: {
      collectorId: ready.collectorId.toLowerCase(),
      endpoint: socketPath,
      publicKey: ready.publicKey,
      ledger: { dev: ledger.dev, ino: ledger.ino },
      provenance: { dev: provenance.dev, ino: provenance.ino, sha256 },
      issuer: authorityRecord,
      producer: { id: producerId, publicKey: producerPublicKey },
    },
  };
  } catch (error) {
    // Collector/producer are allocated before the canary's worker cgroup and
    // must be owned immediately. A partial spawn, descriptor handoff, or
    // readiness failure therefore terminates and reaps both finite handles
    // before propagating the admission failure.
    await Promise.allSettled([
      terminateAndReapAccountingChild(child, 'partially initialized accounting collector', false),
      terminateAndReapAccountingChild(producer, 'partially initialized accounting producer', false),
    ]);
    try {
      fs.rmSync(socketDir, { recursive: true, force: true });
    } catch {
      /* the original initialization failure remains actionable */
    }
    throw error;
  }
}

function isAuthenticatedAccountingIssuer(value) {
  return (
    value &&
    typeof value === 'object' &&
    typeof value.id === 'string' &&
    SHA256_RE.test(value.id) &&
    typeof value.publicKey === 'string' &&
    value.publicKey.includes('BEGIN PUBLIC KEY') &&
    crypto.createHash('sha256').update(value.publicKey).digest('hex') === value.id
  );
}

function assertCollectorOutsideLaunchCgroup(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error('collector PID is unavailable');
  const relativePath = readUnifiedCgroupRelativePathForProcess(pid);
  if (!relativePath) throw new Error('collector cgroup receipt is unavailable');
  // At collector startup the wrapper is still in its parent cgroup. Equality
  // is the receipt that it was started as a sibling; the provider cgroup does
  // not exist until after this function returns.
  if (relativePath !== readUnifiedCgroupRelativePath())
    throw new Error('collector was not started in the wrapper parent cgroup');
}

function assertProcessOutsideDedicatedLaunchCgroup(pid, launchCgroup) {
  if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error('attestor PID is unavailable');
  const relativePath = readUnifiedCgroupRelativePathForProcess(pid);
  if (!relativePath || relativePath === launchCgroup.relativePath || relativePath.startsWith(`${launchCgroup.relativePath}/`)) {
    throw new Error('capability attestor remained inside the dedicated launch cgroup');
  }
}

function readUnifiedCgroupRelativePathForProcess(pid) {
  try {
    const line = fs
      .readFileSync(`/proc/${pid}/cgroup`, 'utf8')
      .split('\n')
      .find((entry) => entry.startsWith('0::'));
    return line?.slice(3).trim() || null;
  } catch {
    return null;
  }
}

function readCollectorReady(child, socketPath) {
  return new Promise((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(
      () => reject(new Error('accounting collector readiness timed out')),
      5_000
    );
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      output += chunk;
      const line = output.indexOf('\n');
      if (line < 0) return;
      clearTimeout(timeout);
      try {
        const ready = JSON.parse(output.slice(0, line));
        if (!fs.existsSync(socketPath)) throw new Error('collector socket was not created');
        resolve(ready);
      } catch (error) {
        reject(error);
      }
    });
    child.once('exit', (code) => {
      if (!output.includes('\n')) {
        clearTimeout(timeout);
        reject(new Error(`accounting collector exited before readiness (${code ?? 'signal'})`));
      }
    });
  });
}

async function runAuthenticatedAccountingCollector() {
  const ledgerFd = 3;
  const provenanceFd = 4;
  const authorityFd = 5;
  const socketPath = process.env.PROVIDER_LAUNCH_STRESS_COLLECTOR_SOCKET;
  const producerSocketPath = process.env.PROVIDER_LAUNCH_STRESS_PRODUCER_SOCKET;
  const producerId = process.env.PROVIDER_LAUNCH_STRESS_PRODUCER_ID;
  const producerPublicKey = process.env.PROVIDER_LAUNCH_STRESS_PRODUCER_PUBLIC_KEY;
  if (!socketPath) throw new Error('collector socket endpoint is unavailable');
  const ledger = verifyUnlinkedReadOnlyCollectorDescriptor(ledgerFd, 'accounting ledger');
  const provenance = verifyUnlinkedReadOnlyCollectorDescriptor(
    provenanceFd,
    'accounting provenance'
  );
  const provenanceBytes = readBoundedReleaseDescriptor(provenanceFd, provenance.size);
  const provenanceSha256 = crypto.createHash('sha256').update(provenanceBytes).digest('hex');
  const provenanceRecord = JSON.parse(provenanceBytes.toString('utf8'));
  if (!isAuthenticatedAccountingIssuer(provenanceRecord?.issuer))
    throw new Error('collector provenance has no authenticated issuer');
  const authority = verifyUnlinkedReadOnlyCollectorDescriptor(
    authorityFd,
    'independent accounting authority'
  );
  const authorityRecord = JSON.parse(
    readBoundedReleaseDescriptor(authorityFd, authority.size).toString('utf8')
  );
  if (
    !isAuthenticatedAccountingIssuer(authorityRecord) ||
    authorityRecord.id !== crypto.createHash('sha256').update(authorityRecord.publicKey).digest('hex') ||
    provenanceRecord.issuer.id !== authorityRecord.id ||
    provenanceRecord.issuer.publicKey !== authorityRecord.publicKey
  ) {
    throw new Error('collector provenance is not bound to its independent accounting authority');
  }
  const issuer = authorityRecord;
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const collectorId = crypto.createHash('sha256').update(publicPem).digest('hex');
  const sockets = new Set();
  let finalized = false;
  let acceptedBaseline = null;
  let listenerClosed = false;
  let ledgerClosed = false;
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    let request = '';
    socket.setEncoding('utf8');
    socket.once('data', async (chunk) => {
      request += chunk;
      const requestMatch = /^(snapshot|accept-baseline|finalize) ([a-f0-9]{64})\n$/.exec(request);
      const mode = requestMatch?.[1];
      const nonce = requestMatch?.[2];
      if (!nonce || !mode || (finalized && mode !== 'finalize')) return socket.destroy();
      try {
        let current = verifyUnlinkedReadOnlyCollectorDescriptor(ledgerFd, 'accounting ledger');
        if (current.dev !== ledger.dev || current.ino !== ledger.ino) {
          throw new Error('collector ledger inode changed');
        }
        let raw = readBoundedReleaseDescriptor(ledgerFd, current.size);
        let settlement = validateAuthenticatedProviderReceiptLedger(
          raw,
          issuer,
          mode === 'finalize' || mode === 'accept-baseline'
        );
        let ledgerSha256 = crypto.createHash('sha256').update(raw).digest('hex');
        let terminalAcknowledgement;
        let finalReconciliation = null;
        if (mode === 'accept-baseline') {
          if (acceptedBaseline) {
            throw new Error('accounting collector baseline was already accepted');
          }
          assertRequiredProviderAccountingCoverage(settlement);
          // The live proof accepts this only after it has checked every
          // provider effect. Retain the complete authenticated receipt order,
          // not merely a count: a signed append, duplicate, deletion, or
          // authority-effect reordering must fail the later sealed read.
          acceptedBaseline = Object.freeze({
            ledgerSha256,
            receiptCount: settlement.receiptCount,
            settlementCount: settlement.settlementCount,
            providerSettlementCount: settlement.providerSettlementCount,
            credentialLockSettlementCount: settlement.credentialLockSettlementCount,
            identities: Object.freeze([...settlement.receiptIdentities]),
          });
        }
        if (mode === 'finalize') {
          if (finalized) throw new Error('accounting collector was already finalized');
          if (!producerSocketPath || !producerId || !producerPublicKey) {
            throw new Error('collector producer terminal authority is unavailable');
          }
          finalized = true;
          // Stop accepting snapshot clients before returning the final signed
          // ledger. Existing sockets cannot hold the listener open or append a
          // fresh post-comparison observation.
          listenerClosed = true;
          server.close();
          // The collector requests terminal state from the separate producer;
          // it never self-asserts that producers have closed their writers.
          // Drop the collector's observation description first. The producer
          // can now acquire an exclusive kernel write lease only when every
          // other reader/writer has gone away; a writable description outside
          // the receipt-producing control path makes finalization fail.
          fs.closeSync(ledgerFd);
          ledgerClosed = true;
          const producerAcknowledgement = await requestProducerSealAcknowledgement({
            endpoint: producerSocketPath,
            nonce,
            producerId,
            publicKey: producerPublicKey,
          });
          raw = Buffer.from(producerAcknowledgement.receipts, 'base64');
          current = { ...ledger, size: raw.length };
          settlement = validateAuthenticatedProviderReceiptLedger(raw, issuer, true);
          ledgerSha256 = crypto.createHash('sha256').update(raw).digest('hex');
          if (!acceptedBaseline) {
            throw new Error('final sealed accounting ledger has no accepted proof baseline');
          }
          // Final acceptance has an independent exact-cardinality contract.
          // The prior baseline catches replacements; it does not define how
          // many provider effects a final ledger is allowed to contain.
          assertRequiredProviderAccountingCoverage(settlement);
          reconcileFinalSealedAccountingLedger(acceptedBaseline, settlement);
          finalReconciliation = {
            baselineLedgerSha256: acceptedBaseline.ledgerSha256,
            baselineReceiptCount: acceptedBaseline.receiptCount,
            baselineSettlementCount: acceptedBaseline.settlementCount,
            baselineProviderSettlementCount: acceptedBaseline.providerSettlementCount,
            baselineCredentialLockSettlementCount:
              acceptedBaseline.credentialLockSettlementCount,
            baselineIdentityDigest: receiptIdentityDigest(acceptedBaseline.identities),
            finalIdentityDigest: receiptIdentityDigest(settlement.receiptIdentities),
          };
          if (
            producerAcknowledgement.ledgerSha256 !== ledgerSha256 ||
            producerAcknowledgement.finalSequence !== settlement.receiptCount
          ) {
            throw new Error('producer terminal acknowledgement does not bind the final ledger');
          }
          terminalAcknowledgement = {
            version: 1,
            producerTerminal: true,
            noWritableProducerDescriptor: true,
            ledgerSha256,
            finalSequence: settlement.receiptCount,
            settlementCount: settlement.settlementCount,
            providerSettlementCount: settlement.providerSettlementCount,
            credentialLockSettlementCount: settlement.credentialLockSettlementCount,
            payload: producerAcknowledgement.payload,
            signature: producerAcknowledgement.signature,
          };
        }
        const payload = JSON.stringify({
          version: 1,
          collectorId,
          nonce,
          ledger: { ...current, sha256: ledgerSha256 },
          provenance: { ...provenance, sha256: provenanceSha256 },
          issuer: { id: issuer.id },
          sealed: mode === 'finalize',
          baseline:
            acceptedBaseline && {
              accepted: true,
              ledgerSha256: acceptedBaseline.ledgerSha256,
              receiptCount: acceptedBaseline.receiptCount,
              settlementCount: acceptedBaseline.settlementCount,
              providerSettlementCount: acceptedBaseline.providerSettlementCount,
              credentialLockSettlementCount: acceptedBaseline.credentialLockSettlementCount,
              identityDigest: receiptIdentityDigest(acceptedBaseline.identities),
            },
          finalReconciliation,
          terminalAcknowledgement:
            terminalAcknowledgement ?? {
              version: 1,
              producerTerminal: false,
              noWritableProducerDescriptor: false,
              ledgerSha256,
              receiptCount: settlement.receiptCount,
              settlementCount: settlement.settlementCount,
              providerSettlementCount: settlement.providerSettlementCount,
              credentialLockSettlementCount: settlement.credentialLockSettlementCount,
            },
          receipts: raw.toString('base64'),
        });
        socket.end(
          `${JSON.stringify({ payload, signature: crypto.sign(null, Buffer.from(payload), privateKey).toString('base64') })}\n`
        );
      } catch (error) {
        socket.end(`${JSON.stringify({ error: compactOutput(error?.message || error) })}\n`);
      }
    });
  });
  await new Promise((resolve, reject) => server.once('error', reject).listen(socketPath, resolve));
  fs.chmodSync(socketPath, 0o600);
  // Readiness is a one-record protocol. Close stdout immediately afterwards
  // so the parent cannot retain a pipe that keeps a completed canary alive.
  await new Promise((resolve, reject) =>
    process.stdout.end(
      `${JSON.stringify({ version: 1, collectorId, publicKey: publicPem })}\n`,
      (error) => (error ? reject(error) : resolve(undefined))
    )
  );
  await new Promise((resolve) => {
    let closing = false;
    const close = () => {
      if (closing) return;
      closing = true;
      // server.close waits for open sockets. Snapshot clients are untrusted,
      // so destroy them instead of allowing one to hold the success path.
      for (const socket of sockets) socket.destroy();
      const finish = () => {
        try {
          if (!ledgerClosed) fs.closeSync(ledgerFd);
        } catch {
          /* descriptor may already be closed during process teardown */
        }
        try {
          fs.closeSync(provenanceFd);
        } catch {
          /* descriptor may already be closed during process teardown */
        }
        try {
          fs.closeSync(authorityFd);
        } catch {
          /* descriptor may already be closed during process teardown */
        }
        resolve(undefined);
      };
      if (listenerClosed) finish();
      else {
        listenerClosed = true;
        server.close(finish);
      }
    };
    process.once('SIGTERM', close);
    process.once('SIGINT', close);
  });
}

async function requestProducerSealAcknowledgement({ endpoint, nonce, producerId, publicKey }) {
  const line = await new Promise((resolve, reject) => {
    const socket = net.createConnection(endpoint);
    let received = '';
    socket.setEncoding('utf8');
    socket.setTimeout(5_000);
    socket.once('connect', () => socket.write('seal ' + nonce + '\n'));
    socket.on('data', (chunk) => {
      received += chunk;
      const newline = received.indexOf('\n');
      if (newline >= 0) {
        socket.end();
        resolve(received.slice(0, newline));
      }
    });
    socket.once('timeout', () => reject(new Error('producer seal acknowledgement timed out')));
    socket.once('error', reject);
  });
  const response = JSON.parse(line);
  if (typeof response?.payload !== 'string' || typeof response?.signature !== 'string') {
    throw new Error('producer omitted terminal acknowledgement');
  }
  if (!crypto.verify(null, Buffer.from(response.payload), publicKey, Buffer.from(response.signature, 'base64'))) {
    throw new Error('producer terminal acknowledgement signature is invalid');
  }
  const acknowledgement = JSON.parse(response.payload);
  if (
    acknowledgement?.version !== 1 ||
    acknowledgement.producerId !== producerId ||
    acknowledgement.nonce !== nonce ||
    acknowledgement.producerTerminal !== true ||
    acknowledgement.noWritableProducerDescriptor !== true ||
    !Number.isSafeInteger(acknowledgement.finalSequence) ||
    !SHA256_RE.test(acknowledgement.ledgerSha256 ?? '') ||
    typeof acknowledgement.receipts !== 'string'
  ) {
    throw new Error('producer terminal acknowledgement is malformed');
  }
  return { ...acknowledgement, payload: response.payload, signature: response.signature };
}

async function runAuthenticatedAccountingProducer() {
  const ledgerFd = 3;
  const privateKeyFd = 4;
  const socketPath = process.env.PROVIDER_LAUNCH_STRESS_PRODUCER_SOCKET;
  const producerId = process.env.PROVIDER_LAUNCH_STRESS_PRODUCER_ID;
  if (!socketPath || !producerId) throw new Error('producer terminal bootstrap is unavailable');
  const initialLedger = verifyUnlinkedWritableProducerDescriptor(
    ledgerFd,
    'producer accounting ledger'
  );
  // This identity is used only to detect descriptor replacement.  The final
  // byte length is deliberately not retained before the exclusive lease.
  const ledger = { dev: initialLedger.dev, ino: initialLedger.ino };
  const privateKey = readBoundedReleaseDescriptor(
    privateKeyFd,
    verifyUnlinkedReadOnlyCollectorDescriptor(privateKeyFd, 'producer terminal key').size
  ).toString('utf8');
  let sealed = false;
  let acceptingWrites = true;
  const server = net.createServer((socket) => {
    let request = '';
    socket.setEncoding('utf8');
    socket.once('data', (chunk) => {
      request += chunk;
      const match = /^seal ([a-f0-9]{64})\n$/.exec(request);
      if (!match || sealed) return socket.destroy();
      // This is the accounting producer's control plane, not a collector
      // inference. Once seal begins it rejects all future write/reopen work.
      acceptingWrites = false;
      sealed = true;
      try {
        if (acceptingWrites) throw new Error('producer accepted a write after seal');
        // F_SETLEASE(F_WRLCK) is the kernel proof that no foreign reader or
        // writer still holds this inode. This is stronger than inspecting our
        // own fd table: an external writable description prevents the lease,
        // so it cannot survive a signed terminal acknowledgement.
        acquireExclusiveLedgerWriterLease(ledgerFd);
        // A writer can append and close while F_SETLEASE is waiting.  Capture
        // both the final inode identity and length only once that exclusive
        // kernel boundary is acquired, so the signed snapshot cannot omit
        // those final bytes.
        const finalLedger = verifyUnlinkedWritableProducerDescriptor(
          ledgerFd,
          'producer accounting ledger after exclusive lease'
        );
        if (finalLedger.dev !== ledger.dev || finalLedger.ino !== ledger.ino) {
          throw new Error('producer accounting ledger inode changed after exclusive lease');
        }
        const raw = readBoundedReleaseDescriptor(ledgerFd, finalLedger.size);
        // This is the actual ledger writer's terminal boundary.  Do not build
        // (let alone sign) an acknowledgement while its writable description
        // remains live.  The accounting collector is observation-only and is
        // therefore not allowed to assert this state on the producer's behalf.
        fs.closeSync(ledgerFd);
        assertNoWritableLedgerDescriptors(ledger, 'producer terminal acknowledgement');
        const payload = JSON.stringify({
          version: 1, producerId, nonce: match[1],
          ledgerSha256: crypto.createHash('sha256').update(raw).digest('hex'),
          finalSequence: raw.toString('utf8').split('\n').filter(Boolean).length,
          producerTerminal: true, noWritableProducerDescriptor: true,
          receipts: raw.toString('base64'),
        });
        fs.closeSync(privateKeyFd);
        socket.end(
          JSON.stringify({ payload, signature: crypto.sign(null, Buffer.from(payload), privateKey).toString('base64') }) + '\n',
          () => server.close(() => process.exit(0))
        );
      } catch (error) {
        socket.end(JSON.stringify({ error: compactOutput(error?.message || error) }) + '\n');
      }
    });
  });
  await new Promise((resolve, reject) => server.once('error', reject).listen(socketPath, resolve));
  await new Promise((resolve) => {
    const close = () => server.close(() => resolve(undefined));
    process.once('SIGTERM', close);
    process.once('SIGINT', close);
  });
}

function acquireExclusiveLedgerWriterLease(ledgerFd) {
  const deadline = Date.now() + 1_000;
  let result;
  do {
    result = spawnSync(
      'python3',
      [
        '-c',
        "import fcntl, sys; fcntl.fcntl(3, fcntl.F_SETLEASE, fcntl.F_WRLCK)",
      ],
      { stdio: ['ignore', 'ignore', 'pipe', ledgerFd] }
    );
    if (result.status === 0) return;
    // A writer which is in its final append-and-close window causes EAGAIN.
    // Keep admission closed and retry the proof briefly; once it closes, the
    // post-lease fstat below captures its final bytes. A surviving writer
    // still fails closed at the bounded deadline.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  } while (Date.now() < deadline);
  throw new Error(
    `producer terminal seal could not prove exclusive ledger ownership: ${compactOutput(result?.stderr || 'F_SETLEASE failed')}`
  );
}

function assertNoWritableLedgerDescriptors(ledger, label) {
  for (const name of fs.readdirSync('/proc/self/fd')) {
    if (!/^\d+$/.test(name)) continue;
    const fd = Number(name);
    try {
      const stat = fs.fstatSync(fd, { bigint: true });
      if (String(stat.dev) !== ledger.dev || String(stat.ino) !== ledger.ino) continue;
      const flagsLine = fs
        .readFileSync(`/proc/self/fdinfo/${fd}`, 'utf8')
        .split('\n')
        .find((line) => line.startsWith('flags:'));
      const flags = Number.parseInt(flagsLine?.slice('flags:'.length).trim() ?? '', 8);
      if (!hasReadOnlyDescriptorAccess(flags)) {
        throw new Error(`${label} retained writable ledger descriptor ${fd}`);
      }
    } catch (error) {
      // The fd may close between readdir and fstat. Anything else is an
      // unknown writer state and fails closed rather than signing terminal.
      if (error?.code !== 'EBADF' && error?.code !== 'ENOENT') throw error;
    }
  }
}

function validateAuthenticatedProviderReceiptLedger(raw, issuer, requireClosed = false) {
  const billedEventIds = new Set();
  const settlements = new Map();
  const providerIds = new Set();
  const receiptIdentities = [];
  const releasedCredentialLocks = new Map();
  const revokedCredentialLocks = new Set();
  const credentialLockSettlementCounts = new Map();
  let activeCredentialLock = null;
  for (const line of raw.toString('utf8').split('\n').filter(Boolean)) {
    let receipt;
    try {
      receipt = JSON.parse(line);
    } catch {
      throw new Error('accounting ledger has a non-JSON producer record');
    }
    if (
      receipt?.issuerId !== issuer.id ||
      typeof receipt.issuerPayload !== 'string' ||
      typeof receipt.issuerSignature !== 'string' ||
      !crypto.verify(
        null,
        Buffer.from(receipt.issuerPayload),
        issuer.publicKey,
        Buffer.from(receipt.issuerSignature, 'base64')
      )
    ) {
      throw new Error('accounting ledger contains an unauthenticated producer record');
    }
    const producerPayload = JSON.parse(receipt.issuerPayload);
    for (const key of [
      'billingEventId',
      'teamName',
      'runId',
      'taskId',
      'memberName',
      'providerId',
      'kind',
      'terminalOutcome',
      'runtimeSessionId',
      'marker',
      'credentialLock',
    ]) {
      if (
        canonicalizeOptionalJson(producerPayload?.[key]) !==
        canonicalizeOptionalJson(receipt[key])
      )
        throw new Error('producer signature does not bind the accounting receipt fields');
    }
    if (
      typeof receipt.billingEventId !== 'string' ||
      receipt.billingEventId.length < 16 ||
      billedEventIds.has(receipt.billingEventId)
    ) {
      throw new Error('accounting ledger does not prove an exactly-once billing event source');
    }
    billedEventIds.add(receipt.billingEventId);
    providerIds.add(receipt.providerId);
    // Include every issuer-bound field and the exact issuer signature in the
    // identity. The final comparison is therefore independent of an
    // attacker-controlled ledger line order or a reused billing-event ID.
    receiptIdentities.push(authenticatedReceiptIdentity(receipt));
    const terminalByKind = {
      'provider-request': 'accepted',
      'provider-debit': 'debited',
      'provider-refund': 'refunded',
      'provider-effect': 'effect-observed',
    };
    if (receipt.kind === 'runtime-credential-lock') {
      const lock = receipt.credentialLock;
      if (
        !lock ||
        typeof lock.lockId !== 'string' ||
        !lock.lockId ||
        typeof lock.ownerId !== 'string' ||
        !lock.ownerId ||
        lock.ownerRuntimeSessionId !== receipt.runtimeSessionId ||
        !['acquire', 'release', 'revocation', 'effect'].includes(lock.event)
      ) {
        throw new Error('accounting ledger has unsigned or malformed runtime credential-lock evidence');
      }
      if (lock.event === 'acquire') {
        if (
          receipt.terminalOutcome !== 'acquired' ||
          activeCredentialLock ||
          releasedCredentialLocks.has(lock.lockId) ||
          revokedCredentialLocks.has(lock.lockId)
        ) {
          throw new Error('accounting ledger proves overlapping runtime credential locks');
        }
        activeCredentialLock = {
          lockId: lock.lockId,
          providerId: receipt.providerId,
          ownerId: lock.ownerId,
          ownerRuntimeSessionId: lock.ownerRuntimeSessionId,
        };
      } else if (lock.event === 'release') {
        if (
          receipt.terminalOutcome !== 'released' ||
          !activeCredentialLock ||
          activeCredentialLock.lockId !== lock.lockId ||
          activeCredentialLock.providerId !== receipt.providerId ||
          activeCredentialLock.ownerId !== lock.ownerId ||
          activeCredentialLock.ownerRuntimeSessionId !== lock.ownerRuntimeSessionId
        ) {
          throw new Error('accounting ledger has a runtime credential-lock release without its owner');
        }
        releasedCredentialLocks.set(lock.lockId, activeCredentialLock);
        activeCredentialLock = null;
      } else if (lock.event === 'revocation') {
        // A fresh, correctly signed revocation is still invalid unless it is
        // the terminal transition for this exact released provider runtime.
        // Lock IDs are not a global authority: bind provider, owner and
        // runtime session to the release record before accepting it.
        const releasedCredentialLock = releasedCredentialLocks.get(lock.lockId);
        if (
          receipt.terminalOutcome !== 'revoked' ||
          activeCredentialLock ||
          !releasedCredentialLock ||
          revokedCredentialLocks.has(lock.lockId) ||
          releasedCredentialLock.providerId !== receipt.providerId ||
          releasedCredentialLock.ownerId !== lock.ownerId ||
          releasedCredentialLock.ownerRuntimeSessionId !== lock.ownerRuntimeSessionId
        ) {
          throw new Error('accounting ledger has invalid runtime credential-lock revocation evidence');
        }
        revokedCredentialLocks.add(lock.lockId);
        credentialLockSettlementCounts.set(
          receipt.providerId,
          (credentialLockSettlementCounts.get(receipt.providerId) ?? 0) + 1
        );
      } else {
        // `effect` is valid only on a provider receipt. A terminal outcome is
        // not an event: accepting effect+revoked would let an ordinary effect
        // impersonate the lock's explicit revocation transition.
        throw new Error('accounting ledger runtime credential-lock requires an explicit revocation event');
      }
      continue;
    }
    if (terminalByKind[receipt.kind] !== receipt.terminalOutcome) {
      throw new Error('accounting ledger contains a receipt without a recognized terminal state');
    }
    // A provider receipt is valid only while the exact runtime that acquired
    // its credential lock still owns it. The owner/session/lock reference is
    // signed in the receipt, so a reordered, post-release, or different-
    // session effect cannot be relabelled by a later ledger line.
    const lock = receipt.credentialLock;
    if (
      !lock ||
      lock.event !== 'effect' ||
      !activeCredentialLock ||
      activeCredentialLock.providerId !== receipt.providerId ||
      activeCredentialLock.lockId !== lock.lockId ||
      activeCredentialLock.ownerId !== lock.ownerId ||
      activeCredentialLock.ownerRuntimeSessionId !== lock.ownerRuntimeSessionId ||
      receipt.runtimeSessionId !== lock.ownerRuntimeSessionId
    ) {
      throw new Error('provider effect is not bound to its active runtime credential-lock owner');
    }
    const settlementKey = [
      receipt.teamName,
      receipt.runId,
      receipt.taskId,
      receipt.memberName,
      receipt.providerId,
      receipt.runtimeSessionId,
      receipt.marker,
    ].join('\u0000');
    const settlement = settlements.get(settlementKey) ?? {
      providerId: receipt.providerId,
      request: 0,
      debit: 0,
      refund: 0,
      effect: 0,
    };
    if (receipt.kind === 'provider-request') settlement.request += 1;
    if (receipt.kind === 'provider-debit') settlement.debit += 1;
    if (receipt.kind === 'provider-refund') settlement.refund += 1;
    if (receipt.kind === 'provider-effect') settlement.effect += 1;
    settlements.set(settlementKey, settlement);
  }
  const providerSettlementCounts = new Map();
  for (const settlement of settlements.values()) {
    providerSettlementCounts.set(
      settlement.providerId,
      (providerSettlementCounts.get(settlement.providerId) ?? 0) + 1
    );
  }
  if (!requireClosed) {
    return {
      receiptCount: billedEventIds.size,
      // A credential lock is a three-receipt lifecycle whose revocation is
      // its terminal settlement. It is independent from a provider debit,
      // and omitting it here lets a four-provider ledger appear to have only
      // four settlements despite containing eight closed lifecycles.
      settlementCount: settlements.size + revokedCredentialLocks.size,
      providerSettlementCount: settlements.size,
      credentialLockSettlementCount: revokedCredentialLocks.size,
      providerSettlementCounts,
      credentialLockSettlementCounts,
      receiptIdentities,
      providerIds,
      credentialLockCount: revokedCredentialLocks.size,
    };
  }
  // `finalize` is a closure operation, not merely a signed read. Every debit
  // must therefore have one and only one terminal settlement: an observed
  // effect or a refund. A request-only, duplicate, or ambiguous group is
  // uncertainty and fails the release canary closed.
  for (const settlement of settlements.values()) {
    if (
      settlement.request !== 1 ||
      settlement.debit !== 1 ||
      settlement.refund + settlement.effect !== 1
    ) {
      throw new Error('accounting ledger cannot prove a closed exact provider settlement');
    }
  }
  if (activeCredentialLock || releasedCredentialLocks.size !== revokedCredentialLocks.size) {
    throw new Error('accounting ledger cannot prove every runtime credential lock was released and revoked');
  }
  return {
    receiptCount: billedEventIds.size,
    settlementCount: settlements.size + revokedCredentialLocks.size,
    providerSettlementCount: settlements.size,
    credentialLockSettlementCount: revokedCredentialLocks.size,
    providerSettlementCounts,
    credentialLockSettlementCounts,
    receiptIdentities,
    providerIds,
    credentialLockCount: revokedCredentialLocks.size,
  };
}

function assertRequiredProviderAccountingCoverage(settlement) {
  const expected = new Set(REQUIRED_PROVIDER_ORDER);
  const hasOneSettlementPerProvider = (counts) =>
    counts instanceof Map &&
    counts.size === expected.size &&
    [...expected].every((provider) => counts.get(provider) === 1);
  if (
    settlement.receiptCount !== REQUIRED_PROVIDER_ORDER.length * 6 ||
    settlement.providerSettlementCount !== REQUIRED_PROVIDER_ORDER.length ||
    settlement.credentialLockSettlementCount !== REQUIRED_PROVIDER_ORDER.length ||
    settlement.settlementCount !== REQUIRED_PROVIDER_ORDER.length * 2 ||
    settlement.credentialLockCount !== REQUIRED_PROVIDER_ORDER.length ||
    settlement.providerIds.size !== expected.size ||
    [...expected].some((provider) => !settlement.providerIds.has(provider)) ||
    !hasOneSettlementPerProvider(settlement.providerSettlementCounts) ||
    !hasOneSettlementPerProvider(settlement.credentialLockSettlementCounts)
  ) {
    throw new Error('accounting collector baseline must contain exactly one provider and credential-lock settlement per required provider');
  }
}

function authenticatedReceiptIdentity(receipt) {
  return crypto
    .createHash('sha256')
    .update(
      canonicalizeJson({
        issuerId: receipt.issuerId,
        issuerPayload: receipt.issuerPayload,
        issuerSignature: receipt.issuerSignature,
        billingEventId: receipt.billingEventId,
        teamName: receipt.teamName,
        runId: receipt.runId,
        taskId: receipt.taskId,
        memberName: receipt.memberName,
        providerId: receipt.providerId,
        kind: receipt.kind,
        terminalOutcome: receipt.terminalOutcome,
        runtimeSessionId: receipt.runtimeSessionId,
        marker: receipt.marker,
        credentialLock: receipt.credentialLock ?? null,
      })
    )
    .digest('hex');
}

function receiptIdentityDigest(identities) {
  return crypto
    .createHash('sha256')
    .update(canonicalizeJson([...identities]))
    .digest('hex');
}

function reconcileFinalSealedAccountingLedger(baseline, finalSettlement) {
  if (
    baseline.receiptCount !== finalSettlement.receiptCount ||
    baseline.settlementCount !== finalSettlement.settlementCount ||
    baseline.providerSettlementCount !== finalSettlement.providerSettlementCount ||
    baseline.credentialLockSettlementCount !== finalSettlement.credentialLockSettlementCount
  ) {
    throw new Error('final sealed accounting receipt count differs from accepted proof baseline');
  }
  const finalIdentities = finalSettlement.receiptIdentities;
  if (baseline.identities.length !== finalIdentities.length) {
    throw new Error('final sealed accounting receipt identities differ from accepted proof baseline');
  }
  // The multiset catches signed late append, duplicate, missing, and
  // replacement effects. Preserve the accepted authority order as a second
  // fence: a reordered sequence is not the same settled ledger.
  const expectedCounts = new Map();
  const actualCounts = new Map();
  for (const identity of baseline.identities) {
    expectedCounts.set(identity, (expectedCounts.get(identity) ?? 0) + 1);
  }
  for (const identity of finalIdentities) {
    actualCounts.set(identity, (actualCounts.get(identity) ?? 0) + 1);
  }
  if (
    expectedCounts.size !== actualCounts.size ||
    [...expectedCounts].some(([identity, count]) => actualCounts.get(identity) !== count)
  ) {
    throw new Error('final sealed accounting receipt multiset differs from accepted proof baseline');
  }
  if (baseline.identities.some((identity, index) => finalIdentities[index] !== identity)) {
    throw new Error('final sealed accounting authority effects were reordered after proof acceptance');
  }
}

function verifyUnlinkedReadOnlyCollectorDescriptor(fd, label) {
  const stat = fs.fstatSync(fd, { bigint: true });
  if (!stat.isFile() || stat.nlink !== 0n || stat.uid !== BigInt(process.getuid?.() ?? -1)) {
    throw new Error(`${label} must be an unlinked regular descriptor`);
  }
  // /proc exposes the open-file flags without trusting a caller-provided
  // pathname.  O_RDONLY gives the worker observation only; the separate
  // collector retains any write authority after unlinking its files.
  const flagsLine = fs
    .readFileSync(`/proc/self/fdinfo/${fd}`, 'utf8')
    .split('\n')
    .find((line) => line.startsWith('flags:'));
  const flags = Number.parseInt(flagsLine?.slice('flags:'.length).trim() ?? '', 8);
  if (!hasReadOnlyDescriptorAccess(flags)) {
    throw new Error(`${label} descriptor is not read-only`);
  }
  return { dev: String(stat.dev), ino: String(stat.ino), size: Number(stat.size) };
}

function verifyUnlinkedWritableProducerDescriptor(fd, label) {
  const descriptor = verifyUnlinkedDescriptor(fd, label);
  if (!hasWritableProducerDescriptorAccess(descriptor.flags)) {
    throw new Error(`${label} descriptor is not producer-writable`);
  }
  return descriptor;
}

function verifyUnlinkedDescriptor(fd, label) {
  const stat = fs.fstatSync(fd, { bigint: true });
  if (!stat.isFile() || stat.nlink !== 0n || stat.uid !== BigInt(process.getuid?.() ?? -1)) {
    throw new Error(`${label} must be an unlinked regular descriptor`);
  }
  const flagsLine = fs
    .readFileSync(`/proc/self/fdinfo/${fd}`, 'utf8')
    .split('\n')
    .find((line) => line.startsWith('flags:'));
  const flags = Number.parseInt(flagsLine?.slice('flags:'.length).trim() ?? '', 8);
  if (!Number.isSafeInteger(flags)) throw new Error(`${label} descriptor has no readable flags`);
  return { dev: String(stat.dev), ino: String(stat.ino), size: Number(stat.size), flags };
}

function descriptorAccessMode(flags) {
  return flags & FILE_ACCESS_MODE_MASK;
}

function hasReadOnlyDescriptorAccess(flags) {
  return Number.isSafeInteger(flags) && descriptorAccessMode(flags) === fs.constants.O_RDONLY;
}

function hasWritableProducerDescriptorAccess(flags) {
  if (!Number.isSafeInteger(flags)) return false;
  const mode = descriptorAccessMode(flags);
  return mode === fs.constants.O_WRONLY || mode === fs.constants.O_RDWR;
}

async function runSignalDuringPreflightFixture() {
  let cleanupStarted = false;
  let workerStarts = 0;
  let releasePreflight;
  const signal = 'SIGTERM';
  const signalObserved = new Promise((resolve) => {
    process.once(signal, () => {
      cleanupStarted = true;
      resolve(undefined);
    });
  });
  const preflightGate = new Promise((resolve) => {
    releasePreflight = resolve;
  });
  const preflight = (async () => {
    await preflightGate;
    if (cleanupStarted) throw new Error('cleanup began during preflight');
  })();

  // Deliver a real signal while the preflight await is unresolved, then let
  // the await settle. This has no timing dependency on a provider process.
  const signalDelivery = new Promise((resolve) => {
    setTimeout(() => {
      process.kill(process.pid, signal);
      // Keep the event loop alive through the next signal delivery turn.
      setTimeout(() => resolve(undefined), 1);
    }, 0);
  });
  await Promise.all([signalObserved, signalDelivery]);
  releasePreflight();
  let rejected = false;
  try {
    await preflight;
    if (cleanupStarted) throw new Error('cleanup began before worker allocation');
    workerStarts += 1;
  } catch {
    rejected = true;
  }
  return { ok: rejected && workerStarts === 0, cleanupStarted, workerStarts };
}

function runDescriptorAccessModeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-launch-stress-descriptor-'));
  const cases = [
    { name: 'read-only', flags: fs.constants.O_RDONLY, readOnly: true, producerWritable: false, terminal: true },
    { name: 'read-write', flags: fs.constants.O_RDWR, readOnly: false, producerWritable: true, terminal: false },
    { name: 'write-only', flags: fs.constants.O_WRONLY, readOnly: false, producerWritable: true, terminal: false },
  ];
  const results = [];
  try {
    for (const testCase of cases) {
      const target = path.join(root, testCase.name);
      fs.writeFileSync(target, 'descriptor access fixture\n', { mode: 0o600, flag: 'wx' });
      const fd = fs.openSync(target, testCase.flags);
      fs.unlinkSync(target);
      try {
        const stat = fs.fstatSync(fd, { bigint: true });
        const ledger = { dev: String(stat.dev), ino: String(stat.ino) };
        const accepts = (guard) => {
          try {
            guard();
            return true;
          } catch {
            return false;
          }
        };
        results.push({
          name: testCase.name,
          unlinked: stat.nlink === 0n,
          readOnly: accepts(() => verifyUnlinkedReadOnlyCollectorDescriptor(fd, testCase.name)),
          producerWritable: accepts(() => verifyUnlinkedWritableProducerDescriptor(fd, testCase.name)),
          terminal: accepts(() => assertNoWritableLedgerDescriptors(ledger, testCase.name)),
          expected: {
            readOnly: testCase.readOnly,
            producerWritable: testCase.producerWritable,
            terminal: testCase.terminal,
          },
        });
      } finally {
        fs.closeSync(fd);
      }
    }
  } finally {
    fs.rmdirSync(root);
  }
  return {
    ok: results.every(
      (result) =>
        result.unlinked &&
        result.readOnly === result.expected.readOnly &&
        result.producerWritable === result.expected.producerWritable &&
        result.terminal === result.expected.terminal
    ),
    results,
  };
}

function readUnifiedCgroupRelativePath() {
  try {
    const line = fs
      .readFileSync('/proc/self/cgroup', 'utf8')
      .split('\n')
      .find((entry) => entry.startsWith('0::'));
    return line?.slice(3).trim() || null;
  } catch {
    return null;
  }
}

function findUnifiedCgroupMount() {
  try {
    for (const line of fs.readFileSync('/proc/self/mountinfo', 'utf8').split('\n')) {
      const separator = line.indexOf(' - ');
      if (separator < 0) continue;
      const right = line.slice(separator + 3).split(' ');
      if (right[0] !== 'cgroup2') continue;
      const left = line.slice(0, separator).split(' ');
      // mountinfo escapes whitespace as octal; cgroup mount paths should not
      // be user-controlled here, but decode it before using the exact mount.
      return (left[4] || '').replace(/\\040/g, ' ');
    }
  } catch {
    // fail closed in establishDedicatedLaunchCgroup
  }
  return null;
}

function verifyTrustedWrapperReleaseIdentity() {
  try {
    const identityPath = path.join(scriptDir, PROVIDER_LAUNCH_STRESS_RELEASE_IDENTITY_FILE);
    const identity = JSON.parse(fs.readFileSync(identityPath, 'utf8'));
    const wrapperPath = fs.realpathSync(scriptPath);
    const relativeArtifact = path.relative(repoRoot, wrapperPath).split(path.sep).join('/');
    const sha256 = crypto.createHash('sha256').update(fs.readFileSync(wrapperPath)).digest('hex');
    const signedPayload = JSON.stringify({
      version: identity?.version,
      artifact: identity?.artifact,
      sha256: identity?.sha256,
    });
    if (
      identity?.version !== 1 ||
      identity.artifact !== relativeArtifact ||
      !SHA256_RE.test(identity.sha256 ?? '') ||
      identity.sha256 !== sha256 ||
      typeof identity.signature !== 'string' ||
      !crypto.verify(
        null,
        Buffer.from(signedPayload),
        PROVIDER_LAUNCH_STRESS_RELEASE_PUBLIC_KEY,
        Buffer.from(identity.signature, 'base64')
      )
    ) {
      return { ok: false, reason: 'signed wrapper artifact identity did not verify' };
    }
    return { ok: true, sha256 };
  } catch (error) {
    return { ok: false, reason: compactOutput(error?.message || error) };
  }
}

function readTrustedLauncherPrivateCapability() {
  try {
    const fd = TRUSTED_LAUNCHER_CAPABILITY_FD;
    const stat = fs.fstatSync(fd, { bigint: true });
    if (!stat.isFile() || stat.nlink !== 0n || stat.size <= 0n || stat.size > 64n * 1024n) {
      return null;
    }
    const flagsLine = fs
      .readFileSync(`/proc/self/fdinfo/${fd}`, 'utf8')
      .split('\n')
      .find((line) => line.startsWith('flags:'));
    const flags = Number.parseInt(flagsLine?.slice('flags:'.length).trim() ?? '', 8);
    if (!hasReadOnlyDescriptorAccess(flags)) {
      return null;
    }
    const privateKey = crypto.createPrivateKey(readBoundedReleaseDescriptor(fd, Number(stat.size)));
    const publicKey = crypto
      .createPublicKey(privateKey)
      .export({ type: 'spki', format: 'pem' })
      .toString();
    return publicKey === PROVIDER_LAUNCH_STRESS_TRUSTED_LAUNCHER_CAPABILITY_PUBLIC_KEY
      ? privateKey
      : null;
  } catch {
    return null;
  }
}

function verifyReleaseOrchestratorArtifact({ env: inputEnv }) {
  const suppliedPath = inputEnv.CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH?.trim();
  const expectedPath = inputEnv.PROVIDER_LAUNCH_STRESS_EXPECTED_ORCHESTRATOR_PATH?.trim();
  const expectedSha = inputEnv.PROVIDER_LAUNCH_STRESS_EXPECTED_ORCHESTRATOR_SHA256?.trim();
  const payloadManifestPath = inputEnv.PROVIDER_LAUNCH_STRESS_RELEASE_PAYLOAD_MANIFEST?.trim();
  const payloadManifestSha =
    inputEnv.PROVIDER_LAUNCH_STRESS_RELEASE_PAYLOAD_MANIFEST_SHA256?.trim();
  if (
    !suppliedPath ||
    !expectedPath ||
    !expectedSha ||
    !payloadManifestPath ||
    !payloadManifestSha
  ) {
    return {
      ok: false,
      reason: 'explicit CLI, payload manifest paths, realpaths, and SHA-256 values are required',
    };
  }
  if (!SHA256_RE.test(expectedSha) || !SHA256_RE.test(payloadManifestSha)) {
    return { ok: false, reason: 'expected SHA-256 is malformed' };
  }
  let artifact = null;
  try {
    const artifactPath = path.resolve(suppliedPath);
    const expectedArtifactPath = path.resolve(expectedPath);
    if (
      artifactPath !== expectedArtifactPath ||
      /(?:^|[-_/])cli-(?:source|dev)(?:$|[-_/])|cli-source/.test(artifactPath)
    ) {
      return { ok: false, reason: 'CLI path differs from expected release artifact' };
    }
    artifact = openReleaseDescriptor(artifactPath, { sha256: expectedSha });
    if ((artifact.mode & 0o111) === 0) {
      return { ok: false, reason: 'orchestrator artifact is not an executable regular file' };
    }
    const manifestDescriptor = openReleaseDescriptor(path.resolve(payloadManifestPath), {
      sha256: payloadManifestSha,
    });
    let manifest;
    try {
      manifest = JSON.parse(
        readBoundedReleaseDescriptor(manifestDescriptor.fd, manifestDescriptor.size).toString(
          'utf8'
        )
      );
      revalidateReleaseDescriptor(manifestDescriptor);
    } finally {
      fs.closeSync(manifestDescriptor.fd);
    }
    if (manifestDescriptor.sha256 !== payloadManifestSha.toLowerCase()) {
      return { ok: false, reason: 'release payload manifest bytes do not match expected SHA-256' };
    }
    const closure = resolveReleasePayloadClosure({
      manifest,
      manifestPath: path.resolve(payloadManifestPath),
      manifestSha256: payloadManifestSha,
    });
    if (!closure.ok) return closure;
    const payload = closure.payload;
    if (
      !payload.some(
        (entry) =>
          entry.realPath === artifactPath &&
          entry.sha256 === artifact.sha256 &&
          entry.role === 'wrapper'
      )
    ) {
      return {
        ok: false,
        reason: 'release payload inventory does not bind the executable wrapper',
      };
    }
    revalidateReleaseDescriptor(artifact);
    return {
      ok: true,
      realPath: artifactPath,
      sha256: artifact.sha256,
      payload,
      manifest: {
        realPath: path.resolve(payloadManifestPath),
        sha256: payloadManifestSha.toLowerCase(),
      },
      // Materialization must preserve the root that constrained every
      // manifest edge.  Without this, its relative-path mapping has no
      // authority to reject a payload which escapes the verified repository.
      repositoryRoot: closure.repositoryRoot,
      closureSha256: closure.sha256,
    };
  } catch (error) {
    return {
      ok: false,
      reason: `cannot verify release artifact: ${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    if (artifact) fs.closeSync(artifact.fd);
  }
}

// The release manifest is deliberately a graph rather than a loose list of
// files.  The build system emits the wrapper, built entry, build metadata,
// lockfile and every module/asset edge reachable from the wrapper.  This
// prevents a signed one-file wrapper from later loading mutable code.
function resolveReleasePayloadClosure({ manifest, manifestPath, manifestSha256 }) {
  if (
    !manifest ||
    manifest.version !== 2 ||
    !Array.isArray(manifest.files) ||
    manifest.files.length < 4
  ) {
    return {
      ok: false,
      reason: 'release payload manifest must be version 2 with a complete multi-file closure',
    };
  }
  const repository = manifest.repository;
  const buildMetadata = manifest.buildMetadata;
  if (
    !repository ||
    typeof repository.root !== 'string' ||
    !buildMetadata ||
    typeof buildMetadata !== 'object'
  ) {
    return { ok: false, reason: 'release payload manifest lacks repository build metadata' };
  }
  try {
    const repositoryRoot = path.resolve(repository.root);
    const wrapperPath = requireManifestPath(manifest.wrapperPath, 'wrapperPath');
    const entryPath = requireManifestPath(buildMetadata.entryPath, 'buildMetadata.entryPath');
    const metadataPath = requireManifestPath(buildMetadata.path, 'buildMetadata.path');
    const lockfilePath = requireManifestPath(
      buildMetadata.lockfilePath,
      'buildMetadata.lockfilePath'
    );
    const roles = new Map([
      [wrapperPath, 'wrapper'],
      [entryPath, 'entry'],
      [metadataPath, 'build-metadata'],
      [lockfilePath, 'lockfile'],
    ]);
    const inventory = new Map();
    for (const entry of manifest.files) {
      if (!entry || typeof entry.path !== 'string' || !SHA256_RE.test(entry.sha256 ?? '')) {
        throw new Error('release payload manifest entry is malformed');
      }
      const entryPathResolved = path.resolve(entry.path);
      assertPathWithinRepository(entryPathResolved, repositoryRoot);
      if (inventory.has(entryPathResolved))
        throw new Error(`release payload has duplicate entry: ${entryPathResolved}`);
      const descriptor = openReleaseDescriptor(entryPathResolved, { sha256: entry.sha256 });
      try {
        inventory.set(entryPathResolved, {
          realPath: entryPathResolved,
          sha256: descriptor.sha256,
          dev: descriptor.dev,
          ino: descriptor.ino,
          size: String(descriptor.size),
          role: roles.get(entryPathResolved) ?? 'module-or-asset',
        });
        revalidateReleaseDescriptor(descriptor);
      } finally {
        fs.closeSync(descriptor.fd);
      }
    }
    for (const [requiredPath, role] of roles) {
      assertPathWithinRepository(requiredPath, repositoryRoot);
      if (!inventory.has(requiredPath))
        throw new Error(`release payload omits required ${role}: ${requiredPath}`);
    }
    const references = buildMetadata.references;
    if (!references || typeof references !== 'object' || Array.isArray(references)) {
      throw new Error('release build metadata has no wrapper dependency graph');
    }
    const normalizedReferences = new Map();
    for (const [from, rawTargets] of Object.entries(references)) {
      const fromPath = path.resolve(from);
      assertPathWithinRepository(fromPath, repositoryRoot);
      if (!inventory.has(fromPath) || !Array.isArray(rawTargets))
        throw new Error('release build metadata reference is malformed');
      const targets = rawTargets.map((target) => {
        if (typeof target !== 'string')
          throw new Error('release build metadata target is malformed');
        const targetPath = path.resolve(target);
        assertPathWithinRepository(targetPath, repositoryRoot);
        if (!inventory.has(targetPath))
          throw new Error(`release build metadata target is outside the payload: ${targetPath}`);
        return targetPath;
      });
      normalizedReferences.set(fromPath, targets);
    }
    const reachable = new Set();
    const pending = [wrapperPath];
    while (pending.length > 0) {
      const current = pending.pop();
      if (!current || reachable.has(current)) continue;
      reachable.add(current);
      const targets = normalizedReferences.get(current);
      if (!targets)
        throw new Error(
          `release build metadata has no references for reachable payload: ${current}`
        );
      pending.push(...targets);
    }
    if (
      !reachable.has(entryPath) ||
      !reachable.has(metadataPath) ||
      !reachable.has(lockfilePath) ||
      reachable.size !== inventory.size
    ) {
      throw new Error('release build metadata does not bind the complete wrapper closure');
    }
    const payload = [...inventory.values()].sort((left, right) =>
      left.realPath.localeCompare(right.realPath)
    );
    const canonical = [
      `manifest\u0000${manifestPath}\u0000${manifestSha256.toLowerCase()}`,
      ...payload.map((entry) => `${entry.realPath}\u0000${entry.sha256}\u0000${entry.role}`),
    ].join('\n');
    return {
      ok: true,
      payload,
      repositoryRoot,
      sha256: crypto.createHash('sha256').update(canonical).digest('hex'),
    };
  } catch (error) {
    return {
      ok: false,
      reason: `cannot resolve release payload closure: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function materializeVerifiedReleasePayload(artifact) {
  if (!artifact.repositoryRoot) throw new Error('verified release payload has no repository root');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-launch-stress-release-'));
  const rootStat = fs.statSync(root, { bigint: true });
  const mapPath = (source) => {
    const relative = path.relative(artifact.repositoryRoot, source);
    if (
      !relative ||
      relative.startsWith(`..${path.sep}`) ||
      relative === '..' ||
      path.isAbsolute(relative)
    ) {
      throw new Error(`verified release payload escaped its repository root: ${source}`);
    }
    return path.join(root, relative);
  };
  const copied = [];
  try {
    for (const entry of artifact.payload) {
      const descriptor = openReleaseDescriptor(entry.realPath, entry);
      try {
        revalidateReleaseDescriptor(descriptor);
        const destination = mapPath(entry.realPath);
        fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
        fs.writeFileSync(
          destination,
          readBoundedReleaseDescriptor(descriptor.fd, descriptor.size),
          {
            mode: entry.role === 'wrapper' ? 0o700 : 0o600,
            flag: 'wx',
          }
        );
        revalidateReleaseDescriptor(descriptor);
        const copiedDescriptor = openReleaseDescriptor(destination, { sha256: entry.sha256 });
        try {
          copied.push({
            ...entry,
            realPath: destination,
            dev: copiedDescriptor.dev,
            ino: copiedDescriptor.ino,
            size: String(copiedDescriptor.size),
          });
        } finally {
          fs.closeSync(copiedDescriptor.fd);
        }
      } finally {
        fs.closeSync(descriptor.fd);
      }
    }
    const manifestDescriptor = openReleaseDescriptor(artifact.manifest.realPath, {
      sha256: artifact.manifest.sha256,
    });
    const manifestPath = path.join(root, '.verified-release-payload-manifest.json');
    try {
      revalidateReleaseDescriptor(manifestDescriptor);
      fs.writeFileSync(
        manifestPath,
        readBoundedReleaseDescriptor(manifestDescriptor.fd, manifestDescriptor.size),
        { mode: 0o600, flag: 'wx' }
      );
      revalidateReleaseDescriptor(manifestDescriptor);
    } finally {
      fs.closeSync(manifestDescriptor.fd);
    }
    const manifest = openReleaseDescriptor(manifestPath, { sha256: artifact.manifest.sha256 });
    try {
      const canonical = [
        `manifest\u0000${manifestPath}\u0000${manifest.sha256}`,
        ...copied
          .sort((left, right) => left.realPath.localeCompare(right.realPath))
          .map((entry) => `${entry.realPath}\u0000${entry.sha256}\u0000${entry.role}`),
      ].join('\n');
      const wrapper = copied.find(
        (entry) => entry.role === 'wrapper' && entry.sha256 === artifact.sha256
      );
      if (!wrapper) throw new Error('materialized payload has no verified wrapper');
      // Freeze the copied closure only after all descriptor/hash checks have
      // completed.  Files are read/execute-only and directories are
      // traversal-only, so the execution pathname cannot be changed through
      // ordinary writes between this verification and child launch.  The
      // descriptor identities remain the final authority for hostile
      // replacement attempts.
      for (const entry of copied)
        fs.chmodSync(entry.realPath, entry.role === 'wrapper' ? 0o500 : 0o400);
      fs.chmodSync(manifestPath, 0o400);
      const directories = new Set([root]);
      for (const entry of copied) {
        for (let directory = path.dirname(entry.realPath); ; directory = path.dirname(directory)) {
          directories.add(directory);
          if (directory === root) break;
        }
      }
      const directoryDescriptors = [];
      for (const directory of [...directories].sort((left, right) => right.length - left.length)) {
        fs.chmodSync(directory, 0o500);
        const directoryFd = fs.openSync(
          directory,
          fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW
        );
        try {
          const directoryStat = fs.fstatSync(directoryFd, { bigint: true });
          if (!directoryStat.isDirectory() || (Number(directoryStat.mode) & 0o222) !== 0) {
            throw new Error(
              `materialized release directory did not become immutable: ${directory}`
            );
          }
          directoryDescriptors.push({
            path: directory,
            dev: String(directoryStat.dev),
            ino: String(directoryStat.ino),
            mode: Number(directoryStat.mode & 0o777),
          });
        } finally {
          fs.closeSync(directoryFd);
        }
      }
      return {
        root,
        rootDev: String(rootStat.dev),
        rootIno: String(rootStat.ino),
        wrapperPath: wrapper.realPath,
        payload: copied,
        manifestPath,
        manifestSha256: manifest.sha256,
        closureSha256: crypto.createHash('sha256').update(canonical).digest('hex'),
        directories: directoryDescriptors,
      };
    } finally {
      fs.closeSync(manifest.fd);
    }
  } catch (error) {
    // The root was just created by this process.  Still bind cleanup to its
    // original descriptor identity rather than trusting a current pathname.
    try {
      tombstoneOwnedDirectory(root, String(rootStat.dev), String(rootStat.ino));
    } catch {
      /* retain failed materialization for diagnosis */
    }
    throw error;
  }
}

function hashReleasePayloadSemantics(root, payload) {
  const canonical = payload
    .map((entry) => {
      const relative = path.relative(root, entry.realPath);
      if (
        !relative ||
        relative === '..' ||
        relative.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relative)
      ) {
        throw new Error(`release payload escaped sealed backing: ${entry.realPath}`);
      }
      return `${relative}\u0000${entry.sha256}\u0000${entry.role}`;
    })
    .sort()
    .join('\n');
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

// Open every member before changing any permission.  The directory list was
// captured while the payload was sealed; all subsequent permission changes are
// descriptor operations, so they remain tied to those exact inodes even if a
// mutable pathname is raced after a parent becomes writable.
function restoreVerifiedReleaseDirectoryWritePermissions(payload) {
  if (!Array.isArray(payload.directories) || payload.directories.length === 0) {
    throw new Error('immutable release directory descriptors are unavailable');
  }
  const opened = [];
  try {
    for (const expected of payload.directories) {
      const fd = fs.openSync(
        expected.path,
        fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW
      );
      const stat = fs.fstatSync(fd, { bigint: true });
      if (
        !stat.isDirectory() ||
        String(stat.dev) !== expected.dev ||
        String(stat.ino) !== expected.ino ||
        (Number(stat.mode) & 0o222) !== 0
      ) {
        fs.closeSync(fd);
        throw new Error(`immutable release directory identity changed: ${expected.path}`);
      }
      opened.push({ fd, expected });
    }
    // Authenticate the complete immutable directory closure before the first
    // write-enabling mutation.  This makes the subsequent cleanup authority a
    // consequence of the pinned release payload, not a fresh pathname trust.
    for (const { fd, expected } of opened) {
      const stat = fs.fstatSync(fd, { bigint: true });
      if (
        !stat.isDirectory() ||
        String(stat.dev) !== expected.dev ||
        String(stat.ino) !== expected.ino ||
        (Number(stat.mode) & 0o222) !== 0
      ) {
        throw new Error(
          `immutable release directory changed before permission restore: ${expected.path}`
        );
      }
    }
    for (const { fd, expected } of opened) {
      const stat = fs.fstatSync(fd, { bigint: true });
      if (
        !stat.isDirectory() ||
        String(stat.dev) !== expected.dev ||
        String(stat.ino) !== expected.ino ||
        (Number(stat.mode) & 0o222) !== 0
      ) {
        throw new Error(
          `immutable release directory changed immediately before restore: ${expected.path}`
        );
      }
      fs.fchmodSync(fd, 0o700);
    }
  } finally {
    for (const { fd } of opened) {
      try {
        fs.closeSync(fd);
      } catch {
        /* best-effort descriptor cleanup */
      }
    }
  }
}

function requireManifestPath(value, name) {
  if (typeof value !== 'string' || !value.trim())
    throw new Error(`release manifest ${name} is missing`);
  return path.resolve(value);
}

function assertPathWithinRepository(candidate, repositoryRoot) {
  const relative = path.relative(repositoryRoot, candidate);
  if (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  )
    return;
  throw new Error(`release payload path is outside repository root: ${candidate}`);
}

function openReleaseDescriptor(target, expected = {}) {
  const fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const before = fs.fstatSync(fd, { bigint: true });
    if (
      !before.isFile() ||
      before.size < 0n ||
      before.size > BigInt(MAX_RELEASE_DESCRIPTOR_BYTES)
    ) {
      throw new Error(`release descriptor is not a bounded regular file: ${target}`);
    }
    const descriptor = {
      fd,
      target,
      dev: String(before.dev),
      ino: String(before.ino),
      size: Number(before.size),
      mode: Number(before.mode),
      sha256: crypto
        .createHash('sha256')
        .update(readBoundedReleaseDescriptor(fd, Number(before.size)))
        .digest('hex'),
    };
    if (
      (expected.dev !== undefined && descriptor.dev !== String(expected.dev)) ||
      (expected.ino !== undefined && descriptor.ino !== String(expected.ino)) ||
      (expected.size !== undefined && descriptor.size !== Number(expected.size)) ||
      (expected.sha256 !== undefined && descriptor.sha256 !== String(expected.sha256).toLowerCase())
    )
      throw new Error(`release descriptor changed while opening: ${target}`);
    revalidateReleaseDescriptor(descriptor);
    return descriptor;
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}

function readBoundedReleaseDescriptor(fd, size) {
  const chunks = [];
  const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, Math.max(size, 1)));
  for (let offset = 0; offset < size; ) {
    const read = fs.readSync(fd, buffer, 0, Math.min(buffer.length, size - offset), offset);
    if (read <= 0) throw new Error('release descriptor was truncated during bounded read');
    chunks.push(Buffer.from(buffer.subarray(0, read)));
    offset += read;
  }
  return Buffer.concat(chunks, size);
}

function revalidateReleaseDescriptor(descriptor) {
  const before = fs.fstatSync(descriptor.fd, { bigint: true });
  if (
    String(before.dev) !== descriptor.dev ||
    String(before.ino) !== descriptor.ino ||
    Number(before.size) !== descriptor.size ||
    crypto
      .createHash('sha256')
      .update(readBoundedReleaseDescriptor(descriptor.fd, Number(before.size)))
      .digest('hex') !== descriptor.sha256
  )
    throw new Error(`release descriptor changed before effect: ${descriptor.target}`);
  const after = fs.fstatSync(descriptor.fd, { bigint: true });
  if (
    String(after.dev) !== descriptor.dev ||
    String(after.ino) !== descriptor.ino ||
    Number(after.size) !== descriptor.size
  ) {
    throw new Error(`release descriptor identity changed before effect: ${descriptor.target}`);
  }
}

function createDisposableProjectRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-launch-stress-run-'));
  const projectPath = path.join(root, 'project');
  const token = crypto.randomBytes(32).toString('hex');
  const invocationId = crypto.randomUUID();
  fs.mkdirSync(projectPath, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(projectPath, 'README.md'),
    '# Disposable provider launch canary project\n',
    {
      mode: 0o600,
    }
  );
  fs.writeFileSync(
    path.join(root, '.provider-launch-stress-owner.json'),
    JSON.stringify({
      version: 1,
      root: fs.realpathSync(root),
      projectPath: fs.realpathSync(projectPath),
      token,
      invocationId,
    }) + '\n',
    { mode: 0o600 }
  );
  const failureReservationManifest = path.join(
    root,
    '.provider-launch-stress-failure-reservations.json'
  );
  fs.writeFileSync(
    failureReservationManifest,
    JSON.stringify({
      version: 1,
      root: fs.realpathSync(root),
      token,
      invocationId,
      reservations: [],
    }) + '\n',
    { mode: 0o600, flag: 'wx' }
  );
  const realRoot = fs.realpathSync(root);
  const realProjectPath = fs.realpathSync(projectPath);
  const rootStat = fs.statSync(realRoot, { bigint: true });
  const projectStat = fs.statSync(realProjectPath, { bigint: true });
  const markerStat = fs.statSync(path.join(realRoot, '.provider-launch-stress-owner.json'), {
    bigint: true,
  });
  return {
    root: realRoot,
    projectPath: realProjectPath,
    token,
    invocationId,
    failureReservationManifest,
    rootDev: String(rootStat.dev),
    rootIno: String(rootStat.ino),
    projectDev: String(projectStat.dev),
    projectIno: String(projectStat.ino),
    markerDev: String(markerStat.dev),
    markerIno: String(markerStat.ino),
  };
}

function openOwnedProjectDirectoryLease(project) {
  const before = fs.lstatSync(project.projectPath, { bigint: true });
  if (
    !before.isDirectory() ||
    before.isSymbolicLink() ||
    String(before.dev) !== project.projectDev ||
    String(before.ino) !== project.projectIno
  ) {
    throw new Error('Disposable project identity changed before worker lease creation.');
  }
  const fd = fs.openSync(
    project.projectPath,
    fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW
  );
  try {
    const opened = fs.fstatSync(fd, { bigint: true });
    if (
      !opened.isDirectory() ||
      String(opened.dev) !== project.projectDev ||
      String(opened.ino) !== project.projectIno
    ) {
      throw new Error('Disposable project changed while opening worker lease.');
    }
    return fd;
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}

function createIsolatedProviderRoots(project, source) {
  const home = path.join(project.root, 'provider-home');
  const claudeConfigDir = path.join(project.root, 'provider-claude-config');
  const codexHome = path.join(project.root, 'provider-codex-home');
  const xdgDataHome = path.join(project.root, 'provider-xdg-data');
  const xdgConfigHome = path.join(project.root, 'provider-xdg-config');
  for (const target of [home, claudeConfigDir, codexHome, xdgDataHome, xdgConfigHome]) {
    fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  }

  // Construct the complete source -> destination plan before making any
  // copy.  Apart from making this auditable, the destination-keyed map makes
  // an active accounts/<id>.auth.json exactly-once even though the directory
  // enumeration also sees it.
  const copyPlan = new Map();
  const addCopy = (sourcePath, destinationPath) => {
    const destinationKey = path.resolve(destinationPath);
    const existing = copyPlan.get(destinationKey);
    if (existing && existing !== sourcePath) {
      throw new Error(`Conflicting isolated auth destination: ${destinationKey}`);
    }
    copyPlan.set(destinationKey, sourcePath);
  };
  for (const name of ['.credentials.json', '.config.json', 'settings.json']) {
    addCopy(path.join(source.claudeConfigDir, name), path.join(claudeConfigDir, name));
  }
  addCopy(path.join(source.home, '.claude.json'), path.join(claudeConfigDir, '.claude.json'));
  addCopy(path.join(source.codexHome, 'auth.json'), path.join(codexHome, 'auth.json'));
  const sourceAccounts = path.join(source.codexHome, 'accounts');
  const destinationAccounts = path.join(codexHome, 'accounts');
  const registryPath = path.join(sourceAccounts, 'registry.json');
  addCopy(registryPath, path.join(destinationAccounts, 'registry.json'));
  const registry = readJsonIfExists(registryPath);
  const activeAccountId =
    readStringProperty(registry, 'active_account_id') ??
    readStringProperty(registry, 'activeAccountId') ??
    readStringProperty(registry, 'current_account_id') ??
    readStringProperty(registry, 'currentAccountId');
  if (activeAccountId) {
    if (!/^[A-Za-z0-9._-]+$/.test(activeAccountId)) {
      throw new Error('Refused unsafe Codex active-account identifier.');
    }
    addCopy(
      path.join(sourceAccounts, `${activeAccountId}.auth.json`),
      path.join(destinationAccounts, `${activeAccountId}.auth.json`)
    );
  }
  // Older Codex registries have no active-account field.  Copy only auth
  // descriptors, never cache/history/config trees from the invoking user.
  for (const name of safeReaddirFileNames(sourceAccounts)) {
    if (name.endsWith('.auth.json')) {
      addCopy(path.join(sourceAccounts, name), path.join(destinationAccounts, name));
    }
  }

  const sourceXdgData =
    process.env.XDG_DATA_HOME?.trim() || path.join(source.home, '.local', 'share');
  const sourceXdgConfig = process.env.XDG_CONFIG_HOME?.trim() || path.join(source.home, '.config');
  for (const [sourceRoot, targetRoot] of [
    [sourceXdgData, xdgDataHome],
    [sourceXdgConfig, xdgConfigHome],
  ]) {
    for (const name of ['auth.json', 'config.json']) {
      addCopy(path.join(sourceRoot, 'opencode', name), path.join(targetRoot, 'opencode', name));
    }
  }
  // Gemini's OAuth state is in the Claude config descriptors above.  ADC is
  // separately copied into an owned gcloud root and, if it was explicitly
  // selected by the caller, its environment variable is rewritten below.
  const sourceAdc =
    source.googleApplicationCredentials ||
    path.join(sourceXdgConfig, 'gcloud', 'application_default_credentials.json');
  const isolatedAdc = path.join(xdgConfigHome, 'gcloud', 'application_default_credentials.json');
  addCopy(sourceAdc, isolatedAdc);
  for (const [destination, sourcePath] of [...copyPlan.entries()].sort(([left], [right]) =>
    left.localeCompare(right)
  )) {
    copyOptionalRegularFile(sourcePath, destination);
  }
  return {
    home,
    claudeConfigDir,
    codexHome,
    xdgDataHome,
    xdgConfigHome,
    googleApplicationCredentials: isolatedAdc,
  };
}

function copyOptionalRegularFile(source, destination) {
  let sourceStat;
  try {
    sourceStat = fs.lstatSync(source, { bigint: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
  if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) {
    throw new Error(`Refused non-regular auth descriptor: ${source}`);
  }
  const fd = fs.openSync(source, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const opened = fs.fstatSync(fd, { bigint: true });
    if (opened.dev !== sourceStat.dev || opened.ino !== sourceStat.ino || !opened.isFile()) {
      throw new Error(`Auth descriptor changed while opening: ${source}`);
    }
    fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
    // Preserve the source descriptor permissions.  The enclosing invocation
    // root is 0700 and the destination is create-only, so this is both a
    // minimum read-only seed and cannot overwrite an existing auth file.
    fs.writeFileSync(destination, fs.readFileSync(fd), {
      mode: Number(opened.mode & 0o777),
      flag: 'wx',
    });
    return true;
  } finally {
    fs.closeSync(fd);
  }
}

function assertOwnedDisposableRunRoot(project) {
  if (!project) return false;
  try {
    const root = fs.lstatSync(project.root, { bigint: true });
    if (
      !root.isDirectory() ||
      root.isSymbolicLink() ||
      String(root.dev) !== project.rootDev ||
      String(root.ino) !== project.rootIno
    )
      return false;
    const markerPath = path.join(project.root, '.provider-launch-stress-owner.json');
    const markerLstat = fs.lstatSync(markerPath, { bigint: true });
    if (!markerLstat.isFile() || markerLstat.isSymbolicLink()) return false;
    const markerFd = fs.openSync(markerPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const markerStat = fs.fstatSync(markerFd, { bigint: true });
      if (
        !markerStat.isFile() ||
        markerStat.dev !== markerLstat.dev ||
        markerStat.ino !== markerLstat.ino ||
        String(markerStat.dev) !== project.markerDev ||
        String(markerStat.ino) !== project.markerIno
      )
        return false;
      const marker = JSON.parse(fs.readFileSync(markerFd, 'utf8'));
      return (
        marker?.version === 1 &&
        marker.root === project.root &&
        marker.projectPath === project.projectPath &&
        marker.token === project.token &&
        marker.invocationId === project.invocationId &&
        path.dirname(project.projectPath) === project.root
      );
    } finally {
      fs.closeSync(markerFd);
    }
  } catch {
    return false;
  }
}

function readLinuxProcessIdentity(procPath) {
  try {
    const stat = fs.readFileSync(`${procPath}/stat`, 'utf8');
    const closingParen = stat.lastIndexOf(')');
    if (closingParen < 0) return null;
    const pid = Number.parseInt(stat.slice(0, stat.indexOf(' ')), 10);
    const fields = stat.slice(closingParen + 2).split(' ');
    const parentPid = Number.parseInt(fields[1] ?? '', 10);
    const startTicks = fields[19] ?? '';
    if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(parentPid) || !startTicks) return null;
    return { pid, parentPid, startTicks };
  } catch {
    return null;
  }
}

async function preflightProviderLaunchStress(input) {
  const requested = parseScenarioOrder(input.requestedOrder);
  if (!sameOrder(requested, REQUIRED_PROVIDER_ORDER)) {
    return {
      ok: false,
      order: [],
      skipped: [
        { scenario: 'required-order', reason: `must be ${REQUIRED_PROVIDER_ORDER.join(',')}` },
      ],
      messages: [
        `Required provider order is ${REQUIRED_PROVIDER_ORDER.join(',')}; received ${requested.join(',')}`,
      ],
    };
  }
  const needs = {
    anthropic: true,
    codex: true,
    gemini: true,
    opencode: true,
  };
  let checks = input.checks;
  if (!checks) {
    // Keep the awaits explicit. A signal may begin cleanup while any provider
    // preflight is pending; each completed await must re-check admission
    // before the next preflight or any later worker allocation can proceed.
    const anthropic = needs.anthropic ? await preflightAnthropic(input.repoRoot) : { ok: true };
    assertProviderLaunchStressAdmissionOpen('continuation after Anthropic preflight');
    const codex = needs.codex ? preflightCodex() : { ok: true };
    const gemini = needs.gemini ? await preflightGemini() : { ok: true };
    assertProviderLaunchStressAdmissionOpen('continuation after Gemini preflight');
    const opencode = needs.opencode
      ? await preflightOpenCodeLiveEnvironment({
          repoRoot: input.repoRoot,
          requiredModels: [env.PROVIDER_LAUNCH_STRESS_OPENCODE_MODEL],
          env,
        })
      : { ok: true };
    assertProviderLaunchStressAdmissionOpen('continuation after OpenCode preflight');
    checks = { anthropic, codex, gemini, opencode };
  }
  const skipped = [];
  const order = [];
  for (const scenario of requested) {
    const unavailable = scenarioDependencies(scenario).filter((provider) => !checks[provider].ok);
    if (unavailable.length > 0) {
      skipped.push({
        scenario,
        reason: unavailable.map((provider) => `${provider}: ${checks[provider].reason}`).join('; '),
      });
      continue;
    }
    order.push(scenario);
  }

  return {
    ok: skipped.length === 0 && sameOrder(order, REQUIRED_PROVIDER_ORDER),
    order,
    skipped,
    messages: [
      ...Object.entries(checks)
        .filter(([provider]) => needs[provider])
        .map(([provider, check]) =>
          check.ok
            ? `Preflight ${provider}: ok`
            : `Preflight ${provider}: unavailable - ${check.reason}`
        ),
      ...skipped.map((item) => `Skipping ${item.scenario}: ${item.reason}`),
    ],
  };
}

function parseScenarioOrder(value) {
  const parsed = value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  return parsed.length > 0 ? parsed : [...REQUIRED_PROVIDER_ORDER];
}

function sameOrder(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function scenarioDependencies(scenario) {
  if (scenario === 'mixed') return ['anthropic', 'codex', 'gemini', 'opencode'];
  return [scenario];
}

async function preflightGemini() {
  const model = env.PROVIDER_LAUNCH_STRESS_GEMINI_MODEL?.trim();
  if (!model) return { ok: false, reason: 'PROVIDER_LAUNCH_STRESS_GEMINI_MODEL is empty' };
  const apiKey = env.GEMINI_API_KEY?.trim();
  const config = readGeminiConfigIfExists(path.join(env.CLAUDE_CONFIG_DIR, '.config.json'));
  const auth = resolveGeminiAuth({
    apiKey,
    config,
    projectId:
      env.GOOGLE_CLOUD_PROJECT?.trim() ||
      env.GOOGLE_CLOUD_PROJECT_ID?.trim() ||
      env.GCLOUD_PROJECT?.trim(),
    backend: env.PROVIDER_LAUNCH_STRESS_GEMINI_BACKEND,
  });
  if (!auth.ok) return auth;
  return { ok: true, reason: `Gemini ${model} auth configured as ${auth.backend}` };
}

function normalizeGeminiBackend(value) {
  if (value === undefined || value === null || value === '') return { ok: true, value: 'auto' };
  if (typeof value !== 'string') return { ok: false, reason: 'backend must be a string' };
  const normalized = value.trim().toLowerCase();
  const canonical = normalized === 'cli' ? 'cli-sdk' : normalized || 'auto';
  return GEMINI_BACKENDS.has(canonical)
    ? { ok: true, value: canonical }
    : { ok: false, reason: `unsupported backend ${JSON.stringify(value)}` };
}

function resolveGeminiAuth({ apiKey, config, projectId, backend }) {
  const fields = validateGeminiConfig(config);
  if (!fields.ok) return fields;
  const requested = normalizeGeminiBackend(
    backend ?? fields.backendPreference ?? fields.resolvedBackend
  );
  if (!requested.ok) return requested;
  const effectiveProject = projectId || fields.projectId;
  const hasAdcProject =
    (fields.authMethod === 'adc_authorized_user' || fields.authMethod === 'adc_service_account') &&
    Boolean(effectiveProject);
  const selected =
    requested.value !== 'auto'
      ? requested.value
      : apiKey || hasAdcProject
        ? 'api'
        : fields.authMethod === 'cli_oauth_personal'
          ? 'cli-sdk'
          : 'auto';
  const authorized =
    (selected === 'api' && (Boolean(apiKey) || hasAdcProject)) ||
    (selected === 'cli-sdk' && fields.authMethod === 'cli_oauth_personal');
  return authorized
    ? { ok: true, backend: selected }
    : { ok: false, reason: `Gemini auth unavailable for backend ${selected}` };
}

function validateGeminiConfig(config) {
  if (config === INVALID_GEMINI_CONFIG) {
    return { ok: false, reason: 'Gemini config is invalid JSON or not an object' };
  }
  if (config === null || config === undefined) {
    return {
      ok: true,
      authMethod: null,
      projectId: null,
      backendPreference: null,
      resolvedBackend: null,
    };
  }
  if (typeof config !== 'object' || Array.isArray(config)) {
    return { ok: false, reason: 'Gemini config must be an object' };
  }
  const fields = {};
  for (const key of [
    'geminiLastAuthMethod',
    'geminiProjectId',
    'geminiBackendPreference',
    'geminiResolvedBackend',
  ]) {
    if (!(key in config)) continue;
    if (typeof config[key] !== 'string') return { ok: false, reason: `${key} must be a string` };
    fields[key] = config[key].trim();
  }
  const backendPreference = normalizeGeminiBackend(fields.geminiBackendPreference);
  const resolvedBackend = normalizeGeminiBackend(fields.geminiResolvedBackend);
  if (!backendPreference.ok) return backendPreference;
  if (!resolvedBackend.ok) return resolvedBackend;
  return {
    ok: true,
    authMethod: fields.geminiLastAuthMethod || null,
    projectId: fields.geminiProjectId || null,
    backendPreference: backendPreference.value === 'auto' ? null : backendPreference.value,
    resolvedBackend: resolvedBackend.value === 'auto' ? null : resolvedBackend.value,
  };
}

function readGeminiConfigIfExists(filePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed
      : INVALID_GEMINI_CONFIG;
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    return INVALID_GEMINI_CONFIG;
  }
}

async function preflightAnthropic(repoRoot) {
  const mode = env.PROVIDER_LAUNCH_STRESS_ANTHROPIC_AUTH.toLowerCase();
  if (mode === 'api-key') {
    return env.ANTHROPIC_API_KEY?.trim()
      ? { ok: true }
      : { ok: false, reason: 'ANTHROPIC_API_KEY is not configured' };
  }

  const version = spawnSync('claude', ['--version'], {
    cwd: repoRoot,
    env,
    encoding: 'utf8',
    timeout: 15_000,
    maxBuffer: 128_000,
  });
  if (version.status !== 0) {
    return {
      ok: false,
      reason: compactOutput(
        version.stderr || version.stdout || version.error?.message || 'claude --version failed'
      ),
    };
  }
  return { ok: true };
}

function preflightCodex() {
  const codexHome = path.resolve(
    env.PROVIDER_LAUNCH_STRESS_CODEX_HOME?.trim() ||
      env.CODEX_HOME?.trim() ||
      path.join(env.HOME, '.codex')
  );
  if (hasCodexSubscriptionAuth(codexHome)) {
    return { ok: true };
  }
  return { ok: false, reason: `Codex subscription auth not found in ${codexHome}` };
}

function hasCodexSubscriptionAuth(codexHome) {
  const legacyAuth = readJsonIfExists(path.join(codexHome, 'auth.json'));
  if (isCodexChatGptSubscriptionAuth(legacyAuth)) return true;

  const accountsDir = path.join(codexHome, 'accounts');
  const registry = readJsonIfExists(path.join(accountsDir, 'registry.json'));
  const activeAccountId =
    readStringProperty(registry, 'active_account_id') ??
    readStringProperty(registry, 'activeAccountId') ??
    readStringProperty(registry, 'current_account_id') ??
    readStringProperty(registry, 'currentAccountId');
  const candidates = new Set();
  if (activeAccountId) {
    candidates.add(path.join(accountsDir, `${activeAccountId}.auth.json`));
    candidates.add(path.join(accountsDir, activeAccountId));
  }
  for (const entry of safeReaddirFileNames(accountsDir)) {
    if (entry.endsWith('.auth.json')) candidates.add(path.join(accountsDir, entry));
  }
  for (const candidate of candidates) {
    if (isCodexChatGptSubscriptionAuth(readJsonIfExists(candidate))) return true;
  }
  return false;
}

function readJsonIfExists(filePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function readStringProperty(source, key) {
  const value = source?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function isCodexChatGptSubscriptionAuth(source) {
  if (!source) return false;
  const direct = readStringProperty(source, 'refresh_token');
  const tokens = source.tokens;
  const nested =
    tokens && typeof tokens === 'object' && !Array.isArray(tokens)
      ? readStringProperty(tokens, 'refresh_token')
      : null;
  return Boolean(direct || nested);
}

function packageLatestLaunchFailureArtifacts() {
  if (!scrubCopiedProviderCredentialsBeforeEvidence()) {
    credentialScrubFailureDetected = true;
    preserveRunEvidence = false;
    process.exitCode = 1;
    console.error('Refused to preserve launch failure evidence because copied credentials could not be scrubbed.');
    return;
  }
  if (!revalidateReleaseClosureBeforeTeardownEffect('publish launch failure evidence')) return;
  const artifacts = findInvocationOwnedLaunchFailureArtifactDirs();
  if (artifacts.length === 0) {
    console.error('No launch failure artifact pack found under ~/.claude/teams.');
    return;
  }
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-team-launch-failure-artifacts-'));
  // Authenticate this deletion target at creation time.  The finally block
  // must not grant itself authority by statting whichever object happens to
  // occupy the staging pathname after artifact collection.
  const stagingIdentity = fs.statSync(staging, { bigint: true });
  try {
    for (const artifact of artifacts) {
      if (
        !revalidateReleaseClosureBeforeTeardownEffect(
          `publish failure evidence for ${artifact.teamName}`
        )
      )
        return;
      if (
        !isReservationStillOwned(
          path.join(env.CLAUDE_CONFIG_DIR, 'teams'),
          artifact.teamName,
          artifact.token
        )
      ) {
        console.error(
          `Refused failure evidence for ${artifact.teamName}: invocation ownership changed.`
        );
        continue;
      }
      const destination = path.join(staging, `${artifact.teamName}-${path.basename(artifact.dir)}`);
      fs.cpSync(artifact.dir, destination, { recursive: true });
    }
    const bundle = path.join(
      os.tmpdir(),
      `agent-team-launch-failure-artifacts-${new Date().toISOString().replace(/[:.]/g, '-')}.tar.gz`
    );
    if (!revalidateReleaseClosureBeforeTeardownEffect('publish launch failure artifact bundle'))
      return;
    const tar = spawnSync('tar', ['-czf', bundle, '-C', staging, '.'], {
      encoding: 'utf8',
      timeout: 30_000,
      maxBuffer: 256_000,
    });
    if (tar.status !== 0) {
      console.error(
        `Failed to create artifact bundle: ${compactOutput(tar.stderr || tar.stdout || tar.error?.message || 'tar failed')}`
      );
      return;
    }
    console.error(`Launch failure artifact bundle: ${bundle}`);
  } finally {
    if (
      assertOwnedDisposableRunRoot(disposableRunProject) &&
      withVerifiedReleaseDescriptorsImmediatelyBeforeEffect(
        'delete failure evidence staging root',
        () => {
          tombstoneOwnedDirectory(
            staging,
            String(stagingIdentity.dev),
            String(stagingIdentity.ino)
          );
        }
      )
    ) {
      // Deleted inside the descriptor-pinned callback above.
    }
  }
}

/**
 * The disposable provider roots contain copied login state solely for this
 * run. Remove the full auth-only roots and every known copied descriptor from
 * roots that also contain launch artifacts. Credential formats evolve, so a
 * partial field-level redaction is not acceptable before retaining evidence.
 */
function enableEvidenceRetention(reason) {
  // Retention is a privileged final state: unlike ordinary cleanup it leaves
  // bytes behind after the wrapper exits. Every path that enables it must
  // first use the descriptor-pinned scrubber, including a failure of the
  // normal root deletion itself. Once scrub certainty is lost, never retry
  // into retention later in the same invocation.
  if (credentialScrubFailureDetected || !scrubCopiedProviderCredentialsBeforeEvidence()) {
    credentialScrubFailureDetected = true;
    preserveRunEvidence = false;
    process.exitCode = 1;
    console.error(
      `Refused to retain disposable canary evidence after ${reason}: copied credentials could not be descriptor-scrubbed.`
    );
    return false;
  }
  preserveRunEvidence = true;
  return true;
}

function scrubCopiedProviderCredentialsBeforeEvidence() {
  if (!disposableRunProject || !disposableRunRoot) return true;
  if (!assertOwnedDisposableRunRoot(disposableRunProject)) {
    console.error('Refused credential scrub: disposable canary root ownership changed.');
    return false;
  }
  const sensitivePaths = [
    // HOME and Codex roots are created solely for this run's copied auth.
    'provider-home',
    'provider-codex-home',
    // Keep Claude's teams directory for its launch-failure pack, but remove
    // every copied Claude descriptor before it can be preserved. Runtime auth
    // is a credential-bearing directory, not a set of stable filenames:
    // remove the whole invocation-owned tree before retaining any evidence.
    'provider-claude-config/team-runtime-auth',
    'provider-claude-config/.credentials.json',
    'provider-claude-config/.config.json',
    'provider-claude-config/settings.json',
    'provider-claude-config/.claude.json',
    // OpenCode and ADC copies are confined to these exact owned locations.
    'provider-xdg-data/opencode',
    'provider-xdg-config/opencode',
    'provider-xdg-config/gcloud/application_default_credentials.json',
  ];
  let rootFd;
  const failures = [];
  try {
    rootFd = openOwnedDisposableRunRootDescriptor(disposableRunProject);
    for (const name of sensitivePaths) {
      try {
        removeCredentialPathRelativeToOwnedRoot(rootFd, name, disposableRunProject);
      } catch (error) {
        // Scrub every known credential location before deciding whether a
        // failure root may be retained. One bad location must never suppress
        // deletion attempts for the remainder of the copied provider state.
        failures.push(`${name}: ${compactOutput(error?.message || error)}`);
      }
    }
    if (failures.length > 0) {
      // Do not wait for the exit handler (or for release-closure
      // revalidation) after a targeted removal failed. Clear the complete
      // invocation-owned root through the already-open capability now; this
      // makes a later closure-verification failure incapable of retaining raw
      // copied credentials as evidence.
      try {
        eraseCredentialBearingRunRootThroughDescriptor(rootFd, disposableRunProject);
      } catch (error) {
        failures.push(`whole root: ${compactOutput(error?.message || error)}`);
      }
      console.error(`Credential scrub failed: ${failures.join('; ')}`);
      return false;
    }
    return true;
  } catch (error) {
    console.error(`Credential scrub failed: ${compactOutput(error?.message || error)}`);
    return false;
  } finally {
    // The child environment is not an evidence artifact, but clearing these
    // prevents any late failure formatter or helper from accidentally reading
    // a raw credential even when opening or removing a root was uncertain.
    for (const name of [
      'ANTHROPIC_API_KEY',
      'GEMINI_API_KEY',
      'GOOGLE_APPLICATION_CREDENTIALS',
    ]) {
      delete env[name];
    }
    if (rootFd !== undefined) {
      try {
        fs.closeSync(rootFd);
      } catch {
        // A closed descriptor cannot make an uncertain scrub successful.
      }
    }
  }
}

// This is deliberately independent of release-closure revalidation. Once a
// targeted credential removal has failed, retaining an invocation-owned root
// is unsafe; its descriptor-pinned ownership is sufficient authority to erase
// it. `tombstoneOwnedDirectory` only clears the verified directory object, so
// a pathname replacement cannot redirect this emergency cleanup.
function eraseCredentialBearingDisposableRunRoot(project) {
  if (!project || !assertOwnedDisposableRunRoot(project)) return false;
  try {
    tombstoneOwnedDirectory(disposableRunRoot, project.rootDev, project.rootIno);
    return true;
  } catch (error) {
    console.error(
      `Credential-bearing disposable root erase failed: ${compactOutput(error?.message || error)}`
    );
    return false;
  }
}

function eraseCredentialBearingRunRootThroughDescriptor(rootFd, project) {
  const helper = String.raw`
import os, stat, sys
root_fd, expected_dev, expected_ino = map(int, sys.argv[1:])
root = os.fstat(root_fd)
if root.st_dev != expected_dev or root.st_ino != expected_ino or not stat.S_ISDIR(root.st_mode):
    raise RuntimeError('credential root identity changed')
def clear(directory_fd):
    for name in os.listdir(directory_fd):
        entry = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
        if stat.S_ISDIR(entry.st_mode):
            child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory_fd)
            try:
                clear(child)
            finally:
                os.close(child)
            os.rmdir(name, dir_fd=directory_fd)
        else:
            os.unlink(name, dir_fd=directory_fd)
clear(root_fd)
`;
  const result = spawnSync(
    'python3',
    ['-c', helper, '3', project.rootDev, project.rootIno],
    { encoding: 'utf8', timeout: 10_000, maxBuffer: 64 * 1024, stdio: ['ignore', 'ignore', 'pipe', rootFd] }
  );
  if (result.status !== 0) {
    throw new Error(
      `credential root descriptor erase failed: ${compactOutput(result.stderr || result.error?.message || 'helper failed')}`
    );
  }
}

function openOwnedDisposableRunRootDescriptor(project) {
  const fd = fs.openSync(
    project.root,
    fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW
  );
  try {
    const stat = fs.fstatSync(fd, { bigint: true });
    if (
      !stat.isDirectory() ||
      String(stat.dev) !== project.rootDev ||
      String(stat.ino) !== project.rootIno
    ) {
      throw new Error('disposable canary root identity changed while opening scrub anchor');
    }
    return fd;
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}

// `rm(path)` would resolve every nested component again. This helper receives
// only the already-authenticated root descriptor and walks each child with
// dir_fd + O_NOFOLLOW, so a nested symlink or root pathname replacement cannot
// redirect credential removal outside this invocation-owned root.
function removeCredentialPathRelativeToOwnedRoot(rootFd, relativePath, project) {
  const segments = relativePath.split('/');
  if (
    !relativePath ||
    path.isAbsolute(relativePath) ||
    segments.some(
      (segment) =>
        !segment ||
        segment === '.' ||
        segment === '..' ||
        segment.includes(path.sep) ||
        segment.includes('\\')
    )
  ) {
    throw new Error('credential scrub path is not a safe root-relative descriptor path');
  }
  const helper = String.raw`
import os, stat, sys
root_fd, expected_dev, expected_ino, relative = sys.argv[1:]
root_fd = int(root_fd)
parts = relative.split('/')
if not parts or any(not part or part in ('.', '..') or '/' in part or '\\' in part for part in parts):
    raise RuntimeError('unsafe credential scrub path')
root = os.fstat(root_fd)
if str(root.st_dev) != expected_dev or str(root.st_ino) != expected_ino or not stat.S_ISDIR(root.st_mode):
    raise RuntimeError('credential scrub root identity changed')
def remove_tree(parent_fd, name):
    try:
        entry = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
    except FileNotFoundError:
        return
    if stat.S_ISDIR(entry.st_mode):
        child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent_fd)
        try:
            for child_name in os.listdir(child):
                remove_tree(child, child_name)
        finally:
            os.close(child)
        os.rmdir(name, dir_fd=parent_fd)
    else:
        os.unlink(name, dir_fd=parent_fd)
parent = os.dup(root_fd)
try:
    for part in parts[:-1]:
        try:
            entry = os.stat(part, dir_fd=parent, follow_symlinks=False)
        except FileNotFoundError:
            sys.exit(0)
        if not stat.S_ISDIR(entry.st_mode):
            raise RuntimeError('credential scrub ancestor is not a directory')
        child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
        os.close(parent)
        parent = child
    remove_tree(parent, parts[-1])
finally:
    os.close(parent)
`;
  const result = spawnSync(
    'python3',
    // The helper receives the authenticated root as its fixed FD 3. Passing
    // the parent's descriptor number here would make the child inspect an
    // unrelated (or closed) descriptor instead of its inherited capability.
    ['-c', helper, '3', project.rootDev, project.rootIno, relativePath],
    { encoding: 'utf8', timeout: 10_000, maxBuffer: 64 * 1024, stdio: ['ignore', 'ignore', 'pipe', rootFd] }
  );
  if (result.status !== 0) {
    throw new Error(
      `credential scrub descriptor walk failed: ${compactOutput(result.stderr || result.error?.message || 'helper failed')}`
    );
  }
}

// The initial artifact verification authorizes launch only.  A canary can run
// for many minutes, so every wrapper-side teardown/evidence mutation checks
// the same v2 closure again rather than treating that old observation as a
// permanent grant.
function revalidateReleaseClosureBeforeTeardownEffect(effect) {
  const verification = immutableExecutionPayload
    ? verifyMaterializedExecutionPayload(immutableExecutionPayload)
    : verifyReleaseOrchestratorArtifact({ env });
  if (verification.ok) return true;
  enableEvidenceRetention(`${effect} release-closure verification failure`);
  console.error(
    `Provider launch stress refused ${effect}: release closure changed (${verification.reason}).`
  );
  return false;
}

function withVerifiedReleaseDescriptorsImmediatelyBeforeEffect(effect, action) {
  const verification = immutableExecutionPayload
    ? verifyMaterializedExecutionPayload(immutableExecutionPayload)
    : verifyReleaseOrchestratorArtifact({ env });
  if (!verification.ok) {
    enableEvidenceRetention(`${effect} release-descriptor verification failure`);
    console.error(
      `Provider launch stress refused ${effect}: release closure changed (${verification.reason}).`
    );
    return false;
  }
  const descriptors = [];
  try {
    descriptors.push(
      openReleaseDescriptor(verification.manifest.realPath, {
        sha256: verification.manifest.sha256,
      })
    );
    for (const entry of verification.payload)
      descriptors.push(openReleaseDescriptor(entry.realPath, entry));
    for (const descriptor of descriptors) revalidateReleaseDescriptor(descriptor);
    action();
    return true;
  } catch (error) {
    enableEvidenceRetention(`${effect} normal deletion failure`);
    console.error(
      `Provider launch stress refused ${effect}: ${error instanceof Error ? error.message : String(error)}`
    );
    return false;
  } finally {
    for (const descriptor of descriptors) {
      try {
        fs.closeSync(descriptor.fd);
      } catch {
        /* best-effort descriptor cleanup */
      }
    }
  }
}

function verifyMaterializedExecutionPayload(payload) {
  try {
    const root = fs.statSync(payload.root, { bigint: true });
    if (
      !root.isDirectory() ||
      String(root.dev) !== payload.rootDev ||
      String(root.ino) !== payload.rootIno
    ) {
      return { ok: false, reason: 'immutable execution payload root identity changed' };
    }
    const manifest = openReleaseDescriptor(payload.manifestPath, {
      sha256: payload.manifestSha256,
    });
    const descriptors = [manifest];
    try {
      for (const entry of payload.payload)
        descriptors.push(openReleaseDescriptor(entry.realPath, entry));
      for (const descriptor of descriptors) revalidateReleaseDescriptor(descriptor);
      return {
        ok: true,
        payload: payload.payload,
        manifest: { realPath: payload.manifestPath, sha256: payload.manifestSha256 },
      };
    } finally {
      for (const descriptor of descriptors) fs.closeSync(descriptor.fd);
    }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

function findInvocationOwnedLaunchFailureArtifactDirs() {
  const teamsRoot = path.join(env.CLAUDE_CONFIG_DIR, 'teams');
  const results = [];
  const reservationManifestPath = env.PROVIDER_LAUNCH_STRESS_FAILURE_RESERVATION_MANIFEST;
  const invocationId = env.PROVIDER_LAUNCH_STRESS_INVOCATION_ID;
  const projectRoot = env.PROVIDER_LAUNCH_STRESS_PROJECT_ROOT;
  const projectToken = env.PROVIDER_LAUNCH_STRESS_PROJECT_TOKEN;
  if (!reservationManifestPath || !invocationId || !projectRoot || !projectToken) {
    console.error('No invocation-owned failure-artifact reservation manifest is available.');
    return results;
  }
  const reservations = readInvocationReservations({
    reservationManifestPath,
    invocationId,
    projectRoot,
    projectToken,
  });
  for (const { teamName, token } of reservations) {
    if (!isReservationStillOwned(teamsRoot, teamName, token)) continue;
    const latestPath = path.join(teamsRoot, teamName, 'launch-failure-artifacts', 'latest.json');
    const latest = readJsonIfExists(latestPath);
    const manifestPath = typeof latest?.manifestPath === 'string' ? latest.manifestPath : null;
    const teamRoot = path.join(teamsRoot, teamName);
    const dir = manifestPath ? path.dirname(manifestPath) : null;
    if (!dir || !fs.existsSync(dir)) continue;
    let teamRootReal;
    let dirReal;
    try {
      teamRootReal = fs.realpathSync(teamRoot);
      dirReal = fs.realpathSync(dir);
    } catch {
      continue;
    }
    if (!isContainedPath(teamRootReal, dirReal)) continue;
    const stat = fs.statSync(dirReal);
    results.push({ teamName, token, dir: dirReal, mtimeMs: stat.mtimeMs });
  }
  return results;
}

function readInvocationReservations({
  reservationManifestPath,
  invocationId,
  projectRoot,
  projectToken,
}) {
  try {
    const root = fs.realpathSync(projectRoot);
    const manifestPath = fs.realpathSync(reservationManifestPath);
    if (!isContainedPath(root, manifestPath)) return [];
    const manifest = readJsonIfExists(manifestPath);
    if (
      manifest?.version !== 1 ||
      manifest.root !== root ||
      manifest.token !== projectToken ||
      manifest.invocationId !== invocationId ||
      !Array.isArray(manifest.reservations)
    )
      return [];
    const unique = new Map();
    for (const reservation of manifest.reservations) {
      if (
        !reservation ||
        typeof reservation.teamName !== 'string' ||
        typeof reservation.token !== 'string'
      )
        continue;
      if (
        !/^provider-stress-[a-zA-Z0-9._-]+$/.test(reservation.teamName) ||
        !/^[a-f0-9]{64}$/i.test(reservation.token)
      )
        continue;
      unique.set(reservation.teamName, {
        teamName: reservation.teamName,
        token: reservation.token,
      });
    }
    return [...unique.values()];
  } catch {
    return [];
  }
}

function isReservationStillOwned(teamsRoot, teamName, token) {
  const lock = readJsonIfExists(
    path.join(teamsRoot, '.provider-launch-stress-locks', `${teamName}.json`)
  );
  if (lock?.teamName === teamName && lock.token === token) return true;
  const marker = readJsonIfExists(
    path.join(teamsRoot, teamName, '.provider-launch-stress-owner.json')
  );
  return marker?.teamName === teamName && marker.token === token;
}

function isContainedPath(root, candidate) {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
}

function safeReaddirFileNames(dir) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

function compactOutput(value) {
  return String(value).replace(/\s+/g, ' ').trim().slice(0, 1_200);
}

/**
 * Canonical JSON for the launcher admission ABI.  Native JSON.stringify order
 * is not an authentication format: it changes with construction history.  A
 * recursively sorted, finite-value-only form makes the detached signature
 * portable across the wrapper, attestor, and worker without letting a second
 * serialization become an alternate signed message.
 */
function canonicalizeJson(value) {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new Error('capability canonical JSON rejects non-safe integers');
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalizeJson).join(',')}]`;
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error('capability canonical JSON rejects non-plain values');
  }
  const record = value;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalizeJson(record[key])}`)
    .join(',')}}`;
}

// JSON.parse creates a fresh object for the signed producer payload and for
// the outer receipt. Credential locks must therefore be compared by canonical
// structure, not JavaScript reference identity. Keep an absent field distinct
// from explicit null, matching the signed JSON field semantics.
function canonicalizeOptionalJson(value) {
  return value === undefined ? '__absent__' : canonicalizeJson(value);
}

function canonicalizeTrustedLauncherCapabilityAdmission(runtimeCapability) {
  return canonicalizeJson({
    domain: TRUSTED_LAUNCHER_CAPABILITY_ADMISSION_DOMAIN,
    version: 1,
    capability: runtimeCapability,
  });
}

// Linux has no rmdir-by-directory-fd operation.  The helper therefore never
// resolves a child through a mutable pathname: it opens the exact root with
// O_NOFOLLOW, removes every child descriptor-relatively, and leaves an empty
// root tombstone. A later replacement of the root pathname cannot be deleted.
function tombstoneOwnedDirectory(target, expectedDev, expectedIno) {
  const helper = String.raw`
import os, stat, sys
target, expected_dev, expected_ino = sys.argv[1:]
fd = os.open(target, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
def clear(directory_fd):
    for name in os.listdir(directory_fd):
        entry = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
        if stat.S_ISDIR(entry.st_mode):
            child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory_fd)
            try:
                clear(child)
            finally:
                os.close(child)
            os.rmdir(name, dir_fd=directory_fd)
        else:
            os.unlink(name, dir_fd=directory_fd)
try:
    info = os.fstat(fd)
    if str(info.st_dev) != expected_dev or str(info.st_ino) != expected_ino:
        raise RuntimeError('owned directory identity changed')
    clear(fd)
finally:
    os.close(fd)
`;
  const result = spawnSync(
    'python3',
    ['-c', helper, target, String(expectedDev), String(expectedIno)],
    {
      encoding: 'utf8',
      timeout: 10_000,
      maxBuffer: 64 * 1024,
    }
  );
  if (result.status !== 0) {
    throw new Error(
      `cannot tombstone owned directory safely: ${compactOutput(result.stderr || result.error?.message || 'helper failed')}`
    );
  }
}

function writeCapabilityReceipt({
  project,
  capabilityFd: fd,
  expectedSha256,
  downstreamGoogleApplicationCredentials,
}) {
  // This is intentionally non-secret retained evidence. Read the unlinked
  // descriptor through /proc (not from an in-memory copy), proving both what
  // the wrapper serialized and the environment handed downstream.
  const serialized = fs.readFileSync(`/proc/self/fd/${fd}`);
  const actualSha256 = crypto.createHash('sha256').update(serialized).digest('hex');
  if (actualSha256 !== expectedSha256) {
    throw new Error('Capability descriptor bytes changed before downstream environment setup.');
  }
  const envelope = JSON.parse(serialized.toString('utf8'));
  const capability =
    envelope?.version === 2 && typeof envelope.payload === 'string'
      ? JSON.parse(envelope.payload)
      : null;
  if (
    !capability ||
    typeof capability?.auth?.googleApplicationCredentials !== 'string' ||
    capability.auth.googleApplicationCredentials !== downstreamGoogleApplicationCredentials
  ) {
    throw new Error('Serialized capability and downstream ADC environment disagree.');
  }
  fs.writeFileSync(
    path.join(project.root, '.provider-launch-stress-capability-receipt.json'),
    JSON.stringify({
      version: 1,
      serializedCapabilitySha256: actualSha256,
      serializedAuth: capability.auth,
      serializedProject: capability.project,
      downstreamEnvironment: {
        GOOGLE_APPLICATION_CREDENTIALS: downstreamGoogleApplicationCredentials,
        NODE_OPTIONS: env.NODE_OPTIONS ?? null,
        NODE_PATH: env.NODE_PATH ?? null,
        NODE_REPL_EXTERNAL_MODULE: env.NODE_REPL_EXTERNAL_MODULE ?? null,
        NODE_PRESERVE_SYMLINKS: env.NODE_PRESERVE_SYMLINKS ?? null,
        NODE_PRESERVE_SYMLINKS_MAIN: env.NODE_PRESERVE_SYMLINKS_MAIN ?? null,
      },
    }) + '\n',
    { mode: 0o600, flag: 'wx' }
  );
}
