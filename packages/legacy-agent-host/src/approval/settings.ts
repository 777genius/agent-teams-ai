import { z } from 'zod';

export const toolApprovalSettingsSchema = z
  .object({
    autoAllowAll: z.boolean(),
    autoAllowFileEdits: z.boolean(),
    autoAllowSafeBash: z.boolean(),
    timeoutAction: z.enum(['allow', 'deny', 'wait']),
    timeoutSeconds: z.number().finite().min(5).max(300),
  })
  .strict();

export const DEFAULT_TOOL_APPROVAL_SETTINGS = Object.freeze({
  autoAllowAll: false,
  autoAllowFileEdits: false,
  autoAllowSafeBash: false,
  timeoutAction: 'wait' as const,
  timeoutSeconds: 30,
});
