import { type BigIntStats, fstatSync, lstatSync } from 'fs';
import * as path from 'path';

import type { TeamCreateRequest } from '@shared/types';
import type { SpawnOptions } from 'child_process';

export interface ProjectDirectoryLease {
  fd: number;
  dev: string;
  ino: string;
  /** Test-only deterministic barrier; production callers leave this absent. */
  beforeEffect?: () => void | Promise<void>;
}

const leases = new WeakMap<object, ProjectDirectoryLease>();
const leasesByPath = new Map<string, ProjectDirectoryLease>();

export function bindProjectDirectoryLease(
  request: TeamCreateRequest,
  lease: ProjectDirectoryLease
): void {
  if (
    !Number.isSafeInteger(lease.fd) ||
    lease.fd < 3 ||
    !/^\d+$/.test(lease.dev) ||
    !/^\d+$/.test(lease.ino)
  ) {
    throw new Error('Project directory lease is malformed.');
  }
  const frozen = Object.freeze({ ...lease });
  leases.set(request, frozen);
  // A persisted team is launched through a newly materialized synthetic
  // request. Keep the private lease associated with that original pathname so
  // its later launcher boundary receives the same authoritative handle.
  leasesByPath.set(path.resolve(request.cwd), frozen);
}

/**
 * This is the final launcher boundary. The descriptor is revalidated both
 * before and after an optional deterministic barrier, then inherited at its
 * exact numeric fd. Only then is its proc-fd spelling used as spawn.cwd.
 *
 * The lstat fence is deliberately separate from fstat: the latter proves the
 * held directory remains the signed inode, while the former rejects a swapped
 * request pathname instead of silently launching after an observed swap.
 */
export async function applyProjectDirectoryLeaseAtProviderBoundary(
  request: TeamCreateRequest,
  options: SpawnOptions
): Promise<SpawnOptions> {
  const lease = projectDirectoryLeaseForRequest(request);
  if (!lease) return options;
  return applyProjectDirectoryLeaseAtProviderBoundaryWithLease(lease, request.cwd, options);
}

/** Internal retry path: preserves the same private lease across a re-launch. */
export async function applyProjectDirectoryLeaseAtProviderBoundaryWithLease(
  lease: ProjectDirectoryLease,
  pathname: string,
  options: SpawnOptions
): Promise<SpawnOptions> {
  const cwd = await resolveProjectDirectoryLeaseCwdAtProviderBoundary(lease, pathname);

  const stdio = Array.isArray(options.stdio)
    ? [...options.stdio]
    : (['pipe', 'pipe', 'pipe'] as Array<'pipe' | 'ignore' | number>);
  while (stdio.length <= lease.fd) stdio.push('ignore');
  stdio[lease.fd] = lease.fd;
  return {
    ...options,
    // This string is created only after the descriptor above has been checked
    // against the signed inode and is inherited at the same fd in this spawn.
    cwd,
    stdio: stdio as SpawnOptions['stdio'],
  };
}

/**
 * Revalidate a private descriptor immediately before a non-spawn provider
 * effect (for example the OpenCode bridge's exec boundary). Callers must
 * keep this value private: it is a transient cwd for the child process, not
 * a command-body field or persisted launch attribute.
 */
export async function resolveProjectDirectoryLeaseCwdAtProviderBoundary(
  lease: ProjectDirectoryLease,
  pathname: string
): Promise<string> {
  assertLeaseDescriptor(lease);
  await lease.beforeEffect?.();
  assertLeaseDescriptor(lease);
  assertLeasePathname(pathname, lease);
  return `/proc/self/fd/${lease.fd}`;
}

export function projectDirectoryLeaseForRequest(
  request: { cwd: string }
): ProjectDirectoryLease | undefined {
  return leases.get(request) ?? leasesByPath.get(path.resolve(request.cwd));
}

function assertLeaseDescriptor(lease: ProjectDirectoryLease): void {
  let stat: BigIntStats;
  try {
    stat = fstatSync(lease.fd, { bigint: true });
  } catch {
    throw new Error('Project directory lease is no longer open at provider boundary.');
  }
  if (!stat.isDirectory() || String(stat.dev) !== lease.dev || String(stat.ino) !== lease.ino) {
    throw new Error('Project directory lease identity changed at provider boundary.');
  }
}

function assertLeasePathname(cwd: string, lease: ProjectDirectoryLease): void {
  let stat: BigIntStats;
  try {
    stat = lstatSync(cwd, { bigint: true });
  } catch {
    throw new Error('Project directory pathname is unavailable at provider boundary.');
  }
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    String(stat.dev) !== lease.dev ||
    String(stat.ino) !== lease.ino
  ) {
    throw new Error('Project directory pathname changed at provider boundary.');
  }
}
