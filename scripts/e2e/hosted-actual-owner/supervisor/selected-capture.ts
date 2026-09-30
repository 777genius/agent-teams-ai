import { closeSync, constants, fchmodSync, fstatSync, openSync, readFileSync, readSync,
  readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type { RuntimeCaptureName } from '../contracts';
import type { ProcessExitEvidence, ProcessStartEvidence, ProducerCaptureShardEvidence, SupervisorPlan } from '../processes';
import type { NativeOwnerLaunch } from './native-launch';
import { canonicalJson, sha256 } from './canonical';
import { processIdentity } from './selected-process-observation';
import { assertSelectedProcessHandle, type SelectedProcessHandle } from './selected-kernel';
import { assertSelectedDirectProducerExit, assertSelectedDirectProducerObservation } from './selected-producer-observation';

function check(value: unknown): asserts value { if (!value) throw new Error('selected_capture_custody'); }
const STREAMS = { conditionalPostLedgerPath: 'conditionalPostLedger', negativeResultsPath: 'negativeResults',
  openCodeTimelinePath: 'openCodeTimeline', ownerWalTimelinePath: 'ownerWalTimeline',
  productTimelinePath: 'productTimeline', protectedEffectLedgerPath: 'protectedEffectLedger' } as const;

/** Allocates real exclusive writer/read anchors. Native producer bytes are
 * never reconstructed or emitted here; this scope observes delivery and seals
 * the exact inode after producer exit and a fresh descriptor census. */
export class SelectedCapture {
  readonly path: string;
  readonly sourceFd: number;
  readonly fd: 9 | 10;
  readonly device: string;
  readonly inode: string;
  readonly #reader: number;
  readonly #directory: number;
  readonly #name: string;
  readonly #plan: SupervisorPlan;
  readonly #stream: (typeof STREAMS)[RuntimeCaptureName];
  readonly #opened: string;
  #ownsWriter = true;
  #closed = false;
  #parentClose?: ProducerCaptureShardEvidence['parentClose'];
  #producerOpen?: ProducerCaptureShardEvidence['producerOpen'];
  constructor(plan: SupervisorPlan, name: RuntimeCaptureName, instanceId: string) {
    check(Object.hasOwn(STREAMS, name) && plan.startSchedule.some(step => step.instanceId === instanceId));
    this.#plan = structuredClone(plan); this.#stream = STREAMS[name];
    this.fd = plan.runtimeManifest.captureEmissionContract.descriptorSlots[this.#stream];
    this.path = name === 'ownerWalTimelinePath'
      ? plan.runtimeManifest.capture[name].replace(/\.ndjson$/u, `.${instanceId}.ndjson`)
      : plan.runtimeManifest.capture[name];
    check(this.path.startsWith('/sandbox/capture/') && this.path.length <= 512);
    this.#name = this.path.slice('/sandbox/capture/'.length);
    check(/^[A-Za-z0-9._-]+\.ndjson$/u.test(this.#name));
    this.#directory = openSync('/sandbox/capture', constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    let writer: number | undefined, reader: number | undefined;
    try {
      const directory = fstatSync(this.#directory, { bigint: true });
      check(directory.isDirectory() && (directory.mode & 0o777n) === 0o700n && directory.uid === BigInt(process.getuid!()));
      const path = `/proc/self/fd/${this.#directory}/${this.#name}`;
      writer = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW |
        constants.O_WRONLY | constants.O_APPEND | 0o2000000 /* Linux O_CLOEXEC */, 0o600);
      check(writer >= 3);
      const st = fstatSync(writer, { bigint: true });
      check(st.isFile() && st.nlink === 1n && st.size === 0n && (st.mode & 0o777n) === 0o600n);
      reader = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const rd = fstatSync(reader, { bigint: true }); check(rd.dev === st.dev && rd.ino === st.ino);
      this.sourceFd = writer; this.#reader = reader; this.device = String(st.dev); this.inode = String(st.ino);
      this.#opened = process.hrtime.bigint().toString();
    } catch (error) {
      if (reader !== undefined) closeSync(reader); if (writer !== undefined) closeSync(writer);
      closeSync(this.#directory); throw error;
    }
  }
  /** Ownership transfers only to the existing native input scope, which closes
   * on preflight failure or produces real parentWriterClosures after fork. */
  transferToNative(): number { check(this.#ownsWriter && !this.#closed); this.#ownsWriter = false; return this.sourceFd; }
  publicBinding() { return Object.freeze({ fd: this.fd, device: this.device, inode: this.inode }); }
  directSpawnClosed(supervisorStartToken: string, spawnBoundaryMonotonicNs: string) {
    check(this.#ownsWriter && !this.#closed && !this.#parentClose);
    this.#ownsWriter = false; closeSync(this.sourceFd);
    let ebadf = false;
    try { fstatSync(this.sourceFd); } catch (error) { ebadf = (error as NodeJS.ErrnoException).code === 'EBADF'; }
    check(ebadf);
    const observedClosedMonotonicNs = process.hrtime.bigint().toString();
    this.#recordParent(supervisorStartToken, this.#opened, spawnBoundaryMonotonicNs, observedClosedMonotonicNs);
    return Object.freeze({ fd: this.sourceFd, childFd: this.fd, device: this.device, inode: this.inode,
      observedOpenMonotonicNs: this.#opened, spawnBoundaryMonotonicNs, observedClosedMonotonicNs });
  }
  nativeSpawnClosed(supervisorStartToken: string, launch: NativeOwnerLaunch) {
    check(!this.#ownsWriter && !this.#closed && !this.#parentClose);
    const record = launch.parentWriterClosures.find(row => row.fd === this.sourceFd);
    check(record && record.device === this.device && record.inode === this.inode &&
      record.spawnBoundaryMonotonicNs === launch.held.forkMonotonicNs);
    this.#recordParent(supervisorStartToken, record.observedOpenMonotonicNs,
      record.spawnBoundaryMonotonicNs, record.observedClosedMonotonicNs);
  }
  #recordParent(supervisorStartToken: string, opened: string, spawned: string, closed: string) {
    check(/^[0-9a-f]{64}$/u.test(supervisorStartToken) && BigInt(opened) < BigInt(spawned) && BigInt(spawned) < BigInt(closed));
    this.#parentClose = Object.freeze({ supervisorPid: process.pid, supervisorStartToken,
      writerFd: this.sourceFd, descriptorPath: `/proc/${process.pid}/fd/${this.sourceFd}`,
      captureDevice: this.device, captureInode: this.inode, observedOpenMonotonicNs: opened,
      spawnBoundaryMonotonicNs: spawned, observedClosedMonotonicNs: closed,
      closeObservationMethod: 'fstat-ebadf', closedErrno: 'EBADF' });
  }
  observeProducer(producer: ProcessStartEvidence): void {
    check(!this.#closed && this.#parentClose && !this.#producerOpen &&
      processIdentity(producer.pid).startTicks === producer.startTime);
    const descriptorPath = `/proc/${producer.pid}/fd/${this.fd}`;
    const st = statSync(descriptorPath, { bigint: true });
    const flags = /^flags:\s+([0-7]+)$/mu.exec(readFileSync(`/proc/${producer.pid}/fdinfo/${this.fd}`, 'utf8'));
    check(st.isFile() && String(st.dev) === this.device && String(st.ino) === this.inode && flags &&
      (parseInt(flags[1], 8) & 3) === constants.O_WRONLY &&
      (parseInt(flags[1], 8) & constants.O_APPEND) !== 0 &&
      processIdentity(producer.pid).startTicks === producer.startTime);
    this.#producerOpen = Object.freeze({ descriptorPath, captureDevice: this.device, captureInode: this.inode,
      observationMethod: 'proc-fd-identity', observedMonotonicNs: process.hrtime.bigint().toString() });
  }
  observeDirectProducer(producer: ProcessStartEvidence, handle: SelectedProcessHandle): void {
    assertSelectedDirectProducerObservation(producer, handle);
    this.observeProducer(producer);
  }
  seal(producer: ProcessStartEvidence, handle: SelectedProcessHandle, exit: ProcessExitEvidence, processEvidenceSetId: string,
    inspectedStartTokens: readonly string[]): ProducerCaptureShardEvidence {
    assertSelectedProcessHandle(handle);
    if (producer.role !== 'owner') {
      assertSelectedDirectProducerObservation(producer, handle);
      assertSelectedDirectProducerExit(exit, handle);
    }
    check(handle.pid === producer.pid && handle.startTicks === producer.startTime &&
      handle.pidfdInode === producer.pidfdInode && handle.isExited());
    check(!this.#closed && !this.#ownsWriter && this.#parentClose && this.#producerOpen &&
      exit.startToken === producer.startToken && exit.pidfdInode === producer.pidfdInode &&
      BigInt(exit.observedMonotonicNs) > BigInt(this.#producerOpen.observedMonotonicNs));
    // Caller retains the actual pidfd-exit record. Independently census all
    // namespace descriptors, not only the named producer or its former parent.
    const pids = readdirSync('/proc').filter(pid => /^[1-9][0-9]*$/u.test(pid)); check(pids.length <= 4096);
    for (const pid of pids) {
      let fds: string[];
      try { fds = readdirSync(`/proc/${pid}/fd`); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
      check(fds.length <= 4096);
      for (const fd of fds) {
        try {
          const st = statSync(`/proc/${pid}/fd/${fd}`, { bigint: true });
          if (String(st.dev) !== this.device || String(st.ino) !== this.inode) continue;
          const flags = /^flags:\s+([0-7]+)$/mu.exec(readFileSync(`/proc/${pid}/fdinfo/${fd}`, 'utf8'));
          check(flags && (parseInt(flags[1], 8) & 3) === constants.O_RDONLY);
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      }
    }
    const censusNs = process.hrtime.bigint().toString();
    const selectedPath = `/proc/self/fd/${this.#directory}/${this.#name}`;
    const pathStat = statSync(selectedPath, { bigint: true }), readerStat = fstatSync(this.#reader, { bigint: true });
    check(pathStat.dev === readerStat.dev && pathStat.ino === readerStat.ino &&
      String(readerStat.dev) === this.device && String(readerStat.ino) === this.inode && readerStat.nlink === 1n &&
      readerStat.size > 0n && readerStat.size <= 64n * 1024n * 1024n);
    fchmodSync(this.#reader, 0o400);
    const before = fstatSync(this.#reader, { bigint: true }), bytes = Buffer.alloc(64 * 1024), hash = createHash('sha256');
    let offset = 0;
    try {
      while (offset < Number(before.size)) {
        const count = readSync(this.#reader, bytes, 0, Math.min(bytes.length, Number(before.size) - offset), offset);
        check(count > 0); hash.update(bytes.subarray(0, count)); offset += count;
      }
    } finally { bytes.fill(0); }
    const after = fstatSync(this.#reader, { bigint: true });
    check(before.dev === after.dev && before.ino === after.ino && before.size === after.size &&
      before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs && (after.mode & 0o777n) === 0o400n);
    const digest = hash.digest('hex');
    const manifest = { path: this.path, stream: this.#stream,
      contractSha256: this.#plan.runtimeManifest.captureEmissionContract.contractSha256,
      captureDevice: this.device, captureInode: this.inode, size: offset, sha256: digest,
      producerPid: producer.pid, producerStartToken: producer.startToken, producerPidfdInode: producer.pidfdInode,
      producerRole: producer.role as ProducerCaptureShardEvidence['producerRole'], producerFd: this.fd,
      producerArtifactSha256: this.#plan.expectedProducerArtifactSha256[producer.role as 'owner' | 'opencode' | 'product' | 'browser'],
      producerModuleSha256: this.#plan.expectedProducerModuleSha256[producer.role as 'owner' | 'opencode' | 'product' | 'browser'] };
    return Object.freeze<ProducerCaptureShardEvidence>({ authority: 'kernel-observed', ...manifest,
      allocation: { observationMethod: 'openat-exclusive-no-follow',
        flags: 'O_CREAT|O_EXCL|O_NOFOLLOW|O_WRONLY|O_APPEND|O_CLOEXEC', mode: 0o600, nlink: 1,
        initialSize: 0, captureDevice: this.device, captureInode: this.inode },
      parentClose: this.#parentClose, producerOpen: this.#producerOpen,
      producerClose: { observationMethod: 'pidfd-exact-exit', observedMonotonicNs: exit.observedMonotonicNs,
        descriptorPath: `/proc/${producer.pid}/fd/${this.fd}`, producerStartToken: producer.startToken,
        producerPidfdInode: producer.pidfdInode },
      descendantCensus: { observationMethod: 'proc-fd-inode-census', observedMonotonicNs: censusNs,
        processEvidenceSetId, inspectedStartTokens: [...inspectedStartTokens], retainedWriterCount: 0 },
      seal: { observationMethod: 'read-only-stable-hash', observedMonotonicNs: process.hrtime.bigint().toString(),
        captureDevice: this.device, captureInode: this.inode, mode: 0o400, nlink: 1, size: offset, sha256: digest,
        manifestSha256: sha256(`agent-teams.p3c.producer-capture-seal/v1\0${canonicalJson(manifest)}`) },
    });
  }
  close(): void {
    if (this.#closed) return; this.#closed = true;
    if (this.#ownsWriter) { this.#ownsWriter = false; closeSync(this.sourceFd); }
    closeSync(this.#reader); closeSync(this.#directory);
  }
}
