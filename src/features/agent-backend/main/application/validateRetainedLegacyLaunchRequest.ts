import { isAbsolute } from 'node:path';

import type { RetainedLegacyLaunchRequest } from '../../contracts/retainedLegacyLaunch';

const identifier = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const actions = {
  open: ['teamName', 'intentId'],
  close: ['scopeId'],
  read: ['scopeId'],
  account: ['scopeId'],
  closeIntent: ['teamName', 'intentId'],
  rebind: ['scopeId', 'projectPath', 'intentId'],
  opencodeRuntime: ['scopeId'],
  codexRuntime: ['scopeId'],
  status: ['scopeId', 'projectPath'],
  models: ['scopeId', 'input'],
  directory: ['scopeId', 'input'],
  localProviders: ['scopeId', 'input'],
  scanLocalProviders: ['scopeId', 'input'],
  cancelModels: ['scopeId', 'input'],
  prepare: ['scopeId', 'args'],
  roster: ['scopeId', 'request'],
  launch: ['scopeId', 'request'],
} as const;

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('invalid');
  return value as Record<string, unknown>;
}

/** Only finite actions and bounded copied DTOs cross this temporary capability boundary. */
export function validateRetainedLegacyLaunchRequest(value: unknown): RetainedLegacyLaunchRequest {
  const raw = record(value);
  if (typeof raw.action !== 'string' || !Object.hasOwn(actions, raw.action))
    throw new TypeError('invalid');
  const action = raw.action as keyof typeof actions;
  const keys: readonly string[] = actions[action];
  if (Object.keys(raw).some((key) => key !== 'action' && !keys.includes(key)))
    throw new TypeError('invalid');
  if (action === 'open' || action === 'closeIntent') {
    if (
      typeof raw.teamName !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(raw.teamName) ||
      typeof raw.intentId !== 'string' ||
      !identifier.test(raw.intentId)
    )
      throw new TypeError('invalid');
  } else if (typeof raw.scopeId !== 'string' || !identifier.test(raw.scopeId))
    throw new TypeError('invalid');
  if (
    action === 'rebind' &&
    (typeof raw.intentId !== 'string' ||
      !identifier.test(raw.intentId) ||
      typeof raw.projectPath !== 'string' ||
      !isAbsolute(raw.projectPath))
  )
    throw new TypeError('invalid');
  if (
    action === 'status' &&
    (typeof raw.projectPath !== 'string' ||
      (raw.projectPath !== '' && !isAbsolute(raw.projectPath)))
  )
    throw new TypeError('invalid');
  if (
    ['models', 'directory', 'localProviders', 'scanLocalProviders', 'cancelModels'].includes(action)
  ) {
    const input = record(raw.input);
    if (action === 'cancelModels') {
      if (
        Object.keys(input).some((key) => key !== 'requestGroupId') ||
        typeof input.requestGroupId !== 'string' ||
        !identifier.test(input.requestGroupId)
      )
        throw new TypeError('invalid');
    } else {
      if (input.runtimeId !== 'opencode' || Object.hasOwn(input, 'connectionContextToken'))
        throw new TypeError('invalid');
      if (
        input.projectPath != null &&
        (typeof input.projectPath !== 'string' || !isAbsolute(input.projectPath))
      )
        throw new TypeError('invalid');
      if (action === 'models' && (typeof input.providerId !== 'string' || !input.providerId.trim()))
        throw new TypeError('invalid');
      if (action === 'localProviders' && !['global', 'project'].includes(String(input.scope)))
        throw new TypeError('invalid');
    }
  }
  if (action === 'prepare' && (!Array.isArray(raw.args) || raw.args.length > 8))
    throw new TypeError('invalid');
  if (action === 'roster' || action === 'launch') record(raw.request);
  const encoded = JSON.stringify(raw);
  if (encoded.length > 128 * 1024) throw new TypeError('invalid');
  return JSON.parse(encoded) as RetainedLegacyLaunchRequest;
}
