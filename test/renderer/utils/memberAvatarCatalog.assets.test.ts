import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const AVATAR_DIR = path.join(process.cwd(), 'src/renderer/assets/participant-avatars');
const EXPECTED_AVATAR_COUNT = 13;
const MAX_AVATAR_DIMENSION_PX = 256;
const MAX_AVATAR_FILE_BYTES = 120 * 1024;
const MAX_AVATAR_CATALOG_BYTES = 1.25 * 1024 * 1024;

function readPngDimensions(buffer: Buffer): { width: number; height: number } {
  expect(buffer.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  };
}

describe('participant avatar assets', () => {
  it('keeps startup avatars within the renderer asset budget', () => {
    const avatarFiles = readdirSync(AVATAR_DIR)
      .filter((fileName) => fileName.endsWith('.png'))
      .sort();
    let totalBytes = 0;

    expect(avatarFiles).toHaveLength(EXPECTED_AVATAR_COUNT);

    for (const fileName of avatarFiles) {
      const buffer = readFileSync(path.join(AVATAR_DIR, fileName));
      totalBytes += buffer.byteLength;
      const dimensions = readPngDimensions(buffer);

      expect(dimensions.width, fileName).toBeLessThanOrEqual(MAX_AVATAR_DIMENSION_PX);
      expect(dimensions.height, fileName).toBeLessThanOrEqual(MAX_AVATAR_DIMENSION_PX);
      expect(buffer.byteLength, fileName).toBeLessThanOrEqual(MAX_AVATAR_FILE_BYTES);
    }

    expect(totalBytes).toBeLessThanOrEqual(MAX_AVATAR_CATALOG_BYTES);
  });
});
