import * as path from 'path';

import {
  createInboxJsonFileSet,
  mergeInboxMessageLists,
  parseInboxMessageListRaw,
  planInboxDuplicateMerge,
} from './TeamProvisioningConfigLaunchNormalization';

export interface DuplicateInboxMergePorts {
  readDir(dirPath: string): Promise<string[]>;
  readRegularFileUtf8(
    filePath: string,
    options: { timeoutMs: number; maxBytes: number }
  ): Promise<string | null | undefined>;
  writeFileUtf8(filePath: string, contents: string): Promise<void>;
  unlink(filePath: string): Promise<void>;
  withCanonicalInboxLock(filePath: string, fn: () => Promise<void>): Promise<void>;
}

export interface MergeAndRemoveDuplicateInboxesInput {
  inboxDir: string;
  baseNames: ReadonlySet<string>;
  timeoutMs: number;
  maxBytes: number;
  ports: DuplicateInboxMergePorts;
}

async function mergeSingleInboxBase(
  input: MergeAndRemoveDuplicateInboxesInput,
  mergePlan: { canonicalFile: string; duplicateFiles: string[] },
  canonicalPath: string,
  existing: Set<string>
): Promise<void> {
  let canonicalRaw: string;
  try {
    const raw = await input.ports.readRegularFileUtf8(canonicalPath, {
      timeoutMs: input.timeoutMs,
      maxBytes: input.maxBytes,
    });
    if (!raw) {
      return;
    }
    canonicalRaw = raw;
  } catch {
    return;
  }

  const canonicalList = parseInboxMessageListRaw(canonicalRaw);
  const duplicateLists: unknown[][] = [];
  // Only duplicates whose content made it into the merged canonical list may
  // be removed; an unreadable duplicate (oversized, read timeout) still holds
  // messages that would otherwise be destroyed unmerged.
  const removableDuplicateFiles: string[] = [];
  for (const dupFile of mergePlan.duplicateFiles) {
    const dupPath = path.join(input.inboxDir, dupFile);
    let dupRaw: string | null | undefined;
    try {
      dupRaw = await input.ports.readRegularFileUtf8(dupPath, {
        timeoutMs: input.timeoutMs,
        maxBytes: input.maxBytes,
      });
    } catch {
      continue;
    }
    if (dupRaw == null) {
      continue;
    }

    removableDuplicateFiles.push(dupFile);
    if (!dupRaw) {
      continue;
    }
    duplicateLists.push(parseInboxMessageListRaw(dupRaw));
  }

  const mergedDeduped = mergeInboxMessageLists(canonicalList, duplicateLists);

  try {
    await input.ports.writeFileUtf8(canonicalPath, JSON.stringify(mergedDeduped, null, 2));
  } catch {
    return;
  }

  for (const dupFile of removableDuplicateFiles) {
    try {
      await input.ports.unlink(path.join(input.inboxDir, dupFile));
      existing.delete(dupFile);
    } catch {
      // Best-effort cleanup.
    }
  }
}

export async function mergeAndRemoveDuplicateInboxes(
  input: MergeAndRemoveDuplicateInboxesInput
): Promise<void> {
  if (input.baseNames.size === 0) return;

  let entries: string[];
  try {
    entries = await input.ports.readDir(input.inboxDir);
  } catch {
    return;
  }

  const existing = createInboxJsonFileSet(entries);

  for (const baseName of input.baseNames) {
    const mergePlan = planInboxDuplicateMerge(baseName, existing);
    if (!mergePlan) continue;

    const canonicalPath = path.join(input.inboxDir, mergePlan.canonicalFile);
    // Hold the same canonical-file lock as every other inbox writer so a
    // concurrent append cannot land between our read and the atomic rewrite.
    await input.ports.withCanonicalInboxLock(canonicalPath, () =>
      mergeSingleInboxBase(input, mergePlan, canonicalPath, existing)
    );
  }
}
