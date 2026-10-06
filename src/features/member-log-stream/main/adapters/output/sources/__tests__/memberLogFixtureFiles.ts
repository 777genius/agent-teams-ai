import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import {
  OPENCODE_PROMPT_DELIVERY_LEDGER_SCHEMA_VERSION,
  type OpenCodePromptDeliveryLedgerRecord,
} from '@main/services/team/opencode/delivery/OpenCodePromptDeliveryLedger';
import { setClaudeBasePathOverride } from '@main/utils/pathDecoder';

import type { InboxMessage } from '@shared/types';

const tempClaudeRoots: string[] = [];

export async function cleanupMemberLogFixtureRoots(): Promise<void> {
  setClaudeBasePathOverride(null);
  const roots = tempClaudeRoots.splice(0);
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
}

export async function createTempClaudeRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'member-log-source-'));
  tempClaudeRoots.push(root);
  await mkdir(path.join(root, 'teams', 'alpha-team', 'inboxes'), { recursive: true });
  setClaudeBasePathOverride(root);
  return root;
}

export async function writeOpenCodePromptLedger(input: {
  claudeRoot: string;
  teamName: string;
  laneId: string;
  records: OpenCodePromptDeliveryLedgerRecord[];
}): Promise<string> {
  const ledgerPath = path.join(
    input.claudeRoot,
    'teams',
    input.teamName,
    '.opencode-runtime',
    'lanes',
    encodeURIComponent(input.laneId),
    'opencode-prompt-delivery-ledger.json'
  );
  await mkdir(path.join(input.claudeRoot, 'teams', input.teamName, 'inboxes'), { recursive: true });
  await mkdir(path.dirname(ledgerPath), { recursive: true });
  await writeFile(
    ledgerPath,
    `${JSON.stringify(
      {
        schemaVersion: OPENCODE_PROMPT_DELIVERY_LEDGER_SCHEMA_VERSION,
        updatedAt: '2026-04-04T00:00:00.000Z',
        data: input.records,
      },
      null,
      2
    )}\n`
  );
  return ledgerPath;
}

export async function writeTeamLeadInbox(input: {
  claudeRoot: string;
  teamName: string;
  messages: InboxMessage[];
}): Promise<string> {
  const inboxPath = path.join(
    input.claudeRoot,
    'teams',
    input.teamName,
    'inboxes',
    'team-lead.json'
  );
  await mkdir(path.dirname(inboxPath), { recursive: true });
  await writeFile(inboxPath, `${JSON.stringify(input.messages, null, 2)}\n`);
  return inboxPath;
}
