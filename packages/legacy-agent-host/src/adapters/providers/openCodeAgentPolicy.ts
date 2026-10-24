/** OpenCode 1.19.4 seeds permissions from deprecated tools before explicit rules.
 * Emit one ordered permission map so managed tools follow every captured wildcard.
 */
export function canonicalOpenCodeAgentPermission(
  tools: Record<string, unknown>,
  selected: Record<string, unknown>,
  required: readonly string[]
): Record<string, unknown> {
  const permission: Record<string, unknown> = {};
  for (const [tool, enabled] of Object.entries(tools)) {
    if (typeof enabled !== 'boolean') throw new Error('Invalid OpenCode agent tools');
    const key = ['write', 'edit', 'patch'].includes(tool) ? 'edit' : tool;
    permission[key] = enabled ? 'allow' : 'deny';
  }
  Object.assign(permission, selected);
  for (const name of required) {
    delete permission[name];
    permission[name] = 'allow';
  }
  return permission;
}

/** GET/config preserves the pinned native permission order used by /agent. */
export function requiredOpenCodeToolsAllowed(
  permission: Record<string, unknown>,
  required: readonly string[]
): boolean {
  const rules = Object.entries(permission);
  return required.every((name) => {
    const last = rules.findLast(([pattern]) => matchesPermission(name, pattern));
    return permission[name] === 'allow' && last?.[1] === 'allow';
  });
}

// OpenCode 1.19.4 core/util/wildcard.ts semantics; required names are POSIX MCP IDs.
function matchesPermission(name: string, pattern: string): boolean {
  let escaped = pattern
    .replaceAll('\\', '/')
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  if (escaped.endsWith(' .*')) escaped = escaped.slice(0, -3) + '( .*)?';
  return new RegExp('^' + escaped + '$', 's').test(name);
}
