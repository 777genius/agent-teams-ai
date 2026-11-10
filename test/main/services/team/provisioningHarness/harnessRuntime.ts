import {
  assertNoSecretLikeFixtureValues,
  HARNESS_DEFAULT_NOW_ISO,
} from './fixtures';
import { toIsoString } from './harnessData';

import type { TeamProvisioningHarnessPaths } from './harnessFilesystem';
import type {
  TeamProvisioningHarness,
  TeamProvisioningHarnessClock,
  TeamProvisioningHarnessFacades,
  TeamProvisioningHarnessLogger,
  TeamProvisioningHarnessStores,
  TeamProvisioningHarnessUuidSource,
} from './TeamProvisioningHarnessBuilder';

export type HarnessCleanupFn = () => Promise<void> | void;

export async function runCleanupFns(cleanupFns: readonly HarnessCleanupFn[]): Promise<void> {
  let firstError: unknown;
  for (const cleanupFn of [...cleanupFns].reverse()) {
    try {
      await cleanupFn();
    } catch (error) {
      firstError ??= error;
    }
  }

  if (firstError) {
    throw firstError;
  }
}

export class HarnessClock implements TeamProvisioningHarnessClock {
  private currentIso: string;

  constructor(isoOrDate: string | Date = HARNESS_DEFAULT_NOW_ISO) {
    this.currentIso = toIsoString(isoOrDate);
  }

  now(): Date {
    return new Date(this.currentIso);
  }

  nowIso(): string {
    return this.currentIso;
  }

  set(isoOrDate: string | Date): void {
    this.currentIso = toIsoString(isoOrDate);
  }
}

export class HarnessUuidSource implements TeamProvisioningHarnessUuidSource {
  private index = 0;
  private readonly emitted: string[] = [];

  constructor(private readonly sequence: readonly string[] = []) {
    assertNoSecretLikeFixtureValues(sequence);
  }

  next(): string {
    const value = this.sequence[this.index] ?? `harness-uuid-${this.index + 1}`;
    this.index += 1;
    this.emitted.push(value);
    return value;
  }

  generated(): readonly string[] {
    return [...this.emitted];
  }
}

export class TeamProvisioningHarnessImpl implements TeamProvisioningHarness {
  private cleaned = false;

  constructor(
    readonly teamName: string,
    readonly paths: TeamProvisioningHarnessPaths,
    readonly stores: TeamProvisioningHarnessStores,
    readonly facades: TeamProvisioningHarnessFacades,
    readonly clock: TeamProvisioningHarnessClock,
    readonly uuid: TeamProvisioningHarnessUuidSource,
    readonly logger: TeamProvisioningHarnessLogger,
    private readonly cleanupFns: readonly HarnessCleanupFn[]
  ) {}

  async cleanup(): Promise<void> {
    if (this.cleaned) {
      return;
    }

    this.cleaned = true;
    await runCleanupFns(this.cleanupFns);
  }
}
