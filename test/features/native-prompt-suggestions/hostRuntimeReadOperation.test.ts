import { describe, expect, it } from 'vitest';

import { parseBackendOperation } from '../../../src/features/agent-backend/main/adapters/input/validateBackendOperation';

const original = {
  handle: { handleId: 'TEST-host-handle' },
  commandId: 'TEST-read-command',
  operation: 'runtime.read',
  payload: {
    memberId: 'TEST-member-A',
    expectedGeneration: 'TEST-generation-A',
    nativePromptProof: { inputId: 'TEST-input-A', operationRef: 'TEST-operation-A' },
  },
} as const;

describe('native suggestion original operation admission over Main runtime.read', () => {
  it('preserves the exact read-only original input and operation for the captured Host', () => {
    expect(parseBackendOperation(original)).toEqual(original);
  });

  it('rejects alternate operation, unknown fields, missing native input and oversized refs', () => {
    expect(() => parseBackendOperation({
      ...original, operation: 'runtime.stop',
    })).toThrow();
    expect(() => parseBackendOperation({
      ...original, payload: { ...original.payload, nativePromptProof: {
        ...original.payload.nativePromptProof, fabricated: true,
      } },
    })).toThrow();
    expect(() => parseBackendOperation({
      ...original, payload: { ...original.payload, nativePromptProof: {
        operationRef: original.payload.nativePromptProof.operationRef,
      } },
    })).toThrow();
    expect(() => parseBackendOperation({
      ...original, payload: { ...original.payload, nativePromptProof: {
        inputId: 'A'.repeat(257), operationRef: 'TEST-operation-A',
      } },
    })).toThrow();
  });

  it('keeps ordinary runtime.read and all existing controls compatible', () => {
    expect(parseBackendOperation({
      ...original, payload: {
        memberId: original.payload.memberId,
        expectedGeneration: original.payload.expectedGeneration,
      },
    })).toEqual({
      ...original, payload: {
        memberId: original.payload.memberId,
        expectedGeneration: original.payload.expectedGeneration,
      },
    });
  });
});
