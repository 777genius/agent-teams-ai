interface SourceAttachment {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  filePath?: string;
  sha256?: string;
  order?: number;
}

/** Standalone MCP boundary: same ordered/deduplicated projection as desktop; no frontend import. */
export function sourceMessageAttachments(message: Record<string, unknown>): SourceAttachment[] {
  const ids = new Set<string>();
  const attachments: SourceAttachment[] = [];
  for (const raw of [
    ...(Array.isArray(message.attachments) ? message.attachments : []),
    ...(Array.isArray(message.fileReferences) ? message.fileReferences : []),
  ]) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as Record<string, unknown>;
    if (typeof item.id !== 'string' || typeof item.filename !== 'string' || ids.has(item.id))
      continue;
    ids.add(item.id);
    attachments.push({
      id: item.id,
      filename: item.filename,
      mimeType: typeof item.mimeType === 'string' ? item.mimeType : '',
      size: typeof item.size === 'number' ? item.size : 0,
      ...(typeof item.filePath === 'string' ? { filePath: item.filePath } : {}),
      ...(typeof item.sha256 === 'string' ? { sha256: item.sha256 } : {}),
      ...(typeof item.order === 'number' ? { order: item.order } : {}),
    });
  }
  return attachments.every((item) => Number.isSafeInteger(item.order) && item.order! >= 0)
    ? attachments.sort((a, b) => a.order! - b.order!)
    : attachments;
}
