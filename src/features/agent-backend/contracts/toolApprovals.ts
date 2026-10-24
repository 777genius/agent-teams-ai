import type { BackendAttachmentChunk } from './attachments';
export interface BackendToolApprovalSettings {
  autoAllowAll: boolean;
  autoAllowFileEdits: boolean;
  autoAllowSafeBash: boolean;
  timeoutAction: 'allow' | 'deny' | 'wait';
  timeoutSeconds: number;
}
export interface BackendToolApprovalSettingsView {
  settings: BackendToolApprovalSettings;
}
export interface BackendInteractionPreview {
  file: BackendAttachmentChunk | null;
  sourceFingerprint: string;
  exists: boolean;
  truncated: boolean;
  isBinary: boolean;
}
export interface BackendToolApprovalPayloads {
  'runtime.approval.settings.read': Record<string, never>;
  'runtime.approval.settings.update': { settings: BackendToolApprovalSettings };
  'runtime.interaction.preview.read': {
    memberId: string;
    expectedGeneration: string;
    inputId: string;
    interactionRef: string;
    offset: number;
    expectedSha256?: string;
    expectedSource?: string;
  };
}

/** Finite own-data settings, shared by input validation and output projection. */
export function readBackendToolApprovalSettings(value: unknown): BackendToolApprovalSettings {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    throw new Error('Invalid approval settings');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = [
    'autoAllowAll',
    'autoAllowFileEdits',
    'autoAllowSafeBash',
    'timeoutAction',
    'timeoutSeconds',
  ];
  if (
    Reflect.ownKeys(descriptors).length !== keys.length ||
    Reflect.ownKeys(descriptors).some(
      (key) => typeof key !== 'string' || !keys.includes(key) || !('value' in descriptors[key]!)
    )
  )
    throw new Error('Invalid approval settings');
  const row = Object.fromEntries(
    Object.entries(descriptors).map(([key, field]) => [key, field.value])
  );
  if (
    typeof row.autoAllowAll !== 'boolean' ||
    typeof row.autoAllowFileEdits !== 'boolean' ||
    typeof row.autoAllowSafeBash !== 'boolean' ||
    (row.timeoutAction !== 'allow' &&
      row.timeoutAction !== 'deny' &&
      row.timeoutAction !== 'wait') ||
    typeof row.timeoutSeconds !== 'number' ||
    !Number.isFinite(row.timeoutSeconds) ||
    row.timeoutSeconds < 5 ||
    row.timeoutSeconds > 300
  )
    throw new Error('Invalid approval settings');
  return {
    autoAllowAll: row.autoAllowAll,
    autoAllowFileEdits: row.autoAllowFileEdits,
    autoAllowSafeBash: row.autoAllowSafeBash,
    timeoutAction: row.timeoutAction,
    timeoutSeconds: row.timeoutSeconds,
  };
}
