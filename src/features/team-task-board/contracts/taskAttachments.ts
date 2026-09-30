/**
 * Feature-owned attachment metadata used across application and host boundaries.
 * Outer shared DTOs remain structurally compatible with this contract.
 */
export interface TaskAttachmentMeta {
  id: string;
  filename: string;
  mimeType: AttachmentMediaType;
  size: number;
  addedAt: string;
  filePath?: string | null;
}

// eslint-disable-next-line sonarjs/redundant-type-aliases -- semantic feature contract
export type AttachmentMediaType = string;
