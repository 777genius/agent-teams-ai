import { z } from 'zod';

export const taskRefSchema = z.object({
  taskId: z.string().min(1),
  displayId: z.string().min(1),
  teamName: z.string().min(1),
});

export const teamMemberMcpPolicySchema = z.object({
  mode: z.enum(['inheritLead', 'inheritScopes', 'strictAllowlist', 'appOnly']),
  scopes: z
    .object({
      user: z.boolean().optional(),
      project: z.boolean().optional(),
      local: z.boolean().optional(),
    })
    .optional(),
  serverNames: z.array(z.string().min(1).max(128)).optional(),
});
