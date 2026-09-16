import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const portPath =
  'src/features/team-message-delivery/renderer/ports/TeamMessageDeliveryRendererPorts.ts';
const rendererIndexPath = 'src/features/team-message-delivery/renderer/index.ts';
const transportPath = 'src/renderer/composition/team/createTeamMessageAttachmentReadTransport.ts';
const consumerPath = 'src/renderer/components/team/attachments/AttachmentDisplay.tsx';

function source(path: string): string {
  return readFileSync(join(process.cwd(), path), 'utf8');
}

describe('team message attachment renderer read boundary', () => {
  it('keeps the attachment consumer free of raw Electron and API access', () => {
    const consumer = source(consumerPath);

    expect(consumer).toContain(
      "import { createTeamMessageAttachmentReadTransport } from '@renderer/composition/team/createTeamMessageAttachmentReadTransport'"
    );
    expect(consumer).toMatch(
      /attachmentReadTransport\s*\.\s*getAttachments\(teamName, messageId\)/
    );
    expect(consumer).not.toMatch(/window\.electronAPI|\bapi\.teams\b/);
  });

  it('exposes one narrow provider-neutral read port and freezes its public export', () => {
    const port = source(portPath);
    const rendererIndex = source(rendererIndexPath);

    const portBody = port.match(
      /export interface TeamMessageAttachmentReadPort \{([\s\S]*?)\n\}/
    )?.[1];
    expect(portBody).toContain(
      '  getAttachments(teamName: string, messageId: string): Promise<AttachmentFileData[]>;'
    );
    expect(portBody?.match(/^\s{2}\w+\([^\n]+\):/gmu) ?? []).toEqual([
      '  getAttachments(teamName: string, messageId: string):',
    ]);
    expect(port).not.toMatch(/window\.|\bapi\.|Electron|OpenCode|opencode|Claude|Codex|httpClient/);
    expect(rendererIndex).toContain('TeamMessageAttachmentReadPort');
  });

  it('confines the legacy API access to the dedicated outer composition transport', () => {
    const transport = source(transportPath);
    const boundary = [source(portPath), source(consumerPath), transport].join('\n');

    expect(transport).toContain("import { api } from '@renderer/api'");
    expect(transport).toContain(
      'getAttachments: (teamName, messageId) => api.teams.getAttachments(teamName, messageId)'
    );
    expect(transport.match(/\bapi\.teams\.getAttachments\b/g) ?? []).toHaveLength(1);
    expect(transport).not.toMatch(/window\.electronAPI|@main\/|child_process|httpClient/);
    expect(boundary.match(/\bapi\.teams\.getAttachments\b/g) ?? []).toHaveLength(1);
  });
});
