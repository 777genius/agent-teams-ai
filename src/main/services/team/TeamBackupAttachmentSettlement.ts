import type { TaskAttachmentBackupSource } from './TaskAttachmentBackupSource';
import type { BackupFileStat } from './TeamBackupFileIdentity';

interface BackupAttachmentSettlementManifest {
  lastBackupAt: string;
  fileStats: Record<string, BackupFileStat>;
}

interface BackupRunAttachmentSettlement {
  readonly source: TaskAttachmentBackupSource;
  readonly teamName: string;
  readonly backupDirectory: string;
  readonly manifest: BackupAttachmentSettlementManifest;
  readonly isCurrent: () => boolean;
  readonly persistManifest: () => Promise<void>;
}

export async function settleBackupRunAttachmentDeletions(
  settlement: BackupRunAttachmentSettlement
): Promise<void> {
  await settlement.source.settlePendingDeletions(
    settlement.teamName,
    settlement.backupDirectory,
    settlement.manifest.fileStats,
    {
      publishBackupChange: async () => {
        if (!settlement.isCurrent()) return false;
        await settlement.persistManifest();
        return settlement.isCurrent();
      },
      canComplete: settlement.isCurrent,
    }
  );
}

interface StartupAttachmentSettlement<Manifest extends BackupAttachmentSettlementManifest> {
  readonly source: TaskAttachmentBackupSource;
  readonly getBackupDirectory: (teamName: string) => string;
  readonly loadManifest: (teamName: string) => Promise<Manifest | null>;
  readonly persistManifest: (teamName: string, manifest: Manifest) => Promise<void>;
}

export async function settleStartupAttachmentDeletions<
  Manifest extends BackupAttachmentSettlementManifest,
>(settlement: StartupAttachmentSettlement<Manifest>): Promise<void> {
  for (const teamName of await settlement.source.getPendingTeams()) {
    const manifest = await settlement.loadManifest(teamName);
    await settlement.source.settlePendingDeletions(
      teamName,
      settlement.getBackupDirectory(teamName),
      manifest?.fileStats ?? {},
      {
        publishBackupChange: manifest
          ? async () => {
              await settlement.persistManifest(teamName, manifest);
              return true;
            }
          : async () => true,
      }
    );
  }
}
