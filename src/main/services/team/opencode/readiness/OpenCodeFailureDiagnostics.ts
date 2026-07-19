export function isOpenCodeTerminalProbeTechnicalDiagnostic(message: string): boolean {
  return (
    message.startsWith('OpenCode prompt start exposed a terminal provider error') ||
    message.startsWith('OpenCode retry status exposed a terminal provider error') ||
    (message.startsWith('OpenCode session ') &&
      message.includes(' request exposed a terminal provider error')) ||
    message.startsWith('OpenCode retry/error payload exposed a terminal provider failure') ||
    message.startsWith('OpenCode assistant payload exposed a terminal provider failure') ||
    message.startsWith('Cursor native failure probe will retry after a transient failure') ||
    message.startsWith('Cursor native execution preflight hit a transient failure') ||
    message.startsWith('Cursor native execution preflight was inconclusive') ||
    message.startsWith('Cursor native failure probe failed:') ||
    message.startsWith('Cursor native failure probe confirmed a terminal provider error')
  );
}
