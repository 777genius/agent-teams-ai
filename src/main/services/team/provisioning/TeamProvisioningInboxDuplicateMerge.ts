import * as path from 'path';

import { getEffectiveInboxMessageId } from '../inboxMessageIdentity';

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

interface ParsedDuplicateInboxMessageList {
  mergeableRows: unknown[];
  removable: boolean;
}

function parseDuplicateInboxMessageList(raw: string): ParsedDuplicateInboxMessageList | null {
  if (raw.trim().length === 0) {
    return { mergeableRows: [], removable: true };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) {
    return null;
  }

  const mergeableRows = parsed.filter(
    (item) => item !== null && typeof item === 'object' && getEffectiveInboxMessageId(item) !== null
  );
  return {
    mergeableRows,
    removable: mergeableRows.length === parsed.length,
  };
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
  // Merge only rows with a stable effective identity. Identity-less objects
  // cannot be deduped on a later launch, so copying them would grow canonical
  // repeatedly. Remove a duplicate only when every row is safely represented.
  const removableDuplicateFiles: string[] = [];
  let hasMergeableRows = false;
  const duplicateFiles = [...mergePlan.duplicateFiles].sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0
  );
  for (const dupFile of duplicateFiles) {
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

    const duplicateList = parseDuplicateInboxMessageList(dupRaw);
    if (!duplicateList) {
      continue;
    }

    if (duplicateList.removable) {
      removableDuplicateFiles.push(dupFile);
    }
    if (duplicateList.mergeableRows.length > 0) {
      hasMergeableRows = true;
      duplicateLists.push(duplicateList.mergeableRows);
    }
  }

  if (!hasMergeableRows && removableDuplicateFiles.length === 0) {
    return;
  }

  const mergedDeduped = mergeInboxMessageLists(canonicalList, duplicateLists);
  const mergedRaw = JSON.stringify(mergedDeduped, null, 2);

  if (mergedRaw !== canonicalRaw) {
    try {
      await input.ports.writeFileUtf8(canonicalPath, mergedRaw);
    } catch {
      return;
    }
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
