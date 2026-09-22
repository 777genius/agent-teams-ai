import type { FastMCP } from 'fastmcp';
import { z } from 'zod';

import { getController } from '../controller';
import { jsonTextContent } from '../utils/format';
import { assertConfiguredTeam } from '../utils/teamConfig';

const toolContextSchema = {
  teamName: z.string().min(1),
  claudeDir: z.string().min(1).optional(),
};

export function registerProcessTools(server: Pick<FastMCP, 'addTool'>) {
  server.addTool({
    name: 'process_register',
    description:
      'Register a background service started by a teammate, such as a dev server, watcher, or database. This is not for teammate-agent liveness.',
    parameters: z.object({
      ...toolContextSchema,
      pid: z.number().int().positive(),
      label: z.string().min(1),
      from: z.string().optional(),
      command: z.string().min(1).optional(),
      port: z.number().int().min(1).max(65535).optional(),
      url: z.string().min(1).optional(),
      claudeProcessId: z.string().min(1).optional(),
    }),
    execute: async ({
      teamName,
      claudeDir,
      pid,
      label,
      from,
      command,
      port,
      url,
      claudeProcessId,
    }) => {
      assertConfiguredTeam(teamName, claudeDir);
      return await Promise.resolve(
        jsonTextContent(
          getController(teamName, claudeDir).processes.registerProcess({
          pid,
          label,
          ...(from ? { from } : {}),
          ...(command ? { command } : {}),
          ...(port ? { port } : {}),
          ...(url ? { url } : {}),
          ...(claudeProcessId ? { 'claude-process-id': claudeProcessId } : {}),
          })
        )
      );
    },
  });

  server.addTool({
    name: 'process_list',
    description:
      'List registered background services for the team, such as dev servers, watchers, or databases. This does not show teammate-agent liveness.',
    parameters: z.object({
      ...toolContextSchema,
    }),
    execute: async ({ teamName, claudeDir }) => {
      assertConfiguredTeam(teamName, claudeDir);
      return await Promise.resolve(
        jsonTextContent(getController(teamName, claudeDir).processes.listProcesses())
      );
    },
  });

  server.addTool({
    name: 'process_unregister',
    description:
      'Unregister a previously registered background service while keeping teammate-agent state separate.',
    parameters: z.object({
      ...toolContextSchema,
      pid: z.number().int().positive(),
    }),
    execute: async ({ teamName, claudeDir, pid }) => {
      assertConfiguredTeam(teamName, claudeDir);
      return await Promise.resolve(
        jsonTextContent(getController(teamName, claudeDir).processes.unregisterProcess({ pid }))
      );
    },
  });

  server.addTool({
    name: 'process_stop',
    description:
      'Mark a registered background service as stopped while preserving history. This is not for stopping teammate agents.',
    parameters: z.object({
      ...toolContextSchema,
      pid: z.number().int().positive(),
    }),
    execute: async ({ teamName, claudeDir, pid }) => {
      assertConfiguredTeam(teamName, claudeDir);
      return await Promise.resolve(
        jsonTextContent(getController(teamName, claudeDir).processes.stopProcess({ pid }))
      );
    },
  });
}
