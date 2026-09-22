import type { TeamIdentityPublicationGateway } from '@features/internal-storage/contracts';

export interface HostedDraftDirectoryLease {
  readonly fingerprint: string;
  revalidate(): Promise<void>;
  publish(config: string, identity: string): Promise<void>;
  verify(config: string, identity: string): Promise<void>;
}

/** Admitted custody for draft directories only; no arbitrary paths, overwrite, or removal. */
export interface HostedDraftDirectoryPublicationPort {
  withDirectory<T>(
    request: {
      readonly legacyKey: string;
      readonly operationId: string;
      readonly teamId: string;
      readonly expectedFingerprint: string | null;
      assertCurrent(): Promise<void>;
    },
    effect: (lease: HostedDraftDirectoryLease) => Promise<T>
  ): Promise<T>;
  dispose(): Promise<void>;
}

export interface HostedDraftPublicationDependencies {
  readonly directories: HostedDraftDirectoryPublicationPort;
  readonly identities: Pick<
    TeamIdentityPublicationGateway,
    | 'getTeamIdentity'
    | 'reserveTeamIdentity'
    | 'prepareReservedTeamAdoption'
    | 'recordTeamIdentityFilePublished'
    | 'commitTeamAdoption'
    | 'tombstoneTeamIdentity'
  >;
  /** SHA-256 of the canonical UTF-8 identity bytes, returned as lowercase hex. */
  readonly checksumIdentity: (bytes: string) => string;
  readonly now?: () => Date;
}
