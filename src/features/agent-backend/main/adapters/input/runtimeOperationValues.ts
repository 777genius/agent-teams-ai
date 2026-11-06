import { readBackendToolApprovalSettings } from '../../../contracts/toolApprovals';

import { InvalidBackendOperation, object, text } from './backendOperationInput';

import type { BackendOperationPayloads } from '../../../contracts/operations';

/** Only own plain data crosses the interaction reply boundary. */
function interactionData(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const row = object(value, keys);
  const prototype = Object.getPrototypeOf(row);
  const descriptors = Object.getOwnPropertyDescriptors(row);
  if (
    (prototype !== Object.prototype && prototype !== null) ||
    Reflect.ownKeys(descriptors).some(
      (key) => typeof key !== 'string' || !('value' in descriptors[key])
    )
  )
    throw new InvalidBackendOperation();
  return Object.fromEntries(Object.entries(descriptors).map(([key, entry]) => [key, entry.value]));
}

export function parseBackendRuntimeOperation(
  operation: string,
  value: unknown
): BackendOperationPayloads[keyof BackendOperationPayloads] {
  switch (operation) {
    case 'runtime.read':
    case 'runtime.open':
    case 'runtime.dispatch':
    case 'runtime.stop':
    case 'runtime.reconcile':
    case 'runtime.activity.snapshot': {
      const p = object(value, ['memberId', 'expectedGeneration']);
      return {
        memberId: text(p.memberId),
        ...(p.expectedGeneration === undefined
          ? {}
          : { expectedGeneration: text(p.expectedGeneration) }),
      };
    }
    case 'runtime.restore': {
      const p = object(value, ['memberId', 'reference', 'expectedGeneration', 'resumeId']);
      const reference = text(p.reference, 68);
      if (!/^cp1-[a-f0-9]{64}$/.test(reference)) throw new InvalidBackendOperation();
      return {
        memberId: text(p.memberId),
        reference,
        expectedGeneration: text(p.expectedGeneration),
        ...(p.resumeId === undefined ? {} : { resumeId: text(p.resumeId) }),
      };
    }
    case 'runtime.checkpoints.read': {
      const p = object(value, ['memberId', 'expectedGeneration']);
      return { memberId: text(p.memberId), expectedGeneration: text(p.expectedGeneration) };
    }
    case 'runtime.activity.feed': {
      const p = object(value, ['memberId', 'cursor', 'expectedGeneration']);
      const cursor = text(p.cursor, 1024);
      if (!/^[A-Za-z0-9_-]+$/.test(cursor)) throw new InvalidBackendOperation();
      return {
        memberId: text(p.memberId),
        cursor,
        ...(p.expectedGeneration === undefined
          ? {}
          : { expectedGeneration: text(p.expectedGeneration) }),
      };
    }
    case 'runtime.interrupt': {
      const p = object(value, ['memberId', 'inputId', 'expectedGeneration']);
      return {
        memberId: text(p.memberId),
        inputId: text(p.inputId),
        ...(p.expectedGeneration === undefined
          ? {}
          : { expectedGeneration: text(p.expectedGeneration) }),
      };
    }
    case 'runtime.checkpoint': {
      const p = object(value, ['memberId', 'checkpointId', 'expectedGeneration']);
      return {
        memberId: text(p.memberId),
        checkpointId: text(p.checkpointId),
        ...(p.expectedGeneration === undefined
          ? {}
          : { expectedGeneration: text(p.expectedGeneration) }),
      };
    }
    case 'runtime.approval.settings.read':
      object(value, []);
      return {};
    case 'runtime.approval.settings.update': {
      const p = object(value, ['settings']);
      return { settings: readBackendToolApprovalSettings(p.settings) };
    }
    case 'runtime.interaction.preview.read': {
      const p = object(value, [
        'memberId',
        'expectedGeneration',
        'inputId',
        'interactionRef',
        'offset',
        'expectedSha256',
        'expectedSource',
      ]);
      if (
        !Number.isSafeInteger(p.offset) ||
        (p.offset as number) < 0 ||
        (p.offset as number) > 2 * 1024 * 1024 ||
        [p.expectedSha256, p.expectedSource].some(
          (value) =>
            value !== undefined && (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value))
        ) ||
        ((p.offset as number) > 0 &&
          (p.expectedSha256 === undefined || p.expectedSource === undefined))
      )
        throw new InvalidBackendOperation();
      return {
        memberId: text(p.memberId),
        expectedGeneration: text(p.expectedGeneration),
        inputId: text(p.inputId),
        interactionRef: text(p.interactionRef),
        offset: p.offset as number,
        ...(p.expectedSha256 === undefined ? {} : { expectedSha256: p.expectedSha256 as string }),
        ...(p.expectedSource === undefined ? {} : { expectedSource: p.expectedSource as string }),
      };
    }
    case 'runtime.interaction': {
      const p = object(value, [
        'memberId',
        'inputId',
        'interactionRef',
        'reply',
        'expectedGeneration',
      ]);
      const reply = interactionData(p.reply, ['kind', 'decision', 'answers']);
      let captured: BackendOperationPayloads['runtime.interaction']['reply'];
      if (reply.kind === 'permission') {
        object(p.reply, ['kind', 'decision']);
        if (reply.decision !== 'allow' && reply.decision !== 'deny')
          throw new InvalidBackendOperation();
        captured = { kind: 'permission', decision: reply.decision };
      } else if (reply.kind === 'question' && reply.decision === 'deny') {
        interactionData(p.reply, ['kind', 'decision']);
        captured = { kind: 'question', decision: 'deny' };
      } else if (reply.kind === 'question') {
        interactionData(p.reply, ['kind', 'answers']);
        if (
          !reply.answers ||
          typeof reply.answers !== 'object' ||
          Array.isArray(reply.answers) ||
          Object.keys(reply.answers).length > 100
        )
          throw new InvalidBackendOperation();
        const answerData = interactionData(reply.answers, Object.keys(reply.answers));
        const answers = Object.fromEntries(
          Object.entries(answerData).map(([key, answer]) => [text(key), text(answer, 20_000)])
        );
        captured = { kind: 'question', answers };
      } else throw new InvalidBackendOperation();
      return {
        memberId: text(p.memberId),
        inputId: text(p.inputId),
        interactionRef: text(p.interactionRef),
        ...(p.expectedGeneration === undefined
          ? {}
          : { expectedGeneration: text(p.expectedGeneration) }),
        reply: captured,
      };
    }
    default:
      throw new InvalidBackendOperation();
  }
}
