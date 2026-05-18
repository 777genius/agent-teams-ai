import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { TempEmptyMcpConfigHandle, TempEmptyMcpConfigStore } from '../../../core/application';

export class FileTempEmptyMcpConfigStore implements TempEmptyMcpConfigStore {
  constructor(private readonly rootDir: string = os.tmpdir()) {}

  async create(): Promise<TempEmptyMcpConfigHandle> {
    const dir = await fs.mkdtemp(path.join(this.rootDir, 'agent-teams-workspace-trust-'));
    const filePath = path.join(dir, 'empty-mcp.json');
    await fs.writeFile(filePath, `${JSON.stringify({ mcpServers: {} })}\n`, 'utf8');
    return {
      path: filePath,
      cleanup: async () => {
        await fs.rm(dir, { recursive: true, force: true });
      },
    };
  }
}
