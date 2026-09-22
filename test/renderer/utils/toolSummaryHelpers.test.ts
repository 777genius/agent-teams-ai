import { describe, expect, it } from 'vitest';

import { getToolSummary } from '../../../src/renderer/utils/toolRendering/toolSummaryHelpers';

describe('renderer toolSummaryHelpers', () => {
  it('summarizes OpenCode lowercase write calls with camelCase filePath', () => {
    expect(
      getToolSummary('write', {
        filePath: '/repo/944/index.html',
        content: '<!DOCTYPE html>\n<html></html>',
      })
    ).toBe('index.html - 2 lines');
  });

  it('shows an explicit unavailable summary for invalid empty write calls', () => {
    expect(getToolSummary('write', {})).toBe('Write input unavailable');
  });

  it('summarizes OpenCode lowercase read and bash calls', () => {
    expect(getToolSummary('read', { filePath: '/repo/944/style.css' })).toBe('style.css');
    expect(getToolSummary('bash', { command: 'mkdir -p 944' })).toBe('mkdir -p 944');
  });
});
