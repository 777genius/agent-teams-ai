import { describe, expect, it } from 'vitest';

import { parseBackendOperation } from '../../../src/features/agent-backend/main/adapters/input/validateBackendOperation';
import { projectBackendResult } from '../../../src/features/agent-backend/main/adapters/output/projectBackendResult';

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

  it('preserves the Host Boolean only for explicit read-only proof and refuses malformed replies', () => {
    const state = {
      memberId: original.payload.memberId,
      generation: original.payload.expectedGeneration,
      phase: 'allocated', sealed: false, custody: 'owned', nativeReady: true, attached: true,
      nativePromptCurrent: true, inputs: [], interactions: [],
    };
    const request = parseBackendOperation(original);
    expect(projectBackendResult(request, { ok: true, value: state })).toMatchObject({
      ok: true, value: { nativePromptCurrent: true },
    });
    const ordinary = parseBackendOperation({
      ...original, payload: { memberId: original.payload.memberId },
    });
    expect(projectBackendResult(ordinary, { ok: true, value: state })).toEqual({
      ok: true, value: {
        memberId: original.payload.memberId,
        generation: original.payload.expectedGeneration,
        phase: 'allocated', sealed: false, custody: 'owned', nativeReady: true, attached: true,
        inputs: [], interactions: [],
      },
    });
    expect(() => projectBackendResult(request, {
      ok: true, value: { ...state, nativePromptCurrent: 'yes' },
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
