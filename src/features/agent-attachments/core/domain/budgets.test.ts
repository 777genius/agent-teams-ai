import {
  allocateImageBudgets,
  estimateAgentAttachmentSerializedPayloadBytes,
  planResizeDimensions,
  sortAttachmentsForDelivery,
} from './budgets';

describe('agent attachment budgets', () => {
  it('does not upscale small images', () => {
    expect(planResizeDimensions({ width: 320, height: 200 }, { maxEdge: 1600 })).toEqual({
      width: 320,
      height: 200,
    });
  });

  it('downscales by longest edge', () => {
    expect(planResizeDimensions({ width: 4000, height: 2000 }, { maxEdge: 2000 })).toEqual({
      width: 2000,
      height: 1000,
    });
  });

  it('allocates fair per-image budgets within total cap', () => {
    expect(
      allocateImageBudgets({
        images: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
        totalMaxBytes: 900,
        perImageMaxBytes: 500,
      })
    ).toEqual([
      { imageId: 'a', targetBytes: 300 },
      { imageId: 'b', targetBytes: 300 },
      { imageId: 'c', targetBytes: 300 },
    ]);
  });

  it('preserves explicit attachment order for delivery', () => {
    const sorted = sortAttachmentsForDelivery([
      { id: 'b', order: 2 },
      { id: 'a', order: 1 },
    ]);
    expect(sorted.map((item) => item.id)).toEqual(['a', 'b']);
  });

  it('estimates serialized provider payload bytes including base64 overhead', () => {
    const bytes = estimateAgentAttachmentSerializedPayloadBytes({
      text: 'hello',
      attachments: [
        {
          filename: 'red.png',
          mimeType: 'image/png',
          data: 'a'.repeat(128),
        },
      ],
    });

    expect(bytes).toBeGreaterThan(128);
  });
});
