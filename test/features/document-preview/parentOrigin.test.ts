import { describe, expect, it } from 'vitest';

import {
  getPreviewParentOrigin,
  normalizePreviewParentOrigin,
} from '../../../src/features/document-preview/renderer/utils/protocol';

// A packaged file:// location must agree with either Chromium message-event
// representation. Otherwise the receiver rejects every load and the UI times out.
describe('document preview parent origin contract', () => {
  it('treats both file message origins as the same opaque identity', () => {
    expect(normalizePreviewParentOrigin('file://')).toBe('null');
    expect(normalizePreviewParentOrigin('null')).toBe('null');
    expect(normalizePreviewParentOrigin('http://localhost:5173')).toBe('http://localhost:5173');
  });

  it('uses the actual file protocol instead of relying on Location.origin serialization', () => {
    expect(getPreviewParentOrigin({ protocol: 'file:', origin: 'file://' })).toBe('null');
    expect(getPreviewParentOrigin({ protocol: 'file:', origin: 'null' })).toBe('null');
    expect(getPreviewParentOrigin({ protocol: 'http:', origin: 'http://localhost:5173' })).toBe(
      'http://localhost:5173'
    );
  });
});
