import { CUSTOM_TEAM_TEMPLATE_ROUTES } from '../../../../contracts';

import type { CustomTeamTemplatesFeature } from '../../../composition/createCustomTeamTemplatesFeature';
import type { FastifyInstance } from 'fastify';

/**
 * Registers the custom-team-templates HTTP routes.
 *
 * Routes mirror the IPC handlers exactly: the raw request body goes straight
 * into the same composed use case, and the use case's typed outcome is the
 * response body. Because the outcome is closed, a storage-backed failure is
 * returned as data (`storageUnavailable`, `unresolved`, …) rather than as an
 * HTTP error, so a browser client sees precisely what an Electron client sees.
 *
 * The library read is a GET because it is read-only; the three write-capable or
 * write-adjacent operations are POSTs.
 */
export function registerCustomTeamTemplatesHttp(
  app: FastifyInstance,
  feature: CustomTeamTemplatesFeature
): void {
  app.post(CUSTOM_TEAM_TEMPLATE_ROUTES.preparePreview, async (request) =>
    feature.preparePreview.execute(request.body)
  );
  app.post(CUSTOM_TEAM_TEMPLATE_ROUTES.saveTemplate, async (request) =>
    feature.saveTemplate.execute(request.body)
  );
  app.post(CUSTOM_TEAM_TEMPLATE_ROUTES.recheckSave, async (request) =>
    feature.recheckSave.execute(request.body)
  );
  app.get(CUSTOM_TEAM_TEMPLATE_ROUTES.listTemplates, async () => feature.listTemplates.execute());
}
