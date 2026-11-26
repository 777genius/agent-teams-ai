/** Project-context aliases are internal names and must be resolved through their owner index. */
export function isProjectCopyName(teamName: string): boolean {
  return /^ptc-[a-f0-9]{24}$/.test(teamName);
}
