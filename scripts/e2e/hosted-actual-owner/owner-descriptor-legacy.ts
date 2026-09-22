import { exactRecord } from './contracts';
import type { ProcessStartEvidence } from './processes';

export interface LegacyOwnerChildDescriptorCleanup {
  readonly contract: 'agent-teams.hosted-owner-child-parent-fd-cleanup/v2';
  readonly ownerStartTokens: readonly string[];
  readonly records: readonly ParentDescriptorLifecycleRecord[];
}

export const PARENT_DESCRIPTOR_ROLES = Object.freeze([
  'sealed-launcher-lease',
  'bootstrap',
  'activation-v2',
] as const);

export interface ParentDescriptorBeforeSpawnObservation {
  readonly method: 'proc-fd-identity';
  readonly observedMonotonicNs: string;
  readonly path: string;
  readonly device: string;
  readonly inode: string;
  readonly mode: number;
}

export interface ParentDescriptorAfterSpawnObservation {
  readonly method: 'fstat-ebadf';
  readonly observedMonotonicNs: string;
  readonly errno: 'EBADF';
}

export interface ParentDescriptorLifecycleRecord {
  readonly wrapperPid: number;
  readonly wrapperStartToken: string;
  readonly spawnNonce: string;
  readonly spawnBoundaryMonotonicNs: string;
  readonly childPublication: ChildDescriptorPublication;
  readonly descriptors: readonly Readonly<{
    role: (typeof PARENT_DESCRIPTOR_ROLES)[number];
    parentFd: number;
    beforeSpawn: ParentDescriptorBeforeSpawnObservation;
    afterSpawn: ParentDescriptorAfterSpawnObservation;
  }>[];
}

export interface ChildDescriptorPublication {
  readonly schemaVersion: 1;
  readonly contract: 'agent-teams.hosted-owner-child-fd-map/v1';
  readonly wrapperPid: number;
  readonly wrapperStartToken: string;
  readonly spawnNonce: string;
  readonly descriptors: readonly Readonly<{
    readonly role: (typeof PARENT_DESCRIPTOR_ROLES)[number];
    readonly childFd: 3 | 4 | 5;
    readonly device: string;
    readonly inode: string;
    readonly mode: number;
  }>[];
}

/**
 * Accepts the child's diagnostic publication only when FD3/FD4/FD5 are the exact identities the
 * parent observed before spawn. This publication proves canonical mapping; cleanup authority still
 * comes exclusively from the supervising parent's EBADF observations.
 */
export function acceptCanonicalChildDescriptorPublication(
  value: unknown,
  before: Pick<ParentDescriptorLifecycleRecord, 'wrapperPid' | 'wrapperStartToken' | 'spawnNonce'> & {
    readonly descriptors: readonly Omit<ParentDescriptorLifecycleRecord['descriptors'][number], 'afterSpawn'>[];
  }
): ChildDescriptorPublication {
  const publication = exactRecord(
    value,
    ['schemaVersion', 'contract', 'wrapperPid', 'wrapperStartToken', 'spawnNonce', 'descriptors'],
    'child_descriptor_publication'
  );
  if (
    publication.schemaVersion !== 1 ||
    publication.contract !== 'agent-teams.hosted-owner-child-fd-map/v1' ||
    publication.wrapperPid !== before.wrapperPid ||
    publication.wrapperStartToken !== before.wrapperStartToken ||
    publication.spawnNonce !== before.spawnNonce ||
    typeof publication.spawnNonce !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(publication.spawnNonce) ||
    !Array.isArray(publication.descriptors) ||
    publication.descriptors.length !== PARENT_DESCRIPTOR_ROLES.length
  ) {
    throw new Error('p3c_child_descriptor_publication');
  }
  const descriptors = publication.descriptors.map((candidate, index) => {
    const descriptor = exactRecord(
      candidate,
      ['role', 'childFd', 'device', 'inode', 'mode'],
      `child_descriptor_publication_${index}`
    );
    const expected = before.descriptors[index];
    if (
      expected === undefined ||
      descriptor.role !== expected.role ||
      descriptor.childFd !== index + 3 ||
      descriptor.device !== expected.beforeSpawn.device ||
      descriptor.inode !== expected.beforeSpawn.inode ||
      descriptor.mode !== expected.beforeSpawn.mode
    ) {
      throw new Error('p3c_child_descriptor_publication');
    }
    return Object.freeze({
      role: expected.role,
      childFd: (index + 3) as 3 | 4 | 5,
      device: expected.beforeSpawn.device,
      inode: expected.beforeSpawn.inode,
      mode: expected.beforeSpawn.mode,
    });
  });
  return Object.freeze({
    schemaVersion: 1,
    contract: 'agent-teams.hosted-owner-child-fd-map/v1',
    wrapperPid: before.wrapperPid,
    wrapperStartToken: before.wrapperStartToken,
    spawnNonce: before.spawnNonce,
    descriptors: Object.freeze(descriptors),
  });
}

export function parseLegacyOwnerChildDescriptorCleanup(
  value: unknown,
  starts: readonly Pick<ProcessStartEvidence, 'role' | 'pid' | 'startToken'>[]
): LegacyOwnerChildDescriptorCleanup {
  const cleanup = exactRecord(
    value,
    ['schemaVersion', 'contract', 'records'],
    'supervisor_owner_child_descriptor_cleanup'
  );
  const expectedOwnerTokens = starts
    .filter(({ role }) => role === 'owner')
    .map(({ startToken }) => startToken);
  if (!Array.isArray(cleanup.records) || cleanup.records.length !== expectedOwnerTokens.length) {
    throw new Error('p3c_supervisor_owner_child_descriptor_cleanup');
  }
  const observedTokens = cleanup.records.map((candidate, index) => {
    const expectedOwner = starts.filter(({ role }) => role === 'owner')[index];
    if (expectedOwner === undefined) {
      throw new Error('p3c_supervisor_owner_child_descriptor_cleanup');
    }
    const record = exactRecord(
      candidate,
      [
        'wrapperPid',
        'wrapperStartToken',
        'spawnNonce',
        'spawnBoundaryMonotonicNs',
        'childPublication',
        'descriptors',
      ],
      `supervisor_owner_child_descriptor_cleanup_${index}`
    );
    if (
      record.wrapperPid !== expectedOwner.pid ||
      record.wrapperStartToken !== expectedOwnerTokens[index] ||
      typeof record.spawnNonce !== 'string' ||
      !/^[0-9a-f]{64}$/u.test(record.spawnNonce) ||
      typeof record.spawnBoundaryMonotonicNs !== 'string' ||
      !/^\d+$/u.test(record.spawnBoundaryMonotonicNs) ||
      !Array.isArray(record.descriptors) ||
      record.descriptors.length !== PARENT_DESCRIPTOR_ROLES.length
    ) {
      throw new Error('p3c_supervisor_owner_child_descriptor_cleanup');
    }
    const parentFds = new Set<number>();
    const descriptors = record.descriptors.map((candidateDescriptor, descriptorIndex) => {
      const descriptor = exactRecord(
        candidateDescriptor,
        ['role', 'parentFd', 'beforeSpawn', 'afterSpawn'],
        `supervisor_owner_child_descriptor_${index}_${descriptorIndex}`
      );
      const beforeSpawn = exactRecord(
        descriptor.beforeSpawn,
        ['method', 'observedMonotonicNs', 'path', 'device', 'inode', 'mode'],
        `supervisor_owner_child_descriptor_before_${index}_${descriptorIndex}`
      );
      const afterSpawn = exactRecord(
        descriptor.afterSpawn,
        ['method', 'observedMonotonicNs', 'errno'],
        `supervisor_owner_child_descriptor_after_${index}_${descriptorIndex}`
      );
      const spawnBoundaryMonotonicNs = record.spawnBoundaryMonotonicNs;
      const beforeSpawnMonotonicNs = beforeSpawn.observedMonotonicNs;
      const afterSpawnMonotonicNs = afterSpawn.observedMonotonicNs;
      if (
        descriptor.role !== PARENT_DESCRIPTOR_ROLES[descriptorIndex] ||
        !Number.isSafeInteger(descriptor.parentFd) ||
        (descriptor.parentFd as number) < 0 ||
        parentFds.has(descriptor.parentFd as number) ||
        beforeSpawn.method !== 'proc-fd-identity' ||
        typeof beforeSpawn.observedMonotonicNs !== 'string' ||
        !/^\d+$/u.test(beforeSpawn.observedMonotonicNs) ||
        typeof spawnBoundaryMonotonicNs !== 'string' ||
        typeof beforeSpawnMonotonicNs !== 'string' ||
        BigInt(beforeSpawnMonotonicNs) >= BigInt(spawnBoundaryMonotonicNs) ||
        beforeSpawn.path !== `/proc/${expectedOwner.pid}/fd/${descriptor.parentFd}` ||
        typeof beforeSpawn.device !== 'string' ||
        !/^\d+$/u.test(beforeSpawn.device) ||
        typeof beforeSpawn.inode !== 'string' ||
        !/^[1-9]\d*$/u.test(beforeSpawn.inode) ||
        !Number.isSafeInteger(beforeSpawn.mode) ||
        (beforeSpawn.mode as number) < 0 ||
        (beforeSpawn.mode as number) > 0o7777 ||
        afterSpawn.method !== 'fstat-ebadf' ||
        typeof afterSpawn.observedMonotonicNs !== 'string' ||
        !/^\d+$/u.test(afterSpawn.observedMonotonicNs) ||
        typeof afterSpawnMonotonicNs !== 'string' ||
        BigInt(afterSpawnMonotonicNs) < BigInt(spawnBoundaryMonotonicNs) ||
        afterSpawn.errno !== 'EBADF'
      ) {
        throw new Error('p3c_supervisor_owner_child_descriptor_cleanup');
      }
      parentFds.add(descriptor.parentFd as number);
      return Object.freeze({
        role: descriptor.role as (typeof PARENT_DESCRIPTOR_ROLES)[number],
        parentFd: descriptor.parentFd as number,
        beforeSpawn: Object.freeze({
          method: 'proc-fd-identity' as const,
          observedMonotonicNs: beforeSpawn.observedMonotonicNs,
          path: beforeSpawn.path as string,
          device: beforeSpawn.device as string,
          inode: beforeSpawn.inode as string,
          mode: beforeSpawn.mode as number,
        }),
        afterSpawn: Object.freeze({
          method: 'fstat-ebadf' as const,
          observedMonotonicNs: afterSpawn.observedMonotonicNs,
          errno: 'EBADF' as const,
        }),
      });
    });
    const beforeObservation = Object.freeze({
      wrapperPid: record.wrapperPid as number,
      wrapperStartToken: record.wrapperStartToken as string,
      spawnNonce: record.spawnNonce as string,
      descriptors: Object.freeze(
        descriptors.map(({ role, parentFd, beforeSpawn }) =>
          Object.freeze({ role, parentFd, beforeSpawn })
        )
      ),
    });
    const childPublication = acceptCanonicalChildDescriptorPublication(
      record.childPublication,
      beforeObservation
    );
    return Object.freeze({
      token: record.wrapperStartToken as string,
      record: Object.freeze({
        wrapperPid: record.wrapperPid as number,
        wrapperStartToken: record.wrapperStartToken as string,
        spawnNonce: record.spawnNonce as string,
        spawnBoundaryMonotonicNs: record.spawnBoundaryMonotonicNs,
        childPublication,
        descriptors: Object.freeze(descriptors),
      }),
    });
  });
  if (
    cleanup.schemaVersion !== 2 ||
    cleanup.contract !== 'agent-teams.hosted-owner-child-parent-fd-cleanup/v2'
  ) {
    throw new Error('p3c_supervisor_owner_child_descriptor_cleanup');
  }
  return Object.freeze({
    contract: cleanup.contract,
    ownerStartTokens: Object.freeze(observedTokens.map(({ token }) => token)),
    records: Object.freeze(observedTokens.map(({ record }) => record)),
  });
}
