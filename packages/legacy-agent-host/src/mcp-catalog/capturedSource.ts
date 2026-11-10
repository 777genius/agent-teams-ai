import { z } from 'zod';
import { isDeepStrictEqual } from 'node:util';
import { memberSettingsSchema } from '../team/rosterSchema.js';
import { CapturedClaudeMcpCatalogReader } from './captureClaudeCatalog.js';
import { selectMcpCatalog } from './catalog.js';
import { normalizeTeamMemberMcpPolicy } from './memberPolicy.js';
import { captureSelectedMcpServers } from './capturedServer.js';
import type { CapturedMcpServers } from './capturedServer.js';

const path = z
  .string()
  .min(1)
  .max(8192)
  .startsWith('/')
  .refine((value) => !/[\0\r\n]/u.test(value));
/** Private original selection input. Renderer/capture source retains only its artifact digest. */
export const capturedMcpSourceSchema = z
  .object({ userConfigPath: path, projectPath: path, policy: memberSettingsSchema.shape.mcpPolicy })
  .strict();
export type CapturedMcpSource = z.infer<typeof capturedMcpSourceSchema>;

/** Historical construction is independent from this current-input admission check. */
export function capturedMcpSourceCurrent(profile: {
  capturedMcpServers?: CapturedMcpServers | undefined;
  capturedMcpSource?: CapturedMcpSource | undefined;
}): boolean {
  if (!profile.capturedMcpSource) return true;
  try {
    const source = capturedMcpSourceSchema.parse(profile.capturedMcpSource);
    const rows = new CapturedClaudeMcpCatalogReader().readCatalog(source);
    const selected = captureSelectedMcpServers(
      selectMcpCatalog(rows, normalizeTeamMemberMcpPolicy(source.policy), ['team', 'agent-teams'])
    );
    return isDeepStrictEqual(selected, profile.capturedMcpServers);
  } catch {
    return false;
  }
}
