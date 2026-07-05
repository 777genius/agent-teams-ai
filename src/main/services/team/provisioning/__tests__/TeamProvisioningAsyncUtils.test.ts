import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { ensureCwdExists, sleep } from '../TeamProvisioningAsyncUtils';

describe('TeamProvisioningAsyncUtils', () => {
  describe('sleep', () => {
    it('resolves after roughly the requested delay', async () => {
      const start = Date.now();
      await sleep(20);
      expect(Date.now() - start).toBeGreaterThanOrEqual(15);
    });
  });

  describe('ensureCwdExists', () => {
    const created: string[] = [];

    afterEach(() => {
      for (const dir of created.splice(0)) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it('creates a missing directory recursively', async () => {
      const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ensure-cwd-'));
      created.push(base);
      const nested = path.join(base, 'a', 'b', 'c');
      await ensureCwdExists(nested);
      expect(fs.statSync(nested).isDirectory()).toBe(true);
    });

    it('is a no-op when the directory already exists', async () => {
      const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ensure-cwd-'));
      created.push(base);
      await expect(ensureCwdExists(base)).resolves.toBeUndefined();
    });

    it('throws when the path exists as a file', async () => {
      const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ensure-cwd-'));
      created.push(base);
      const filePath = path.join(base, 'file.txt');
      fs.writeFileSync(filePath, 'x');
      await expect(ensureCwdExists(filePath)).rejects.toThrow();
    });
  });
});
