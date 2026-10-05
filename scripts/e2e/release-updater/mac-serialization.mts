import assert from 'node:assert/strict';

import type { Cdp } from './cdp.mts';

// tsx/esbuild preserves nested callback names with a compiler helper. The signed
// app's lexical frame must not be expected to supply or replace that helper.
export function macSerializedFunction(value: { toString(): string }) {
  return `((__name)=>(${value.toString()}))((target,value)=>Object.defineProperty(target,'name',{value,configurable:true}))`;
}

interface Evaluation<T> {
  result: { type: string; objectId?: string; value?: T };
  exceptionDetails?: { text: string; exception?: { description: string } };
}
function checked<T>(result: Evaluation<T>) {
  if (result.exceptionDetails)
    throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  return result.result;
}
// The expression contains only trusted function declarations. All runtime input
// crosses the CDP CallArgument boundary as values, including in a paused frame.
// Capture required paused-frame bindings inside an immediate trusted factory,
// then return a closure over those copied values.
export async function macCallFunction<T>(
  client: Pick<Cdp, 'send'>,
  expression: string,
  args: readonly unknown[],
  callFrameId?: string
): Promise<T | undefined> {
  const factory = await client.send<Evaluation<never>>(
    callFrameId ? 'Debugger.evaluateOnCallFrame' : 'Runtime.evaluate',
    {
      expression,
      returnByValue: false,
      ...(callFrameId ? { callFrameId } : { awaitPromise: false }),
    }
  );
  const objectId = factory.result.objectId;
  try {
    assert.equal(checked(factory).type, 'function', 'CDP must return the trusted closure');
    assert(objectId, 'CDP closure object ID required');
    const result = await client.send<Evaluation<T>>('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: 'function(...args) { return this(...args); }',
      arguments: args.map((value) => ({ value })),
      returnByValue: true,
      awaitPromise: false,
    });
    return checked(result).value;
  } finally {
    if (objectId) await client.send('Runtime.releaseObject', { objectId });
  }
}
