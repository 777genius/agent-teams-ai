import { describe, expect, it } from 'vitest';

import {
  isRelativeUrl,
  parsePathWithLine,
  resolveFileLinkPath,
} from '@renderer/components/chat/viewers/FileLink';

describe('parsePathWithLine', () => {
  it('returns filePath and null line for simple path', () => {
    expect(parsePathWithLine('src/foo.ts')).toEqual({ filePath: 'src/foo.ts', line: null });
  });

  it('parses path:line format', () => {
    expect(parsePathWithLine('src/foo.ts:42')).toEqual({ filePath: 'src/foo.ts', line: 42 });
  });

  it('handles line number 0', () => {
    expect(parsePathWithLine('src/foo.ts:0')).toEqual({ filePath: 'src/foo.ts', line: 0 });
  });

  it('handles ./ prefix with line number', () => {
    expect(parsePathWithLine('./src/foo.ts:10')).toEqual({ filePath: './src/foo.ts', line: 10 });
  });

  it('returns filePath for root-level file', () => {
    expect(parsePathWithLine('package.json')).toEqual({ filePath: 'package.json', line: null });
  });

  it('decodes percent-encoded paths', () => {
    expect(parsePathWithLine('src/foo%20bar.ts')).toEqual({
      filePath: 'src/foo bar.ts',
      line: null,
    });
  });

  it('decodes percent-encoded path with line number', () => {
    expect(parsePathWithLine('src/foo%20bar.ts:5')).toEqual({
      filePath: 'src/foo bar.ts',
      line: 5,
    });
  });

  it('handles malformed percent-encoding gracefully', () => {
    expect(parsePathWithLine('src/%ZZfoo.ts')).toEqual({
      filePath: 'src/%ZZfoo.ts',
      line: null,
    });
  });

  it('handles deeply nested paths', () => {
    expect(parsePathWithLine('src/renderer/components/chat/viewers/FileLink.tsx:120')).toEqual({
      filePath: 'src/renderer/components/chat/viewers/FileLink.tsx',
      line: 120,
    });
  });
});

describe('isRelativeUrl', () => {
  it('returns true for relative paths', () => {
    expect(isRelativeUrl('src/foo.ts')).toBe(true);
    expect(isRelativeUrl('./relative/path.ts')).toBe(true);
    expect(isRelativeUrl('../parent/file.ts')).toBe(true);
    expect(isRelativeUrl('package.json')).toBe(true);
    expect(isRelativeUrl('README.md')).toBe(true);
  });

  it('returns false for http/https URLs', () => {
    expect(isRelativeUrl('http://example.com')).toBe(false);
    expect(isRelativeUrl('https://example.com')).toBe(false);
    expect(isRelativeUrl('https://github.com/foo/bar')).toBe(false);
  });

  it('returns false for custom protocol URLs', () => {
    expect(isRelativeUrl('task://123')).toBe(false);
    expect(isRelativeUrl('mention://color/name')).toBe(false);
    expect(isRelativeUrl('ftp://server/file')).toBe(false);
  });

  it('returns false for data: URLs', () => {
    expect(isRelativeUrl('data:text/html,<h1>hi</h1>')).toBe(false);
    expect(isRelativeUrl('data:image/png;base64,abc')).toBe(false);
  });

  it('returns false for hash fragments', () => {
    expect(isRelativeUrl('#heading')).toBe(false);
    expect(isRelativeUrl('#')).toBe(false);
  });

  it('returns false for mailto: links', () => {
    expect(isRelativeUrl('mailto:a@b.com')).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(isRelativeUrl('')).toBe(false);
  });

  it('returns true for absolute filesystem paths', () => {
    expect(isRelativeUrl('/Users/test/project/docs/roadmap.md')).toBe(true);
    expect(isRelativeUrl('C:\\Users\\test\\project\\README.md')).toBe(true);
  });
});

describe('resolveFileLinkPath', () => {
  const PROJECT_PATH = '/Users/test/project';

  it('resolves relative paths against the project root', () => {
    expect(resolveFileLinkPath('docs/roadmap.md', PROJECT_PATH)).toBe(
      '/Users/test/project/docs/roadmap.md'
    );
  });

  it('normalizes dot segments in relative paths', () => {
    expect(resolveFileLinkPath('./docs/../README.md', PROJECT_PATH)).toBe(
      '/Users/test/project/README.md'
    );
  });

  it('preserves absolute filesystem paths as-is', () => {
    expect(
      resolveFileLinkPath('/Users/belief/dev/projects/your_posts/docs/roadmap.md', PROJECT_PATH)
    ).toBe('/Users/belief/dev/projects/your_posts/docs/roadmap.md');
  });
});
