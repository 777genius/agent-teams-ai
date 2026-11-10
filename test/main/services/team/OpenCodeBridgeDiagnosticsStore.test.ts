import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { OpenCodeBridgeDiagnosticsStore } from '../../../../src/main/services/team/opencode/bridge/OpenCodeBridgeDiagnosticsStore';

let tempDir: string;

describe('OpenCodeBridgeDiagnosticsStore', () => {
  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opencode-bridge-diagnostics-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('persists capped redacted bridge diagnostic metadata', async () => {
    const store = new OpenCodeBridgeDiagnosticsStore({
      directory: tempDir,
      maxEventsBytes: 512,
    });

    await store.append({
      id: 'diag-1',
      type: 'opencode_bridge_contract_violation',
      providerId: 'opencode',
      severity: 'error',
      message: 'Bridge stdout was empty',
      data: {
        stderrPreview: 'token=secret Authorization: Bearer live-token',
        stdout: 'raw stdout should not be stored',
        inputPreview: 'x'.repeat(5_000),
      },
      createdAt: '2026-04-21T12:00:00.000Z',
    });

    const latest = await fs.readFile(path.join(tempDir, 'latest.json'), 'utf8');
    const events = await fs.readFile(path.join(tempDir, 'events.ndjson'), 'utf8');

    expect(latest).toContain('token=[redacted]');
    expect(latest).toContain('Authorization: Bearer [redacted]');
    expect(latest).toContain('[truncated]');
    expect(events).toContain('opencode_bridge_contract_violation');
    expect(latest).not.toContain('secret');
    expect(events).not.toContain('live-token');
    expect(latest).toContain('"stdout": "[omitted]"');
    expect(latest).not.toContain('raw stdout should not be stored');
  });

  it('rotates events as complete ndjson lines', async () => {
    const store = new OpenCodeBridgeDiagnosticsStore({
      directory: tempDir,
      maxEventsBytes: 120,
    });

    for (let index = 0; index < 4; index += 1) {
      await store.append({
        id: `diag-${index}`,
        type: 'opencode_bridge_contract_violation',
        providerId: 'opencode',
        severity: 'error',
        message: `Bridge stdout was empty ${index}`,
        data: { index },
        createdAt: '2026-04-21T12:00:00.000Z',
      });
    }

    const lines = (await fs.readFile(path.join(tempDir, 'events.ndjson'), 'utf8'))
      .split('\n')
      .filter(Boolean);

    expect(lines.some((line) => line.includes('opencode_bridge_diagnostics_truncated'))).toBe(
      true
    );
    expect(() => lines.map((line) => JSON.parse(line))).not.toThrow();
  });
});
