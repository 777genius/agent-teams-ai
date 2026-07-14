import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, readdir, readFile, realpath, stat } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import {
  consumedOutputRecordFor,
  readConsumedOutputLedgers,
  type ConsumedOutputLedger,
  type ConsumedOutputLedgerEntry,
  type ConsumedOutputLedgerReadFailure,
  type ConsumedOutputLedgerSourcePort,
} from "@vioxen/subscription-runtime/worker-core";

export async function readCodexGoalConsumedOutputLedgers(input: {
  readonly roots: readonly string[];
  readonly source?: ConsumedOutputLedgerSourcePort;
}): Promise<ConsumedOutputLedger> {
  return readConsumedOutputLedgers({
    roots: input.roots,
    source: input.source ?? new LocalConsumedOutputLedgerSource(input.roots),
  });
}

export async function assertCodexGoalProjectJobNotTerminal(input: {
  readonly roots: readonly string[];
  readonly jobId: string;
  readonly workspacePath: string;
}): Promise<void> {
  if (input.roots.length === 0) return;
  const ledger = await readCodexGoalConsumedOutputLedgers({
    roots: input.roots,
  });
  const record = consumedOutputRecordFor({
    ledger,
    jobId: input.jobId,
    workspacePath: input.workspacePath,
  });
  if (record?.valid) {
    throw new Error(
      `project_control_terminal_job_start_denied:${record.status}`,
    );
  }
}

class LocalConsumedOutputLedgerSource implements ConsumedOutputLedgerSourcePort {
  private readonly evidenceRoots: readonly string[];

  constructor(ledgerRoots: readonly string[]) {
    this.evidenceRoots = ledgerRoots.map((root) =>
      dirname(dirname(resolve(root)))
    );
  }

  async readEntries(input: {
    readonly roots: readonly string[];
  }): Promise<{
    readonly entries: readonly ConsumedOutputLedgerEntry[];
    readonly failures: readonly ConsumedOutputLedgerReadFailure[];
  }> {
    const entries: ConsumedOutputLedgerEntry[] = [];
    const failures: ConsumedOutputLedgerReadFailure[] = [];
    for (const rootInput of input.roots) {
      const itemsDir = join(resolve(rootInput), "items");
      let dirEntries;
      try {
        dirEntries = await readdir(itemsDir, { withFileTypes: true });
      } catch (error) {
        failures.push({
          subject: itemsDir,
          evidence: [
            `consumed output ledger unreadable: ${errorMessage(error)}`,
          ],
        });
        continue;
      }
      for (const entry of dirEntries) {
        if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
        const ledgerPath = join(itemsDir, entry.name);
        try {
          entries.push({
            ledgerPath,
            value: JSON.parse(await readFile(ledgerPath, "utf8")),
          });
        } catch (error) {
          failures.push({
            subject: ledgerPath,
            evidence: [
              `consumed output ledger record unreadable: ${errorMessage(error)}`,
            ],
          });
        }
      }
    }
    return { entries, failures };
  }

  async pathExists(path: string): Promise<boolean> {
    try {
      await stat(path);
      return true;
    } catch {
      return false;
    }
  }

  async pathSize(path: string): Promise<number | undefined> {
    try {
      return (await stat(path)).size;
    } catch {
      return undefined;
    }
  }

  async pathSha256(path: string): Promise<string | undefined> {
    let handle;
    try {
      const realPath = await realpath(path);
      const realEvidenceRoots = await Promise.all(
        this.evidenceRoots.map(async (root) => await realpath(root)),
      );
      if (!realEvidenceRoots.some((root) => pathInsideOrEqual(realPath, root))) {
        return undefined;
      }
      handle = await open(
        realPath,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      const metadata = await handle.stat();
      if (!metadata.isFile() || metadata.size > 16 * 1024 * 1024) {
        return undefined;
      }
      const hash = createHash("sha256");
      const buffer = Buffer.allocUnsafe(64 * 1024);
      let position = 0;
      while (position < metadata.size) {
        const { bytesRead } = await handle.read(
          buffer,
          0,
          Math.min(buffer.length, metadata.size - position),
          position,
        );
        if (bytesRead === 0) return undefined;
        hash.update(buffer.subarray(0, bytesRead));
        position += bytesRead;
      }
      return hash.digest("hex");
    } catch {
      return undefined;
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  async resolveWorkspacePath(path: string): Promise<string | undefined> {
    try {
      return await realpath(path);
    } catch {
      return undefined;
    }
  }
}

function pathInsideOrEqual(path: string, root: string): boolean {
  const pathRelative = relative(resolve(root), resolve(path));
  return pathRelative === "" ||
    (pathRelative !== ".." && !pathRelative.startsWith(`..${sep}`));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
