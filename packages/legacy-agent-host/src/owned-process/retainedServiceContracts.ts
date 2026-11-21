import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';

import type { PendingOwnedProcess } from './contract.js';
import type { RegistrarBinding } from '../process/registeredProcessContracts.js';

const ref = z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/);
const birth = z.string().regex(/^[a-f0-9]{16}$/).refine(value => value !== '0000000000000000');
const pid = z.number().int().min(2).max(0x7fffffff);
const text = z.string().min(1).max(256).refine(value => !value.includes('\0'));
const registrar = z.object({ backendId: text, teamId: text, runId: text, memberId: text,
  generation: text }).strict();
const root = z.object({ pid: z.number().int().min(1).max(0x7fffffff), birth }).strict();
const source = z.object({ mainEpoch: ref, providerCapability: ref,
  providerGeneration: z.string().uuid(), root }).strict();

/** Private immutable metadata for one original Main-owned scope. It is not a reopen token. */
export const windowsServiceCaptureSchema = source.extend({
  version: z.literal(5), platform: z.literal('win32'), admission: z.literal('main-owned-job-scope-v1'),
  target: z.object({ pid, key: birth, birth }).strict(), registrar,
}).strict();
export type WindowsServiceCapture = z.infer<typeof windowsServiceCaptureSchema>;
export type WindowsServiceSource = z.infer<typeof source>;

const captureIntent = source.extend({ operationRef: ref,
  command: z.object({ operation: z.literal('capture'), pid, registrar }).strict(),
}).strict();
const stopIntent = source.extend({ operationRef: ref,
  command: z.object({ operation: z.literal('stop'), capture: windowsServiceCaptureSchema }).strict(),
}).strict();
const settleIntent = source.extend({ operationRef: ref,
  command: z.object({ operation: z.literal('settle'), capture: windowsServiceCaptureSchema }).strict(),
}).strict();
export const windowsServiceIntentSchema = z.union([captureIntent, stopIntent, settleIntent]);
export type WindowsServiceIntent = z.infer<typeof windowsServiceIntentSchema>;

const noDispatch = z.enum(['deadline', 'capacity', 'admission', 'closed']);
const evidence = z.enum(['native-scope', 'retained-terminal', 'original-whole-job']);
const observation = z.enum(['same-live', 'absent', 'unknown']);
export const windowsServiceOutcomeSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('unknown') }).strict(),
  z.object({ state: z.literal('not-dispatched'), reason: noDispatch }).strict(),
  z.object({ state: z.literal('conflict') }).strict(),
  z.object({ state: z.literal('refused'), reason: z.number().int().min(1).max(6),
    nativeCode: z.number().int().min(0).max(0xffffffff) }).strict(),
  z.object({ state: z.literal('captured'), capture: windowsServiceCaptureSchema }).strict(),
  z.object({ state: z.literal('observed'), capture: windowsServiceCaptureSchema,
    observation, evidence }).strict(),
  z.object({ state: z.literal('stopped'), capture: windowsServiceCaptureSchema,
    observation, evidence }).strict(),
  z.object({ state: z.literal('settled'), capture: windowsServiceCaptureSchema }).strict(),
]);
export type WindowsServiceOutcome = z.infer<typeof windowsServiceOutcomeSchema>;

const budgetMs = z.number().int().min(0).max(30_000);
export const hostServiceCallSchemas = [
  z.object({ operation: z.literal('service-capture'), capability: ref, intent: captureIntent, budgetMs }).strict(),
  z.object({ operation: z.literal('service-stop'), capability: ref, intent: stopIntent, budgetMs }).strict(),
  z.object({ operation: z.literal('service-settle'), capability: ref, intent: settleIntent, budgetMs }).strict(),
  z.object({ operation: z.literal('service-lookup'), capability: ref, intent: windowsServiceIntentSchema }).strict(),
  z.object({ operation: z.literal('service-query'), capability: ref, capture: windowsServiceCaptureSchema, budgetMs }).strict(),
] as const;
export const hostServiceCallSchema = z.discriminatedUnion('operation', hostServiceCallSchemas);
export type HostServiceCall = z.infer<typeof hostServiceCallSchema>;
export function isHostServiceCall(value: { operation: string }): value is HostServiceCall {
  return ['service-capture', 'service-stop', 'service-settle', 'service-query', 'service-lookup'].includes(value.operation);
}
export const hostServiceResultSchemas = [
  z.object({ operation: z.literal('service-capture'), outcome: windowsServiceOutcomeSchema }).strict(),
  z.object({ operation: z.literal('service-stop'), outcome: windowsServiceOutcomeSchema }).strict(),
  z.object({ operation: z.literal('service-settle'), outcome: windowsServiceOutcomeSchema }).strict(),
  z.object({ operation: z.literal('service-lookup'), outcome: windowsServiceOutcomeSchema }).strict(),
  z.object({ operation: z.literal('service-query'), outcome: windowsServiceOutcomeSchema }).strict(),
] as const;
export type HostServiceResult = z.infer<(typeof hostServiceResultSchemas)[number]>;

export function serviceSource(value: WindowsServiceSource): WindowsServiceSource {
  return { mainEpoch: value.mainEpoch, providerCapability: value.providerCapability,
    providerGeneration: value.providerGeneration, root: { ...value.root } };
}

export function validateServiceOutcome(call: HostServiceCall, outcome: WindowsServiceOutcome): void {
  const expected = call.operation === 'service-query' ? call.capture : call.intent;
  if (call.capability !== expected.providerCapability)
    throw new Error('Original service capability mismatch');
  if (!('capture' in outcome)) return;
  const command = call.operation === 'service-query' ? 'query' : call.intent.command.operation;
  const expectedState = command === 'capture' ? 'captured' : command === 'stop' ? 'stopped' :
    command === 'settle' ? 'settled' : 'observed';
  if (outcome.state !== expectedState || !isDeepStrictEqual(serviceSource(outcome.capture), serviceSource(expected)))
    throw new Error('Original service outcome mismatch');
  if (call.operation === 'service-query') {
    if (!isDeepStrictEqual(outcome.capture, call.capture)) throw new Error('Original service capture mismatch');
  } else if (call.intent.command.operation === 'capture') {
    if (outcome.capture.target.pid !== call.intent.command.pid ||
      !isDeepStrictEqual(outcome.capture.registrar, call.intent.command.registrar))
      throw new Error('Original service registrar mismatch');
  } else if (!isDeepStrictEqual(outcome.capture, call.intent.command.capture)) {
    throw new Error('Original service capture mismatch');
  }
}

/** This Host-side application facet never owns the broker or native HANDLEs. */
export interface WindowsRegisteredProcessPort {
  /** Pure private intent allocation; caller persists this exact projection before run. */
  prepareCapture(original: PendingOwnedProcess, pid: number, registrar: RegistrarBinding): WindowsServiceIntent;
  prepareControl(capture: WindowsServiceCapture, operation: 'stop' | 'settle'): WindowsServiceIntent;
  run(intent: WindowsServiceIntent, deadlineMs: number): Promise<WindowsServiceOutcome>;
  lookup(intent: WindowsServiceIntent, deadlineMs: number): Promise<WindowsServiceOutcome>;
  query(capture: WindowsServiceCapture, deadlineMs: number): Promise<WindowsServiceOutcome>;
}
