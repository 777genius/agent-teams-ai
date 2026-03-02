/**
 * Tests for fileIcons utility — extension-to-icon mapping with Devicon support.
 */

import { describe, expect, it } from 'vitest';

import { getDeviconUrl, getFileIcon } from '@renderer/components/team/editor/fileIcons';

describe('getFileIcon', () => {
  it('returns TypeScript icon for .ts files', () => {
    const info = getFileIcon('index.ts');
    expect(info.color).toBe('#3178c6');
    expect(info.deviconSlug).toBe('typescript');
  });

  it('returns TypeScript icon for .tsx files', () => {
    const info = getFileIcon('App.tsx');
    expect(info.color).toBe('#3178c6');
    expect(info.deviconSlug).toBe('react');
  });

  it('returns JavaScript icon for .js files', () => {
    const info = getFileIcon('app.js');
    expect(info.color).toBe('#f7df1e');
    expect(info.deviconSlug).toBe('javascript');
  });

  it('returns JSON icon for .json files', () => {
    const info = getFileIcon('package.json');
    // package.json has special mapping
    expect(info.color).toBe('#cb3837');
    expect(info.deviconSlug).toBe('nodejs');
  });

  it('returns markdown icon for .md files', () => {
    const info = getFileIcon('README.md');
    expect(info.color).toBe('#519aba');
    expect(info.deviconSlug).toBe('markdown');
  });

  it('returns Python icon for .py files', () => {
    const info = getFileIcon('main.py');
    expect(info.color).toBe('#3572a5');
    expect(info.deviconSlug).toBe('python');
  });

  it('returns Rust icon for .rs files', () => {
    const info = getFileIcon('lib.rs');
    expect(info.color).toBe('#dea584');
    expect(info.deviconSlug).toBe('rust');
  });

  it('returns default icon for unknown extensions', () => {
    const info = getFileIcon('file.xyz123');
    expect(info.color).toBe('#89949f');
    expect(info.deviconSlug).toBeUndefined();
  });

  it('returns default icon for files without extension', () => {
    const info = getFileIcon('Procfile');
    expect(info.color).toBe('#89949f');
    expect(info.deviconSlug).toBeUndefined();
  });

  it('matches special filenames exactly', () => {
    const docker = getFileIcon('Dockerfile');
    expect(docker.color).toBe('#2496ed');
    expect(docker.deviconSlug).toBe('docker');

    const gitignore = getFileIcon('.gitignore');
    expect(gitignore.color).toBe('#f05032');
    expect(gitignore.deviconSlug).toBe('git');

    const claudeMd = getFileIcon('CLAUDE.md');
    expect(claudeMd.color).toBe('#d97706');
    expect(claudeMd.deviconSlug).toBeUndefined();
  });

  it('prefers filename match over extension match', () => {
    // tsconfig.json should match FILENAME_MAP, not generic .json
    const tsconfig = getFileIcon('tsconfig.json');
    expect(tsconfig.color).toBe('#3178c6');
    expect(tsconfig.deviconSlug).toBe('typescript');
  });

  it('returns lock icon for sensitive files', () => {
    const env = getFileIcon('.env');
    expect(env.color).toBe('#e5a00d');
    expect(env.deviconSlug).toBeUndefined();

    const pnpmLock = getFileIcon('pnpm-lock.yaml');
    expect(pnpmLock.color).toBe('#f69220');
    expect(pnpmLock.deviconSlug).toBeUndefined();
  });

  it('handles image files', () => {
    const png = getFileIcon('logo.png');
    expect(png.color).toBe('#a074c4');
    expect(png.deviconSlug).toBeUndefined();

    const svg = getFileIcon('icon.svg');
    expect(svg.color).toBe('#ffb13b');
    expect(svg.deviconSlug).toBeUndefined();
  });

  it('provides devicon slugs for major languages', () => {
    const cases: [string, string][] = [
      ['app.go', 'go'],
      ['lib.rb', 'ruby'],
      ['Main.java', 'java'],
      ['style.css', 'css3'],
      ['page.html', 'html5'],
      ['Component.vue', 'vuejs'],
      ['App.svelte', 'svelte'],
      ['main.dart', 'dart'],
      ['app.swift', 'swift'],
      ['main.php', 'php'],
      ['main.kt', 'kotlin'],
      ['main.scala', 'scala'],
      ['app.ex', 'elixir'],
      ['query.graphql', 'graphql'],
    ];

    for (const [fileName, expectedSlug] of cases) {
      const info = getFileIcon(fileName);
      expect(info.deviconSlug, `Expected ${fileName} to have slug "${expectedSlug}"`).toBe(
        expectedSlug
      );
    }
  });

  it('provides devicon slugs for special config files', () => {
    expect(getFileIcon('vite.config.ts').deviconSlug).toBe('vitejs');
    expect(getFileIcon('docker-compose.yml').deviconSlug).toBe('docker');
    expect(getFileIcon('.eslintrc').deviconSlug).toBe('eslint');
    expect(getFileIcon('Cargo.toml').deviconSlug).toBe('rust');
    expect(getFileIcon('go.mod').deviconSlug).toBe('go');
    expect(getFileIcon('tailwind.config.js').deviconSlug).toBe('tailwindcss');
  });
});

describe('getDeviconUrl', () => {
  it('builds correct CDN URL for a slug', () => {
    const url = getDeviconUrl('typescript');
    expect(url).toBe(
      'https://cdn.jsdelivr.net/gh/devicons/devicon@latest/icons/typescript/typescript-original.svg'
    );
  });

  it('works for multi-word slugs', () => {
    const url = getDeviconUrl('cplusplus');
    expect(url).toContain('/cplusplus/cplusplus-original.svg');
  });
});
