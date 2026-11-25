import { desktopJsLiteral } from './desktop-ui-controls.ts';

type Row = Record<string, unknown>;
export interface RetainedOpenCodeLaunchInput {
  intentId: string;
  request: {
    teamName: string;
    cwd: string;
    providerId: 'opencode';
    model: 'test-legacy/TEST-model';
    skipPermissions: true;
    runtimeSelectionVersion: 1;
  };
}

/** The original relaunch allowance includes choosing and preparing its original runtime. */
export const RETAINED_OPENCODE_LAUNCH_TIMEOUT_MS = 240_000;

// Serialized into the original renderer: no Main authority, ALS value or release proof is supplied.
async function launchInOriginalRenderer(input: RetainedOpenCodeLaunchInput): Promise<Row> {
  const page = globalThis as unknown as {
    __TEST_retainedApi: { agentBackend: { retainedLegacyLaunch(request: Row): Promise<unknown> } };
  };
  const original = page.__TEST_retainedApi.agentBackend;
  const send = original.retainedLegacyLaunch.bind(original);
  const deadline = performance.now() + 240_000;
  const current = () => {
    if (performance.now() >= deadline) throw new Error('Original retained Launch deadline expired');
  };
  const object = (value: unknown): Row => {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error('Original runtime response is invalid');
    return value as Row;
  };
  const value = (raw: unknown, action: string): unknown => {
    const result = object(raw);
    if (result.ok !== true || result.action !== action) {
      let diagnostic = '';
      try {
        const own = (key: 'reason' | 'outcome'): unknown => {
          const descriptor = Object.getOwnPropertyDescriptor(result, key);
          return descriptor && 'value' in descriptor ? descriptor.value : undefined;
        };
        const reason = own('reason'), outcome = own('outcome');
        diagnostic = '; ' + JSON.stringify({
          reason: typeof reason === 'string' && [
            'unavailable', 'invalid', 'source-changed', 'account-changed', 'import-not-absent',
            'not-eligible', 'busy', 'intent-changed', 'outcome-unknown',
          ].includes(reason) ? reason : null,
          outcome: outcome === 'not-dispatched' || outcome === 'unknown' ? outcome : null,
        });
      } catch {
        // Optional closed facts cannot replace the original refusal or its cleanup.
      }
      throw new Error(`Original runtime ${action} was not confirmed${diagnostic}`);
    }
    return result.value;
  };
  let scopeId: string | undefined, attempted = false, failed = false, failure: unknown, launched: Row | undefined;
  try {
    current();
    attempted = true;
    const choice = object(value(await send({ action: 'open', teamName: input.request.teamName,
      intentId: input.intentId }), 'open'));
    if (choice.teamName !== input.request.teamName || choice.mode !== 'original-runtime' ||
        typeof choice.scopeId !== 'string' || choice.scopeId.length === 0)
      throw new Error('Original runtime choice does not belong to this Team');
    scopeId = choice.scopeId;
    current();
    if (choice.projectPath !== input.request.cwd)
      throw new Error('Original runtime project changed');
    const saved = object(value(await send({ action: 'read', scopeId }), 'read'));
    current();
    for (const key of ['teamName', 'cwd', 'providerId', 'model', 'skipPermissions', 'runtimeSelectionVersion']) {
      if (saved[key] !== input.request[key as keyof RetainedOpenCodeLaunchInput['request']])
        throw new Error('Original saved runtime selection changed');
    }
    if (!Array.isArray(saved.members)) throw new Error('Original saved roster is unavailable');
    const prepared = object(value(await send({ action: 'prepare', scopeId, args: [
      input.request.cwd, 'opencode', ['opencode'], [input.request.model], saved.limitContext ?? null,
      'compatibility', [{ providerId: 'opencode', model: input.request.model }],
      { kind: 'team', teamName: input.request.teamName },
    ] }), 'prepare'));
    current();
    if (prepared.ready !== true) throw new Error('Original runtime preparation is not ready');
    const roster = value(await send({ action: 'roster', scopeId,
      request: { members: saved.members } }), 'roster');
    current();
    if (roster !== null) throw new Error('Original roster preparation was not confirmed');
    launched = object(value(await send({ action: 'launch', scopeId, request: input.request }), 'launch'));
    current();
  } catch (error) {
    failed = true;
    failure = error;
  }
  if (attempted) {
    try {
      const action = scopeId ? 'close' : 'closeIntent';
      const closed = value(await send(scopeId ? { action, scopeId } : {
        action, teamName: input.request.teamName, intentId: input.intentId,
      }), action);
      if (closed !== null) throw new Error('Original runtime choice cleanup was not confirmed');
    } catch (error) {
      if (failed) throw new AggregateError([failure, error],
        'Original retained Launch and its choice cleanup were not confirmed');
      throw error;
    }
  }
  if (failed) throw failure;
  if (!launched) throw new Error('Original retained Launch was not confirmed');
  current();
  return launched;
}

export function retainedOpenCodeLaunchExpression(input: RetainedOpenCodeLaunchInput): string {
  return `(${launchInOriginalRenderer.toString()})(${desktopJsLiteral(input)})`;
}
