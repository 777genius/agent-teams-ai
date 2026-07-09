import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
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
    source: input.source ?? new LocalConsumedOutputLedgerSource(),
  });
}

class LocalConsumedOutputLedgerSource implements ConsumedOutputLedgerSourcePort {
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

  async resolveWorkspacePath(path: string): Promise<string | undefined> {
    try {
      return await realpath(path);
    } catch {
      return undefined;
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
