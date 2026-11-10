import { sanitizeProcessCommandForDiagnostics } from '../TeamRuntimeLivenessResolver';

import type { InboxMessage, TaskRef } from '@shared/types';

function nowIso(): string {
  return new Date().toISOString();
}

export function asRuntimeRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('OpenCode runtime payload must be an object');
  }
  return value as Record<string, unknown>;
}

export function requireRuntimeString(value: unknown, fieldName: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`OpenCode runtime payload missing ${fieldName}`);
  }
  return value.trim();
}

export function optionalRuntimeString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

export function normalizeRuntimeIso(value: unknown, fallback: string = nowIso()): string {
  const raw = optionalRuntimeString(value);
  if (!raw) {
    return fallback;
  }
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : fallback;
}

export function normalizeRuntimeStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : [];
}

export interface RuntimeToolMetadata {
  runtimePid?: number;
  processCommand?: string;
  runtimeVersion?: string;
  hostPid?: number;
  cwd?: string;
}

export function normalizeRuntimePositiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.trunc(value)
    : undefined;
}

export function normalizeRuntimeMetadataString(
  value: unknown,
  maxLength: number
): string | undefined {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim().slice(0, maxLength)
    : undefined;
}

export function parseRuntimeToolMetadata(value: unknown): RuntimeToolMetadata {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  const raw = value as Record<string, unknown>;
  return {
    ...(normalizeRuntimePositiveInteger(raw.runtimePid)
      ? { runtimePid: normalizeRuntimePositiveInteger(raw.runtimePid) }
      : {}),
    ...(normalizeRuntimeMetadataString(raw.processCommand, 500)
      ? { processCommand: normalizeRuntimeMetadataString(raw.processCommand, 500) }
      : {}),
    ...(normalizeRuntimeMetadataString(raw.runtimeVersion, 80)
      ? { runtimeVersion: normalizeRuntimeMetadataString(raw.runtimeVersion, 80) }
      : {}),
    ...(normalizeRuntimePositiveInteger(raw.hostPid)
      ? { hostPid: normalizeRuntimePositiveInteger(raw.hostPid) }
      : {}),
    ...(normalizeRuntimeMetadataString(raw.cwd, 500)
      ? { cwd: normalizeRuntimeMetadataString(raw.cwd, 500) }
      : {}),
  };
}

export function buildRuntimeToolMetadataDiagnostics(
  metadata: RuntimeToolMetadata | undefined
): string[] {
  if (!metadata) {
    return [];
  }
  const diagnostics: string[] = [];
  if (metadata.runtimePid != null) {
    diagnostics.push(`runtime pid: ${metadata.runtimePid}`);
  }
  if (metadata.processCommand) {
    const processCommand = sanitizeProcessCommandForDiagnostics(metadata.processCommand);
    if (processCommand) {
      diagnostics.push(`runtime process command: ${processCommand}`);
    }
  }
  if (metadata.runtimeVersion) {
    diagnostics.push(`runtime version: ${metadata.runtimeVersion}`);
  }
  if (metadata.hostPid != null) {
    diagnostics.push(`runtime host pid: ${metadata.hostPid}`);
  }
  if (metadata.cwd) {
    diagnostics.push(`runtime cwd: ${metadata.cwd}`);
  }
  return diagnostics;
}

export function runtimeTaskRefs(
  teamName: string,
  value: unknown
): InboxMessage['taskRefs'] | undefined {
  const refs = normalizeRuntimeStringArray(value);
  return refs.length > 0
    ? refs.map((ref) => ({
        teamName,
        taskId: ref,
        displayId: ref,
      }))
    : undefined;
}

export function structuredTaskRefs(value: unknown): TaskRef[] | undefined {
  if (!Array.isArray(value) || value.length === 0) {
    return undefined;
  }

  const refs = value
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
    .map((item) => ({
      taskId: typeof item.taskId === 'string' ? item.taskId.trim() : '',
      displayId: typeof item.displayId === 'string' ? item.displayId.trim() : '',
      teamName: typeof item.teamName === 'string' ? item.teamName.trim() : '',
    }))
    .filter(
      (item) => item.taskId.length > 0 && item.displayId.length > 0 && item.teamName.length > 0
    );

  return refs.length > 0 ? refs : undefined;
}

export function teamToolTaskRefs(teamName: string, value: unknown): TaskRef[] | undefined {
  return structuredTaskRefs(value) ?? runtimeTaskRefs(teamName, value);
}

export function mergeRuntimeDiagnostics(
  previous: string[] | undefined,
  incoming: unknown,
  fallback?: string
): string[] | undefined {
  const merged = [
    ...(previous ?? []),
    ...normalizeRuntimeStringArray(incoming),
    ...(fallback ? [fallback] : []),
  ].filter((value) => value.trim().length > 0);
  return merged.length > 0 ? [...new Set(merged)] : undefined;
}
