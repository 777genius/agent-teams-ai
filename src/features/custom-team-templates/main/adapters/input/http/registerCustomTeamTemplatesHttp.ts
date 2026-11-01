import { CUSTOM_TEAM_TEMPLATE_ROUTES } from '../../../../contracts';

import type { CustomTeamTemplatesFeature } from '../../../composition/createCustomTeamTemplatesFeature';
import type { FastifyInstance, RouteShorthandOptions } from 'fastify';

/**
 * Custom-team-templates HTTP route body limit.
 *
 * Established template contract bounds (src/features/custom-team-templates/core/domain/templateLimits.ts):
 * - teamPrompt: max 200_000 characters
 * - members: max 100
 * - member role: max 128 characters
 * - member workflow: max 200_000 characters
 * - description: max 2_000 characters
 * - template name: max 128 characters
 *
 * Worst-case JSON body (valid contract):
 * - teamPrompt UTF-8 (200_000 BMP code units, 3 bytes each): 600_000
 * - 100 members x (name 128 x 3B + role 128 x 3B + workflow 200_000 x 3B
 *   + JSON keys/quotes/separators ~ 28):
 *   100 x (384 + 384 + 600_002 + 28) ~= 60_078_200
 * - description (2_000 x 3B + structural): ~= 6_014
 * - envelope + keys ~= 2_000
 * - Grand total ~= 60_700_000 bytes ~= 57.9 MiB
 *
 * 128 MiB (134_217_728 bytes) provides ~= 2.2x margin and is the documented
 * Fastify route-level ceiling that accommodates the full contract. Unrelated
 * HTTP routes keep Fastify's default 1 MiB limit and are not touched here.
 */
export const CUSTOM_TEAM_TEMPLATE_BODY_LIMIT = 128 * 1024 * 1024; // 128 MiB

/**
 * Registers the custom-team-templates HTTP routes.
 *
 * Routes mirror the IPC handlers exactly: the raw request body goes straight
 * into the same composed use case, and the use case's typed outcome is the
 * response body. Because the outcome is closed, a storage-backed failure is
 * returned as data (storageUnavailable, unresolved, ...) rather than as an
 * HTTP error, so a browser client sees precisely what an Electron client sees.
 *
 * The library read is a GET because it is read-only; the other seven
 * operations are POSTs.
 */
export function registerCustomTeamTemplatesHttp(
  app: FastifyInstance,
  feature: CustomTeamTemplatesFeature
): void {
  const routeOptions = {
    bodyLimit: CUSTOM_TEAM_TEMPLATE_BODY_LIMIT,
  } satisfies Partial<RouteShorthandOptions>;

  app.post(CUSTOM_TEAM_TEMPLATE_ROUTES.preparePreview, routeOptions, async (request) =>
    feature.preparePreview.execute(request.body)
  );
  app.post(CUSTOM_TEAM_TEMPLATE_ROUTES.saveTemplate, routeOptions, async (request) =>
    feature.saveTemplate.execute(request.body)
  );
  app.post(CUSTOM_TEAM_TEMPLATE_ROUTES.recheckSave, routeOptions, async (request) =>
    feature.recheckSave.execute(request.body)
  );
  app.get(CUSTOM_TEAM_TEMPLATE_ROUTES.listTemplates, async () => feature.listTemplates.execute());
  app.post(CUSTOM_TEAM_TEMPLATE_ROUTES.updateTemplate, routeOptions, async (request) =>
    feature.updateTemplate.execute(request.body)
  );
  app.post(CUSTOM_TEAM_TEMPLATE_ROUTES.deleteTemplate, routeOptions, async (request) =>
    feature.deleteTemplate.execute(request.body)
  );
  app.post(CUSTOM_TEAM_TEMPLATE_ROUTES.duplicateTemplate, routeOptions, async (request) =>
    feature.duplicateTemplate.execute(request.body)
  );
  app.post(CUSTOM_TEAM_TEMPLATE_ROUTES.copyBuiltinTemplate, routeOptions, async (request) =>
    feature.copyBuiltinTemplate.execute(request.body)
  );
}
