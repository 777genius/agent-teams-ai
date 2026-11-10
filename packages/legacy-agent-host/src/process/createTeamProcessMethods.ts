import type { JsonValue } from '../contracts.js';
import { TeamOwnerError } from '../team/contracts.js';
import { projectProcessReceipt as receipt } from './projectProcessViews.js';
import type { createTeamProcessCommands } from './TeamProcessCommands.js';
import type { ProcessMetadataSelector } from './registeredProcessContracts.js';

type Commands = ReturnType<typeof createTeamProcessCommands>;
const object = (value: unknown, keys: string[]) => {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !keys.includes(key))
  )
    throw new Error('process:invalid');
  return value as Record<string, unknown>;
};
const text = (value: unknown): string => {
  if (typeof value !== 'string' || !value || value.length > 256 || value.includes('\0'))
    throw new Error('process:invalid');
  return value;
};
const reference = (value: unknown) => {
  const parsed = text(value);
  if (!/^p1:[A-Za-z0-9_-]{1,128}:[a-f0-9]{64}$/.test(parsed)) throw new Error('process:invalid');
  return parsed;
};
/** Root supplies exact existing owner/profile/scope selection; no implicit host cast. */
export function createTeamProcessMethods(options: {
  resolve(binding: unknown): { commands: Commands; assertCurrent(): void };
}) {
  const methods: Record<string, { lane: 'control'; handle(raw: unknown): Promise<JsonValue> }> = {};
  for (const method of [
    'register',
    'list',
    'stop',
    'unregister',
    'terminate',
    'lookup',
    'pending.read',
  ] as const) {
    methods[`team.process.${method}`] = {
      lane: 'control',
      async handle(raw): Promise<JsonValue> {
        let entered = false;
        try {
          const envelope = object(raw, ['binding', 'commandId', 'payload']);
          const commandId = text(envelope.commandId),
            target = options.resolve(envelope.binding);
          target.assertCurrent();
          let result: unknown;
          const call = <T>(action: () => T): T => {
            entered = true;
            return action();
          };
          switch (method) {
            case 'list':
              object(envelope.payload, []);
              result = call(() => target.commands.list());
              break;
            case 'pending.read':
              object(envelope.payload, []);
              result = call(() => target.commands.pending());
              break;
            case 'lookup': {
              const payload = object(envelope.payload, ['originalCommandId']);
              result = receipt(call(() => target.commands.lookup(text(payload.originalCommandId))));
              break;
            }
            case 'register': {
              const payload = object(envelope.payload, ['pid', 'label', 'port', 'url', 'command']);
              if (typeof payload.pid !== 'number' || typeof payload.label !== 'string')
                throw new Error('process:invalid');
              for (const key of ['url', 'command'])
                if (
                  payload[key] !== undefined &&
                  (typeof payload[key] !== 'string' ||
                    (payload[key] as string).length > 4096 ||
                    (payload[key] as string).includes('\0'))
                )
                  throw new Error('process:invalid');
              if (payload.port !== undefined && typeof payload.port !== 'number')
                throw new Error('process:invalid');
              result = receipt(
                call(() =>
                  target.commands.register(
                    commandId,
                    payload as {
                      pid: number;
                      label: string;
                      port?: number;
                      url?: string;
                      command?: string;
                    }
                  )
                )
              );
              break;
            }
            case 'terminate': {
              const payload = object(envelope.payload, ['processRef']);
              result = receipt(
                call(() => target.commands.terminate(commandId, reference(payload.processRef)))
              );
              break;
            }
            default: {
              const payload = object(envelope.payload, ['processRef', 'id', 'pid']);
              if (Object.keys(payload).length !== 1) throw new Error('process:invalid');
              const selector: ProcessMetadataSelector =
                payload.processRef !== undefined
                  ? { processRef: reference(payload.processRef) }
                  : payload.id !== undefined
                    ? { id: text(payload.id) }
                    : typeof payload.pid === 'number' &&
                        Number.isSafeInteger(payload.pid) &&
                        payload.pid > 1 &&
                        payload.pid <= 0x7fffffff
                      ? { pid: payload.pid }
                      : (() => {
                          throw new Error('process:invalid');
                        })();
              result = receipt(
                call(() =>
                  target.commands.metadata(
                    commandId,
                    method === 'stop' ? 'metadata-stop' : 'unregister',
                    selector
                  )
                )
              );
            }
          }
          target.assertCurrent();
          return { ok: true, value: JSON.parse(JSON.stringify(result)) as JsonValue };
        } catch (error) {
          const matched = /^process:(invalid|conflict|forbidden|hold)$/.exec(
            String((error as Error)?.message)
          );
          return {
            ok: false,
            code: error instanceof TeamOwnerError ? error.code : (matched?.[1] ?? 'hold'),
            outcome: entered ? 'unknown' : 'not-dispatched',
          };
        }
      },
    };
  }
  return methods;
}
