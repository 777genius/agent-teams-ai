import type { BackendRuntimeSnapshot } from '../../../contracts/operations';

/** Capabilities are meaningful only for the exact attached, ready generation. */
export function projectNativeSessionCommands(value: unknown, state: BackendRuntimeSnapshot) {
  if (
    !state.generation ||
    !state.attached ||
    !state.nativeReady ||
    state.sealed ||
    state.phase !== 'allocated' ||
    state.custody !== 'owned' ||
    !Array.isArray(value) ||
    value.length > 4096
  )
    throw new Error('Invalid native command capability');
  const names = new Set<string>();
  return value.map((item: unknown) => {
    if (!item || typeof item !== 'object' || Array.isArray(item))
      throw new Error('Invalid native command');
    const row = item as Record<string, unknown>;
    if (
      typeof row.name !== 'string' ||
      !/^[a-z][a-z0-9:-]{0,63}$/iu.test(row.name) ||
      names.has(row.name) ||
      typeof row.description !== 'string' ||
      row.description.length > 4096 ||
      row.description.includes('\0')
    )
      throw new Error('Invalid native command');
    names.add(row.name);
    return { name: row.name, description: row.description };
  });
}
