/** Minimum payload safety shared by canonical config reads and configuration management. */
export function isReadableTeamConfigPayload(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const config = value as Record<string, unknown>;
  if (typeof config.name !== 'string' || !config.name.trim()) return false;
  return (
    config.members == null ||
    (Array.isArray(config.members) &&
      config.members.every(
        (member) =>
          member &&
          typeof member === 'object' &&
          !Array.isArray(member) &&
          typeof member.name === 'string' &&
          ['agentId', 'agentType', 'role', 'color'].every(
            (key) => member[key] == null || typeof member[key] === 'string'
          )
      ))
  );
}
