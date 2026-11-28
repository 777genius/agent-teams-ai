import { projectHostPromptSuggestion } from '@features/native-prompt-suggestions/main';

import { hostTeamSelectionKey } from '../../contracts/teamSelection';
import { ownerKey } from '../application/backendBinding';
import { captureNativePromptSettings } from '../infrastructure/CapturedNativePromptOptions';

import type { BackendOwnerRef } from '../application/backendBinding';
import type {
  CapturedHostClient,
  CapturedHostClientOptions,
} from '../infrastructure/CapturedHostClient';
import type { DesktopBackendDescriptor } from '../infrastructure/loadDesktopBackendDescriptor';
import type {
  NativeNextPromptCandidate,
  NativeNextPromptProvider,
} from '@features/native-prompt-suggestions/contracts';

interface CapturedHostPromptComposition {
  definitions(): readonly DesktopBackendDescriptor['handles'][number][];
  currentClient(key: string): CapturedHostClient | undefined;
  isCurrent(): boolean;
  publish: ((value: NativeNextPromptCandidate) => void) | undefined;
  enabled: boolean;
  providers?: readonly NativeNextPromptProvider[];
}

/** Capture settings once; each transport supplies its own actual source identity. */
export function captureHostPromptSuggestions({
  definitions,
  currentClient,
  isCurrent,
  publish,
  enabled,
  providers,
}: CapturedHostPromptComposition): (owner: BackendOwnerRef) => CapturedHostClientOptions {
  const captured = captureNativePromptSettings({
    nativeNextPromptEnabled: enabled,
    nativeNextPromptProviders: providers,
  });
  return (owner) => {
    const key = ownerKey(owner);
    return {
      nativeNextPromptEnabled: captured.enabled,
      ...(captured.explicit ? { nativeNextPromptProviders: captured.providers } : {}),
      onNativePromptSuggestion(raw, source) {
        if (!isCurrent() || currentClient(key) !== source) return;
        const value =
          raw && typeof raw === 'object' && !Array.isArray(raw)
            ? (raw as Record<string, unknown>)
            : null;
        if (typeof value?.teamId !== 'string') return;
        const matches = definitions().filter(
          (entry) =>
            ownerKey(entry.owner) === key &&
            entry.scope.teamId === value.teamId &&
            entry.scope.runId === value.runId
        );
        // Equivalent descriptor handles deduplicate; distinct matches stay ambiguous.
        const unique = new Map(matches.map((entry) => [entry.handleId, entry]));
        if (unique.size !== 1) return;
        const selected = unique.values().next().value!;
        if (!selected.members.some((member) => member.memberId === value.memberId)) return;
        const projected = projectHostPromptSuggestion(
          raw,
          hostTeamSelectionKey(selected.handleId),
          selected.scope.teamId,
          selected.scope.runId
        );
        if (projected && captured.providers.includes(projected.provider)) publish?.(projected);
      },
    };
  };
}
