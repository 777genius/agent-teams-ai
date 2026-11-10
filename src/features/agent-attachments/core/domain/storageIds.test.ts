import { assertSafeAttachmentStorageId, isSafeAttachmentStorageId } from './storageIds';

describe('agent attachment storage ids', () => {
  it('accepts compact stable ids', () => {
    expect(isSafeAttachmentStorageId('msg_abc-123')).toBe(true);
  });

  it('rejects traversal-like ids', () => {
    expect(() => assertSafeAttachmentStorageId('messageId', '../secret')).toThrow(
      /Invalid messageId/
    );
    expect(() => assertSafeAttachmentStorageId('attachmentId', 'a/b')).toThrow(
      /Invalid attachmentId/
    );
  });
});
