import { directoryIdentity, readSkillTree } from './SkillFilesystem.js';
import { SKILL_IMPORT_LIMITS, skillDigest, validateSkillBundle } from './skillPolicy.js';

import type { SkillImportBundle } from './skillPolicy.js';

/** Main-only read grant for the existing typed-or-browsed source field. Not a path RPC. */
export function captureSkillImportGrant(options: {
  sourceDir: string;
  /** Includes original sender/context and exact captured target; never supplied by renderer. */
  originalContext: string;
  assertCurrent(): void;
  isBinary(bytes: Buffer): boolean;
}): { readonly bundle: SkillImportBundle; assertCurrent(): void } {
  const capture = () => {
    options.assertCurrent();
    const directory = directoryIdentity(options.sourceDir);
    const snapshot = readSkillTree(options.sourceDir, options.assertCurrent, {
      skipHidden: true,
      maxFiles: SKILL_IMPORT_LIMITS.files,
      maxBytes: SKILL_IMPORT_LIMITS.bytes,
      isBinary: options.isBinary,
    });
    const body = { files: snapshot.files, hiddenEntriesSkipped: snapshot.hiddenEntriesSkipped };
    const digest = skillDigest(body);
    const binding = skillDigest({
      originalContext: options.originalContext,
      provenance: 'existing-typed-or-browsed-source-field',
      sourceDir: options.sourceDir,
      directory,
      census: snapshot.identity,
      digest,
    });
    const bundle = { binding, digest, ...body };
    validateSkillBundle(bundle);
    options.assertCurrent();
    return bundle;
  };
  const bundle = capture();
  for (const file of bundle.files) Object.freeze(file);
  Object.freeze(bundle.files);
  Object.freeze(bundle);
  return Object.freeze({
    bundle,
    assertCurrent() {
      options.assertCurrent();
      const current = capture();
      if (current.binding !== bundle.binding || current.digest !== bundle.digest)
        throw new Error(
          'The skill source changed after review. Review the latest changes and try again.'
        );
    },
  });
}
