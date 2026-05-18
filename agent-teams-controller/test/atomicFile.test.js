const fs = require('fs');
const os = require('os');
const path = require('path');

const { writeJsonFileSync } = require('../src/internal/atomicFile.js');

function listTempFiles(dir) {
  return fs.readdirSync(dir).filter((name) => name.includes('.tmp.'));
}

function withMockedRenameSync(mockRenameSync, callback) {
  const originalRenameSync = fs.renameSync;
  fs.renameSync = (from, to) => mockRenameSync(from, to, originalRenameSync);
  try {
    callback();
  } finally {
    fs.renameSync = originalRenameSync;
  }
}

describe('atomic file writes', () => {
  ['EPERM', 'EACCES', 'EBUSY'].forEach((code) => {
    it(`retries transient ${code} rename failures before publishing JSON`, () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-teams-atomic-'));
      const filePath = path.join(dir, 'state.json');
      let attempts = 0;

      withMockedRenameSync(
        (from, to, originalRenameSync) => {
          attempts += 1;
          if (attempts < 3) {
            const error = new Error(`simulated transient ${code}`);
            error.code = code;
            throw error;
          }
          return originalRenameSync.call(fs, from, to);
        },
        () => {
          writeJsonFileSync(filePath, { ok: true });
        }
      );

      expect(attempts).toBe(3);
      expect(JSON.parse(fs.readFileSync(filePath, 'utf8'))).toEqual({ ok: true });
      expect(listTempFiles(dir)).toEqual([]);
    });
  });

  it('does not retry ENOENT rename failures and removes the temp file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-teams-atomic-'));
    const filePath = path.join(dir, 'state.json');
    let attempts = 0;

    withMockedRenameSync(
      () => {
        attempts += 1;
        const error = new Error('missing target directory');
        error.code = 'ENOENT';
        throw error;
      },
      () => {
        expect(() => writeJsonFileSync(filePath, { ok: true })).toThrow('missing target directory');
      }
    );

    expect(attempts).toBe(1);
    expect(fs.existsSync(filePath)).toBe(false);
    expect(listTempFiles(dir)).toEqual([]);
  });

  it('removes the temp file after retryable rename failures are exhausted', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-teams-atomic-'));
    const filePath = path.join(dir, 'state.json');
    let attempts = 0;

    withMockedRenameSync(
      () => {
        attempts += 1;
        const error = new Error('transient lock stayed active');
        error.code = 'EBUSY';
        throw error;
      },
      () => {
        expect(() => writeJsonFileSync(filePath, { ok: true })).toThrow(
          'transient lock stayed active'
        );
      }
    );

    expect(attempts).toBe(8);
    expect(fs.existsSync(filePath)).toBe(false);
    expect(listTempFiles(dir)).toEqual([]);
  });
});
