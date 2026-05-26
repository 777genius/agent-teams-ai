export type DistributedLockAcquireInput = Readonly<{
  leaseMilliseconds: number;
  name: string;
  ownerId: string;
}>;

export type DistributedLockRenewInput = Readonly<{
  fencingToken: bigint;
  leaseMilliseconds: number;
  name: string;
  ownerId: string;
}>;

export type DistributedLockReleaseInput = Readonly<{
  fencingToken: bigint;
  name: string;
  ownerId: string;
}>;

export type DistributedLockLease = Readonly<{
  fencingToken: bigint;
  lockedUntil: Date;
  name: string;
  ownerId: string;
}>;

export type DistributedLockAcquireResult =
  | Readonly<{ acquired: true; lease: DistributedLockLease }>
  | Readonly<{ acquired: false }>;

export type DistributedLockRenewResult =
  | Readonly<{ renewed: true; lease: DistributedLockLease }>
  | Readonly<{ renewed: false }>;

export interface DistributedLockPort {
  acquire(input: DistributedLockAcquireInput): Promise<DistributedLockAcquireResult>;
  release(input: DistributedLockReleaseInput): Promise<void>;
  renew(input: DistributedLockRenewInput): Promise<DistributedLockRenewResult>;
}
