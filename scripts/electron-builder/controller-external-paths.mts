import { resolve } from 'node:path';

/** Workspace callers keep source entrypoints; production Electron loads compiled JS. */
export function controllerExternalPaths(
  command: string,
  projectRoot: string
): Record<string, string> | undefined {
  if (command !== 'build') return undefined;
  const sourceEntries = [
    'agent-teams-controller',
    resolve(projectRoot, 'agent-teams-controller/src/index.js'),
    resolve(projectRoot, 'node_modules/agent-teams-controller/src/index.js'),
  ];
  return Object.fromEntries(
    sourceEntries.flatMap((id) =>
      [id, id.replaceAll('\\', '/')].map((key) => [key, 'agent-teams-controller/dist/index.js'])
    )
  );
}
