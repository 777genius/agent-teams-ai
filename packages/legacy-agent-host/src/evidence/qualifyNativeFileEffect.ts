import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { digest } from '../team/identity.js';
import type { ClaudeCaptureValue } from '@agent-teams/provider-implementations/claude';
import type { FileImage, ClaudeNativeFileEffectProof } from './captureContracts.js';

/** A narrow input→bytes proof, never an inference from a changed path or interval. */
export function qualifyNativeFileEffect(options: {
  toolName: string;
  toolInput: ClaudeCaptureValue;
  workspace: string;
  file: string;
  before: FileImage;
  after: FileImage;
}): ClaudeNativeFileEffectProof | undefined {
  const { toolName, toolInput, before, after } = options;
  if (!toolInput || typeof toolInput !== 'object' || Array.isArray(toolInput)) return;
  const input = toolInput as Record<string, ClaudeCaptureValue>;
  if (
    typeof input.file_path !== 'string' ||
    resolve(options.workspace, input.file_path) !== options.file ||
    input.run_in_background === true ||
    before.reason ||
    after.reason ||
    !after.content ||
    after.exists !== true ||
    (before.exists !== false && !before.content)
  )
    return;
  let expected: Buffer;
  let kind: ClaudeNativeFileEffectProof['kind'];
  const utf8 = (text: string) => Buffer.from(text, 'utf8').toString('utf8') === text;
  if (toolName === 'Write') {
    if (typeof input.content !== 'string' || !utf8(input.content)) return;
    expected = Buffer.from(input.content, 'utf8');
    kind = 'write-input-v1';
  } else if (toolName === 'Edit') {
    if (
      !before.content ||
      before.exists !== true ||
      typeof input.old_string !== 'string' ||
      typeof input.new_string !== 'string' ||
      !input.old_string ||
      !utf8(input.old_string) ||
      !utf8(input.new_string) ||
      (input.replace_all !== undefined && typeof input.replace_all !== 'boolean')
    )
      return;
    const original = before.content.toString('utf8');
    if (!Buffer.from(original, 'utf8').equals(before.content)) return;
    const parts = original.split(input.old_string);
    if (parts.length < 2 || (input.replace_all !== true && parts.length !== 2)) return;
    expected = Buffer.from(parts.join(input.new_string), 'utf8');
    kind = 'edit-input-v1';
  } else return;
  if (!expected.equals(after.content)) return;
  const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
  return {
    kind,
    toolInputDigest: digest({ toolName, input: toolInput }),
    beforeSha256: before.exists === false ? null : hash(before.content!),
    afterSha256: hash(after.content),
  };
}
