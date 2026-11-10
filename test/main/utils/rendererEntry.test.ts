import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveRendererEntry } from '@main/utils/rendererEntry';

describe('renderer entry selection and failure diagnostics', () => {
  let root: string;
  let mainDirectory: string;
  let primary: string;
  let fallback: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'renderer-entry-'));
    mainDirectory = join(root, 'dist-electron/main');
    primary = join(root, 'out/renderer/index.html');
    fallback = join(root, 'dist-electron/renderer/index.html');
    mkdirSync(join(root, 'out/renderer'), { recursive: true });
    mkdirSync(join(root, 'dist-electron/renderer'), { recursive: true });
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('prefers the production entry and distinguishes its disappearance after selection', () => {
    writeFileSync(primary, '<html></html>');
    writeFileSync(fallback, '<html></html>');
    const entry = resolveRendererEntry(mainDirectory);
    expect(entry.filePath).toBe(primary);
    rmSync(primary);

    expect(entry.diagnostics(true, -6)).toEqual({
      packaged: 1,
      selected_candidate: 0,
      primary_present_at_selection: 1,
      fallback_present_at_selection: 1,
      primary_present: 0,
      fallback_present: 1,
      error_code: -6,
    });
    expect(entry.filePath).toBe(primary);
  });

  it('selects the legacy candidate only when the production entry is absent', () => {
    writeFileSync(fallback, '<html></html>');
    const entry = resolveRendererEntry(mainDirectory);

    expect(entry.filePath).toBe(fallback);
    expect(entry.diagnostics(false, -2)).toEqual({
      packaged: 0,
      selected_candidate: 1,
      primary_present_at_selection: 0,
      fallback_present_at_selection: 1,
      primary_present: 0,
      fallback_present: 1,
      error_code: -2,
    });
  });

  it('preserves the primary target when neither entry exists', () => {
    const entry = resolveRendererEntry(mainDirectory);

    expect(entry.filePath).toBe(primary);
    expect(entry.diagnostics(true, -6)).toEqual({
      packaged: 1,
      selected_candidate: 0,
      primary_present_at_selection: 0,
      fallback_present_at_selection: 0,
      primary_present: 0,
      fallback_present: 0,
      error_code: -6,
    });
  });

  it('takes only a numeric errno from loadFile errors and never parses arbitrary messages', () => {
    const entry = resolveRendererEntry(mainDirectory);
    const error = Object.assign(new Error(`ERR_FAILED (-2) loading ${primary} secret`), {
      errno: -2,
      url: `file://${primary}`,
      token: 'private-token',
    });
    const diagnostics = entry.diagnostics(true, error);

    expect(diagnostics.error_code).toBe(-2);
    expect(Object.values(diagnostics).every((value) => typeof value === 'number')).toBe(true);
    expect(JSON.stringify(diagnostics)).not.toContain(root);
    expect(JSON.stringify(diagnostics)).not.toContain('secret');
    expect(JSON.stringify(diagnostics)).not.toContain('private-token');
    expect(entry.diagnostics(true, new Error('private ERR_FAILED (-2)'))).not.toHaveProperty(
      'error_code'
    );
    expect(entry.diagnostics(true, { errno: '-6' })).not.toHaveProperty('error_code');
    expect(entry.diagnostics(true, NaN)).not.toHaveProperty('error_code');
    expect(entry.diagnostics(true, -10_001)).not.toHaveProperty('error_code');
    expect(
      entry.diagnostics(
        true,
        Object.defineProperty(new Error('private'), 'errno', {
          get: () => {
            throw new Error('must not invoke arbitrary getters');
          },
        })
      )
    ).not.toHaveProperty('error_code');
  });
});
