import type {
  BackendOperationPayloads,
  BackendOperationRequest,
  BackendTaskRef,
} from '../../../contracts/operations';

export class InvalidBackendOperation extends Error {
  constructor() {
    super('Invalid backend operation');
  }
}

export function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !keys.includes(key))
  )
    throw new InvalidBackendOperation();
  return value as Record<string, unknown>;
}

export function text(value: unknown, max = 256): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > max ||
    value.includes('\0')
  ) {
    throw new InvalidBackendOperation();
  }
  return value;
}

function description(value: unknown): string {
  if (value === '') return '';
  return text(value, 200_000);
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 256) throw new InvalidBackendOperation();
  return value.map((entry) => text(entry));
}

function refs(value: unknown): BackendTaskRef[] {
  if (!Array.isArray(value) || value.length > 256) throw new InvalidBackendOperation();
  return value.map((entry) => {
    const ref = object(entry, ['taskId', 'displayId', 'teamName']);
    return {
      taskId: text(ref.taskId),
      displayId: text(ref.displayId),
      teamName: text(ref.teamName),
    };
  });
}

function payload(
  operation: string,
  value: unknown
): BackendOperationPayloads[keyof BackendOperationPayloads] {
  switch (operation) {
    case 'task.create': {
      const p = object(value, [
        'subject',
        'description',
        'owner',
        'blockedBy',
        'descriptionTaskRefs',
      ]);
      return {
        subject: text(p.subject, 20_000),
        ...(p.description === undefined ? {} : { description: description(p.description) }),
        ...(p.owner === undefined ? {} : { owner: text(p.owner) }),
        ...(p.blockedBy === undefined ? {} : { blockedBy: stringArray(p.blockedBy) }),
        ...(p.descriptionTaskRefs === undefined
          ? {}
          : { descriptionTaskRefs: refs(p.descriptionTaskRefs) }),
      };
    }
    case 'task.update': {
      const p = object(value, ['taskId', 'subject', 'description']);
      if (p.subject === undefined && p.description === undefined)
        throw new InvalidBackendOperation();
      return {
        taskId: text(p.taskId),
        ...(p.subject === undefined ? {} : { subject: text(p.subject, 20_000) }),
        ...(p.description === undefined ? {} : { description: description(p.description) }),
      };
    }
    case 'task.assign': {
      const p = object(value, ['taskId', 'owner']);
      return { taskId: text(p.taskId), owner: text(p.owner) };
    }
    case 'task.lifecycle': {
      const p = object(value, ['taskId', 'action']);
      if (!['start', 'complete', 'delete', 'restore', 'pending'].includes(String(p.action)))
        throw new InvalidBackendOperation();
      return {
        taskId: text(p.taskId),
        action: p.action as BackendOperationPayloads['task.lifecycle']['action'],
      };
    }
    case 'task.comment': {
      const p = object(value, ['taskId', 'text', 'taskRefs']);
      return {
        taskId: text(p.taskId),
        text: text(p.text, 200_000),
        ...(p.taskRefs === undefined ? {} : { taskRefs: refs(p.taskRefs) }),
      };
    }
    case 'message.send': {
      const p = object(value, ['to', 'text', 'taskRefs']);
      return {
        to: text(p.to),
        text: text(p.text, 200_000),
        ...(p.taskRefs === undefined ? {} : { taskRefs: refs(p.taskRefs) }),
      };
    }
    case 'task.get':
      return { taskId: text(object(value, ['taskId']).taskId) };
    case 'tasks.list':
    case 'command.lookup':
      object(value, []);
      return {};
    case 'runtime.open':
    case 'runtime.read':
    case 'runtime.dispatch':
    case 'runtime.stop':
    case 'runtime.reconcile':
      return { memberId: text(object(value, ['memberId']).memberId) };
    case 'runtime.interrupt': {
      const p = object(value, ['memberId', 'inputId']);
      return { memberId: text(p.memberId), inputId: text(p.inputId) };
    }
    case 'runtime.checkpoint': {
      const p = object(value, ['memberId', 'checkpointId']);
      return { memberId: text(p.memberId), checkpointId: text(p.checkpointId) };
    }
    case 'runtime.interaction': {
      const p = object(value, ['memberId', 'inputId', 'interactionRef', 'reply']);
      const reply = object(p.reply, ['kind', 'decision', 'answers']);
      let captured: BackendOperationPayloads['runtime.interaction']['reply'];
      if (reply.kind === 'permission') {
        object(p.reply, ['kind', 'decision']);
        if (reply.decision !== 'allow' && reply.decision !== 'deny')
          throw new InvalidBackendOperation();
        captured = { kind: 'permission', decision: reply.decision };
      } else if (reply.kind === 'question') {
        object(p.reply, ['kind', 'answers']);
        if (
          !reply.answers ||
          typeof reply.answers !== 'object' ||
          Array.isArray(reply.answers) ||
          Object.keys(reply.answers).length > 100
        )
          throw new InvalidBackendOperation();
        const answers = Object.fromEntries(
          Object.entries(reply.answers).map(([key, answer]) => [text(key), text(answer, 20_000)])
        );
        captured = { kind: 'question', answers };
      } else throw new InvalidBackendOperation();
      return {
        memberId: text(p.memberId),
        inputId: text(p.inputId),
        interactionRef: text(p.interactionRef),
        reply: captured,
      };
    }
    default:
      throw new InvalidBackendOperation();
  }
}

/** Strict input projection: transport clients cannot supply RPC methods, roots or authority. */
export function parseBackendOperation(value: unknown): BackendOperationRequest {
  const input = object(value, ['handle', 'commandId', 'operation', 'payload']);
  const handle = object(input.handle, ['handleId']);
  const operation = text(input.operation);
  return {
    handle: { handleId: text(handle.handleId) },
    commandId: text(input.commandId),
    operation,
    payload: payload(operation, input.payload),
  } as BackendOperationRequest;
}
