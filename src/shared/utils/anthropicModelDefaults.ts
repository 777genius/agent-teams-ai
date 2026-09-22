export function getAnthropicDefaultTeamModel(limitContext: boolean): string {
  return limitContext ? 'opus' : 'opus[1m]';
}
