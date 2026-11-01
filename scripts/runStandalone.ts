import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildPublicationHelper } from './build/publicationHelper';

void buildPublicationHelper(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')).then(
  () => import('../src/main/standalone'),
);
