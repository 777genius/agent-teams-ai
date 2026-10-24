import assert from 'node:assert/strict';

import type { Cdp } from './cdp.mts';

// tsx/esbuild preserves nested callback names with a compiler helper. The signed
// app's lexical frame must not be expected to supply or replace that helper.
export function cdpSerializedFunction(value: { toString(): string }) {
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
export async function cdpCallFunction<T>(
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

export type ButtonScope = 'document' | 'dialog';
interface ButtonPoint {
  x: number;
  y: number;
  text: string;
}
// Selectors are a closed choice. Patterns and expected versions are data, never
// JavaScript declarations or caller-supplied selector expressions.
export async function cdpButtonPoint(
  client: Pick<Cdp, 'send'>,
  pattern: string,
  scope: ButtonScope = 'document'
): Promise<ButtonPoint | null> {
  return (
    (await cdpCallFunction<ButtonPoint | null>(
      client,
      `(pattern,scope)=>{
        if(scope!=='document'&&scope!=='dialog')throw new Error('Invalid TEST button scope');
        const root=scope==='document'?document:document.querySelector('[role=dialog]');
        const button=[...(root?.querySelectorAll('button')??[])].find(b=>new RegExp(pattern,'i').test(b.textContent.trim())&&!b.disabled);
        if(!button||document.getElementById('splash'))return null;
        button.scrollIntoView({block:'center'});
        const r=button.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2;
        return r.width&&r.height&&button.contains(document.elementFromPoint(x,y))?{x,y,text:button.textContent.trim()}:null;
      }`,
      [pattern, scope]
    )) ?? null
  );
}
export async function cdpBodyContains(
  client: Pick<Cdp, 'send'>,
  expected: string
): Promise<boolean | null> {
  return (
    (await cdpCallFunction<boolean | null>(
      client,
      'expected=>document.body.innerText.includes(expected)?true:null',
      [expected]
    )) ?? null
  );
}
