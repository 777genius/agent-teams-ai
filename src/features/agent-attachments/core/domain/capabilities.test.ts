import { resolveAgentAttachmentCapability } from './capabilities';

import type { AgentAttachmentCapabilityTarget } from './types';

describe('OpenCode declared input capability', () => {
  // Model names must never override the catalog declaration, including old known names.
  it.each<[string, unknown, boolean, boolean, string]>([
    ['custom/new-model', ['image'], true, false, 'known_vision_model'],
    ['custom/new-model', ['video'], false, true, 'known_vision_model'],
    ['custom/new-model', ['image', 'video'], true, true, 'known_vision_model'],
    ['openrouter/z-ai/glm-5.1', ['image'], true, false, 'known_vision_model'],
    ['minimax-coding-plan/MiniMax-M3', [], false, false, 'known_non_vision_model'],
    ['custom/new-model', ['text', 'audio'], false, false, 'known_non_vision_model'],
    ['minimax-coding-plan/MiniMax-M3', undefined, false, false, 'unknown_model'],
    ['custom/new-model', null, false, false, 'unknown_model'],
    ['custom/new-model', 'image', false, false, 'unknown_model'],
    ['custom/new-model', ['image', 1], false, false, 'unknown_model'],
    ['custom/new-model', ['image', ' '], false, false, 'unknown_model'],
  ])('%s with %j resolves image=%s video=%s (%s)', (model, declaration, images, video, reason) => {
    const capability = resolveAgentAttachmentCapability({
      providerId: 'opencode',
      model,
      // Simulate malformed data at the external catalog boundary.
      declaredInputModalities:
        declaration as AgentAttachmentCapabilityTarget['declaredInputModalities'],
    });

    expect(capability).toMatchObject({
      supportsImages: images,
      supportsVideo: video,
      supportsFiles: false,
      reason,
      maxImages: images ? 5 : 0,
      maxVideos: video ? 1 : 0,
    });
    expect(capability.supportedImageMimeTypes.includes('image/png')).toBe(images);
    expect(capability.supportedVideoMimeTypes.includes('video/mp4')).toBe(video);
  });
});
