import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, openSync, readSync, writeSync } from 'node:fs';
import type { SupervisorPlan } from '../processes';
import { canonicalJson, sha256 } from './canonical';
import { assertSelectedPlanAdmission, type SelectedPlanAdmission } from './selected-plan-admission';

/** Create the real manifest consumed by Owner, exclusively in the admitted
 * sandbox. The retained read descriptor binds subsequent launch digests to
 * actual bytes. This does not establish producer writer revocation. */
export function materializeSelectedRuntimeManifest(plan: SupervisorPlan, admission: SelectedPlanAdmission) {
  assertSelectedPlanAdmission(admission, plan);
  const bytes = Buffer.from(`${canonicalJson(plan.runtimeManifest)}\n`);
  if (bytes.length > 1024 * 1024) throw new Error('selected_runtime_manifest_bound');
  let root: number | undefined = openSync('/sandbox', constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  let writer: number | undefined;
  let reader: number | undefined;
  try {
    const project = openSync(`/proc/self/fd/${root}/project`,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      const stat = fstatSync(project, { bigint: true });
      if (String(stat.dev) !== plan.expectedCwd.owner.device || String(stat.ino) !== plan.expectedCwd.owner.inode) {
        throw new Error('selected_runtime_manifest_sandbox');
      }
    } finally { closeSync(project); }
    const path = `/proc/self/fd/${root}/runtime-manifest.json`;
    writer = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    let offset = 0;
    while (offset < bytes.length) {
      const count = writeSync(writer, bytes, offset, bytes.length - offset, offset);
      if (!count) throw new Error('selected_runtime_manifest_short_write');
      offset += count;
    }
    fchmodSync(writer, 0o400);
    fsyncSync(writer);
    const created = fstatSync(writer, { bigint: true });
    const closingWriter = writer; writer = undefined; closeSync(closingWriter);
    fsyncSync(root);
    reader = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const retained = fstatSync(reader, { bigint: true });
    if (!retained.isFile() || retained.nlink !== 1n || retained.uid !== 0n ||
      (retained.mode & 0o777n) !== 0o400n || retained.dev !== created.dev || retained.ino !== created.ino ||
      retained.size !== BigInt(bytes.length)) throw new Error('selected_runtime_manifest_identity');
    const fd = reader;
    const digest = sha256(bytes);
    let closed = false;
    let closeFailure: { error: unknown } | undefined;
    const assertCurrent = () => {
      if (closed) throw new Error('selected_runtime_manifest_closed');
      const stat = fstatSync(fd, { bigint: true });
      if (stat.dev !== retained.dev || stat.ino !== retained.ino || stat.size !== retained.size ||
        stat.mode !== retained.mode || stat.nlink !== 1n || stat.uid !== retained.uid ||
        stat.gid !== retained.gid || stat.mtimeNs !== retained.mtimeNs || stat.ctimeNs !== retained.ctimeNs) {
        throw new Error('selected_runtime_manifest_changed');
      }
      const actual = Buffer.alloc(bytes.length);
      let position = 0;
      while (position < actual.length) {
        const count = readSync(fd, actual, position, actual.length - position, position);
        if (!count) throw new Error('selected_runtime_manifest_truncated');
        position += count;
      }
      if (sha256(actual) !== digest) throw new Error('selected_runtime_manifest_digest');
      const current = lstatSync('/sandbox/runtime-manifest.json', { bigint: true });
      const after = fstatSync(fd, { bigint: true });
      if (!current.isFile() || current.dev !== retained.dev || current.ino !== retained.ino ||
        after.size !== stat.size || after.mtimeNs !== stat.mtimeNs || after.ctimeNs !== stat.ctimeNs) {
        throw new Error('selected_runtime_manifest_path_changed');
      }
    };
    assertCurrent();
    const closingRoot = root; root = undefined; closeSync(closingRoot);
    reader = undefined;
    return Object.freeze({ path: '/sandbox/runtime-manifest.json' as const,
      sha256: digest, device: String(retained.dev), inode: String(retained.ino), size: bytes.length,
      assertCurrent,
      close() {
        if (closeFailure) throw closeFailure.error;
        if (!closed) {
          closed = true;
          try { closeSync(fd); }
          catch (error) { closeFailure = { error }; throw error; }
        }
      },
    });
  } finally {
    const failures: unknown[] = [];
    for (const fd of [writer, reader, root]) {
      if (fd !== undefined) { try { closeSync(fd); } catch (error) { failures.push(error); } }
    }
    if (failures.length) throw new AggregateError(failures, 'selected_runtime_manifest_cleanup');
  }
}
