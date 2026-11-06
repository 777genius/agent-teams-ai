import { lstatSync, realpathSync } from 'node:fs';
import { digest } from '../team/identity.js';
import { runtimeDigest } from '../runtime/identity.js';
import { createOpenCodeInputEvidenceCapture } from '../evidence/OpenCodeInputEvidenceWriter.js';
import { evidenceProjectDir } from '../evidence/evidenceProjectDir.js';
import type { MemberEntry } from './MemberEntry.js';
import type { RuntimeBinding, RuntimeSessionRecord } from '../runtime/contracts.js';
import type { OpenCodeEvidenceCapture } from '../evidence/opencodeCaptureContracts.js';
import type { ToolEvidenceWindows } from '../evidence/ToolEvidenceWindows.js';

/** Capture technical/authority facts once; observation failures never gate provider execution. */
export function createOpenCodeEvidenceCapture(options: {
  entry: MemberEntry;
  request: MemberEntry['config'];
  ownerStorageRoot: string;
  profileId: string;
  hostIncarnation: string;
  principalId: string;
  windows: ToolEvidenceWindows;
  assertCurrent(): void;
  readRuntime(binding: RuntimeBinding): {
    record: RuntimeSessionRecord | undefined;
    attached: boolean;
  };
}): OpenCodeEvidenceCapture | undefined {
  const { entry } = options;
  if (entry.profile.provider !== 'opencode') return undefined;
  const unavailable = (): OpenCodeEvidenceCapture => {
    let sealed = false;
    return {
      observe: async () => {},
      seal: () => {
        sealed = true;
      },
      readStatus: () =>
        Object.freeze({
          phase: sealed ? 'sealed' : 'gap',
          baseline: 'missed',
          reason: 'capture-context-unavailable',
        }),
    };
  };
  try {
    options.assertCurrent();
    const owner = entry.team.owner;
    const profileDigest = runtimeDigest(entry.profile);
    const binding = Object.freeze(structuredClone(entry.binding));
    const entryConfig = runtimeDigest(entry.config);
    const config = structuredClone(options.request);
    const memberPrincipalId = entry.profile.principalId;
    const workspacePath = realpathSync(entry.profile.cwd);
    const info = lstatSync(workspacePath);
    if (!info.isDirectory() || info.isSymbolicLink()) return unavailable();
    const assertCurrent = () => {
      options.assertCurrent();
      if (
        entry.team.owner !== owner ||
        realpathSync(entry.profile.cwd) !== workspacePath ||
        runtimeDigest(entry.profile) !== profileDigest ||
        runtimeDigest(entry.binding) !== runtimeDigest(binding) ||
        runtimeDigest(entry.config) !== entryConfig
      )
        throw new Error('Captured evidence generation changed');
    };
    return createOpenCodeInputEvidenceCapture({
      captured: {
        binding,
        profileId: options.profileId,
        hostIncarnation: options.hostIncarnation,
        config,
        workspace: { path: workspacePath, identity: digest({ dev: info.dev, ino: info.ino }) },
      },
      ledgerProjectDir: evidenceProjectDir(
        options.ownerStorageRoot,
        entry.team.definition.binding.teamName
      ),
      windows: options.windows,
      assertCurrent,
      readRuntime: () => options.readRuntime(binding),
      lookupTaskCause: (intent) => owner.lookupTaskStartCause(memberPrincipalId, intent),
      lookupInputCause: (intent) => owner.lookupToolInputCause(memberPrincipalId, intent),
      withWriteFence: (action) =>
        owner.withLaunchAuthority(options.principalId, 'read', () => {
          assertCurrent();
          return action();
        }),
    });
  } catch {
    return unavailable();
  }
}
