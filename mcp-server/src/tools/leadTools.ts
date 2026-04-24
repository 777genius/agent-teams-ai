import type { FastMCP } from 'fastmcp';
import { z } from 'zod';

import { getController } from '../controller';
import { assertConfiguredTeam } from '../utils/teamConfig';

const toolContextSchema = {
  teamName: z.string().min(1),
  claudeDir: z.string().min(1).optional(),
};

const ALWAYS_LOAD_META = {
  'anthropic/alwaysLoad': true,
} as const;

export function registerLeadTools(server: Pick<FastMCP, 'addTool'>) {
  server.addTool({
    name: 'lead_briefing',
    description: 'Get the compact operational lead queue for a team',
    _meta: ALWAYS_LOAD_META,
    parameters: z.object({
      ...toolContextSchema,
    }),
    execute: async ({ teamName, claudeDir }) => {
      assertConfiguredTeam(teamName, claudeDir);
      return {
        content: [
          {
            type: 'text' as const,
            text: await getController(teamName, claudeDir).tasks.leadBriefing(),
          },
        ],
      };
    },
  });
}
