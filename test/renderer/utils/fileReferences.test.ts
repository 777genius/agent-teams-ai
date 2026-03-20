import { describe, expect, it } from 'vitest';

import { extractFileReferences } from '@renderer/utils/groupTransformer';

describe('extractFileReferences', () => {
  describe('accepts valid file references', () => {
    it('accepts paths starting with known directories', () => {
      const refs = extractFileReferences('Check @src/components/App.tsx');
      expect(refs).toHaveLength(1);
      expect(refs[0].path).toBe('src/components/App.tsx');
    });

    it('accepts utils/ paths (known dir)', () => {
      const refs = extractFileReferences('See @utils/helpers');
      expect(refs).toHaveLength(1);
      expect(refs[0].path).toBe('utils/helpers');
    });

    it('accepts hooks/ paths (known dir)', () => {
      const refs = extractFileReferences('Use @hooks/auth');
      expect(refs).toHaveLength(1);
      expect(refs[0].path).toBe('hooks/auth');
    });

    it('accepts lib/ paths (known dir)', () => {
      const refs = extractFileReferences('In @lib/core');
      expect(refs).toHaveLength(1);
      expect(refs[0].path).toBe('lib/core');
    });

    it('accepts config/ paths (known dir)', () => {
      const refs = extractFileReferences('Edit @config/database');
      expect(refs).toHaveLength(1);
      expect(refs[0].path).toBe('config/database');
    });

    it('accepts relative paths with ./', () => {
      const refs = extractFileReferences('See @./src/file.ts');
      expect(refs).toHaveLength(1);
      expect(refs[0].path).toBe('./src/file.ts');
    });

    it('accepts relative paths with ../', () => {
      const refs = extractFileReferences('See @../lib/utils.ts');
      expect(refs).toHaveLength(1);
      expect(refs[0].path).toBe('../lib/utils.ts');
    });

    it('accepts unknown-dir paths with 3+ segments', () => {
      const refs = extractFileReferences('See @custom/deep/path.ts');
      expect(refs).toHaveLength(1);
      expect(refs[0].path).toBe('custom/deep/path.ts');
    });

    it('accepts unknown-dir paths with file extension', () => {
      const refs = extractFileReferences('See @foo/bar.ts');
      expect(refs).toHaveLength(1);
      expect(refs[0].path).toBe('foo/bar.ts');
    });

    it('accepts node_modules paths (known dir)', () => {
      const refs = extractFileReferences('Check @node_modules/lodash/index.js');
      expect(refs).toHaveLength(1);
      expect(refs[0].path).toBe('node_modules/lodash/index.js');
    });

    it('accepts types/ paths (known dir)', () => {
      const refs = extractFileReferences('See @types/node');
      expect(refs).toHaveLength(1);
      expect(refs[0].path).toBe('types/node');
    });

    it('extracts multiple references from one string', () => {
      const refs = extractFileReferences('Compare @src/a.ts and @lib/b.ts');
      expect(refs).toHaveLength(2);
      expect(refs[0].path).toBe('src/a.ts');
      expect(refs[1].path).toBe('lib/b.ts');
    });

    it('accepts tilde paths', () => {
      const refs = extractFileReferences('See @~/projects/foo');
      expect(refs).toHaveLength(1);
      expect(refs[0].path).toBe('~/projects/foo');
    });
  });

  describe('rejects npm scoped packages', () => {
    it('rejects @babel/core', () => {
      const refs = extractFileReferences('Use @babel/core for transpilation');
      expect(refs).toHaveLength(0);
    });

    it('rejects @xyflow/react', () => {
      const refs = extractFileReferences('Install @xyflow/react');
      expect(refs).toHaveLength(0);
    });

    it('rejects @dagrejs/dagre', () => {
      const refs = extractFileReferences('Use @dagrejs/dagre for layout');
      expect(refs).toHaveLength(0);
    });

    it('rejects @testing-library/react', () => {
      const refs = extractFileReferences('Import from @testing-library/react');
      expect(refs).toHaveLength(0);
    });

    it('rejects @vitest/ui', () => {
      const refs = extractFileReferences('Run @vitest/ui');
      expect(refs).toHaveLength(0);
    });

    it('rejects @radix-ui/react-dialog', () => {
      const refs = extractFileReferences('Use @radix-ui/react-dialog');
      expect(refs).toHaveLength(0);
    });

    it('rejects @codemirror/lang-javascript', () => {
      const refs = extractFileReferences('Import @codemirror/lang-javascript');
      expect(refs).toHaveLength(0);
    });

    it('rejects @emotion/react', () => {
      const refs = extractFileReferences('Style with @emotion/react');
      expect(refs).toHaveLength(0);
    });
  });

  describe('edge cases', () => {
    it('returns empty for text without @', () => {
      const refs = extractFileReferences('No mentions here');
      expect(refs).toHaveLength(0);
    });

    it('returns empty for empty string', () => {
      const refs = extractFileReferences('');
      expect(refs).toHaveLength(0);
    });

    it('rejects bare @ mentions without path separator', () => {
      const refs = extractFileReferences('Hello @user');
      expect(refs).toHaveLength(0);
    });

    it('handles mixed valid and invalid refs', () => {
      const refs = extractFileReferences(
        'Use @babel/core and check @src/components/App.tsx'
      );
      expect(refs).toHaveLength(1);
      expect(refs[0].path).toBe('src/components/App.tsx');
    });

    it('rejects single-segment bare names', () => {
      const refs = extractFileReferences('@react is a library');
      expect(refs).toHaveLength(0);
    });
  });
});
