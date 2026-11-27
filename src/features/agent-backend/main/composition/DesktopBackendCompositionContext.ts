import type { BackendHandle } from '../../contracts';
import type { BackendConnectionSnapshot } from '../../contracts/connections';
import type { BackendOwnerRouter, CapturedBackendOwner } from '../application/BackendOwnerRouter';
import type { DesktopBackendDescriptor } from '../infrastructure/loadDesktopBackendDescriptor';
import type { captureHostPromptSuggestions } from './captureHostPromptSuggestions';
import type { DesktopBackendFeatureOptions } from './DesktopBackendOptions';

/** Getter-backed feature state shared by composition helpers; never a cached authority snapshot. */
export interface DesktopBackendCompositionContext {
  readonly sealed: boolean;
  readonly state: BackendConnectionSnapshot['state'];
  readonly router: BackendOwnerRouter | undefined;
  readonly descriptor: DesktopBackendDescriptor | undefined;
  readonly clients: Map<string, CapturedBackendOwner>;
  readonly options: DesktopBackendFeatureOptions;
  readonly hostClientOptions: ReturnType<typeof captureHostPromptSuggestions>;
  initialize(): Promise<void>;
  definitions(): readonly DesktopBackendDescriptor['handles'][number][];
  authorizeHandle(contextId: string, handle: BackendHandle): boolean;
}
