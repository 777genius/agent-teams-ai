import type { FastMCP } from 'fastmcp';
import { z } from 'zod';

import { getController } from '../controller';
import { jsonTextContent } from '../utils/format';

const toolContextSchema = {
  teamName: z.string().min(1),
  claudeDir: z.string().min(1).optional(),
};

export function registerProcessTools(server: Pick<FastMCP, 'addTool'>) {
  server.addTool({
    name: 'process_register',
    description: 'Register a running process for a team member',
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
    }) =>
      await Promise.resolve(
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
      ),
  });

  server.addTool({
    name: 'process_list',
    description: 'List registered team processes',
    parameters: z.object({
      ...toolContextSchema,
    }),
    execute: async ({ teamName, claudeDir }) =>
      await Promise.resolve(
        jsonTextContent(getController(teamName, claudeDir).processes.listProcesses())
      ),
  });

  server.addTool({
    name: 'process_unregister',
    description: 'Unregister a previously registered process',
    parameters: z.object({
      ...toolContextSchema,
      pid: z.number().int().positive(),
    }),
    execute: async ({ teamName, claudeDir, pid }) =>
      await Promise.resolve(
        jsonTextContent(getController(teamName, claudeDir).processes.unregisterProcess({ pid }))
      ),
  });

  server.addTool({
    name: 'process_stop',
    description: 'Mark a registered process as stopped while preserving history',
    parameters: z.object({
      ...toolContextSchema,
      pid: z.number().int().positive(),
    }),
    execute: async ({ teamName, claudeDir, pid }) =>
      await Promise.resolve(
        jsonTextContent(getController(teamName, claudeDir).processes.stopProcess({ pid }))
      ),
  });
}
