/**
 * Tests for fileIcons utility — extension-to-icon mapping.
 */

import { describe, expect, it } from 'vitest';

import { getFileIcon } from '@renderer/components/team/editor/fileIcons';

describe('getFileIcon', () => {
  it('returns TypeScript icon for .ts files', () => {
    const info = getFileIcon('index.ts');
    expect(info.color).toBe('#3178c6');
  });

  it('returns TypeScript icon for .tsx files', () => {
    const info = getFileIcon('App.tsx');
    expect(info.color).toBe('#3178c6');
  });

  it('returns JavaScript icon for .js files', () => {
    const info = getFileIcon('app.js');
    expect(info.color).toBe('#f7df1e');
  });

  it('returns JSON icon for .json files', () => {
    const info = getFileIcon('package.json');
    // package.json has special mapping
    expect(info.color).toBe('#cb3837');
  });

  it('returns markdown icon for .md files', () => {
    const info = getFileIcon('README.md');
    expect(info.color).toBe('#519aba');
  });

  it('returns Python icon for .py files', () => {
    const info = getFileIcon('main.py');
    expect(info.color).toBe('#3572a5');
  });

  it('returns Rust icon for .rs files', () => {
    const info = getFileIcon('lib.rs');
    expect(info.color).toBe('#dea584');
  });

  it('returns default icon for unknown extensions', () => {
    const info = getFileIcon('file.xyz123');
    expect(info.color).toBe('#89949f');
  });

  it('returns default icon for files without extension', () => {
    const info = getFileIcon('Procfile');
    expect(info.color).toBe('#89949f');
  });

  it('matches special filenames exactly', () => {
    const docker = getFileIcon('Dockerfile');
    expect(docker.color).toBe('#2496ed');

    const gitignore = getFileIcon('.gitignore');
    expect(gitignore.color).toBe('#f05032');

    const claudeMd = getFileIcon('CLAUDE.md');
    expect(claudeMd.color).toBe('#d97706');
  });

  it('prefers filename match over extension match', () => {
    // tsconfig.json should match FILENAME_MAP, not generic .json
    const tsconfig = getFileIcon('tsconfig.json');
    expect(tsconfig.color).toBe('#3178c6');
  });

  it('returns lock icon for sensitive files', () => {
    const env = getFileIcon('.env');
    expect(env.color).toBe('#e5a00d');

    const pnpmLock = getFileIcon('pnpm-lock.yaml');
    expect(pnpmLock.color).toBe('#f69220');
  });

  it('handles image files', () => {
    const png = getFileIcon('logo.png');
    expect(png.color).toBe('#a074c4');

    const svg = getFileIcon('icon.svg');
    expect(svg.color).toBe('#ffb13b');
  });
});
