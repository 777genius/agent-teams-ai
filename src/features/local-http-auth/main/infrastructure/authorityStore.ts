import { randomUUID } from 'node:crypto';

import { captureApiAuthorityHintRevocation } from './apiAuthorityParentHints';
import { RetainedApiPublicationError } from './authorityErrors';
import { apiReferencePath } from './authorityPaths';
import {
  publicationRootMode,
  requestPublication,
} from './publicationHelperClient';
import { parsePublicationRequest } from './publicationHelperProtocol';

import type { ApiAuthority } from '../../contracts';

export { RetainedApiPublicationError } from './authorityErrors';
export { apiProfileScope } from './authorityPaths';

export async function publishApiAuthority(
  root: string,
  authority: ApiAuthority,
): Promise<string> {
  const request = parsePublicationRequest({
    v: 1,
    id: randomUUID(),
    op: 'publish',
    root,
    rootMode: publicationRootMode(),
    authority,
  });
  const revoke = captureApiAuthorityHintRevocation(root, request.authority);
  const result = await requestPublication(request);
  if (result.hintAction === 'revoke-matching') revoke();
  const reference = apiReferencePath(root, request.authority.instanceId);
  if (result.outcome === 'retained')
    throw new RetainedApiPublicationError(
      reference,
      new Error('API optional discovery refresh failed'),
    );
  if (result.code === 'immutable-generation')
    throw new Error('API generation descriptor is immutable');
  if (result.outcome !== 'published')
    throw new Error('API authority publication failed');
  return reference;
}
export async function removeApiAuthority(
  root: string,
  authority: ApiAuthority,
): Promise<void> {
  const request = parsePublicationRequest({
    v: 1,
    id: randomUUID(),
    op: 'remove',
    root,
    rootMode: 'existing',
    authority,
  });
  const revoke = captureApiAuthorityHintRevocation(root, request.authority);
  const result = await requestPublication(request);
  if (result.hintAction === 'revoke-matching') revoke();
  if (result.outcome !== 'removed')
    throw new Error('API authority removal failed');
}
