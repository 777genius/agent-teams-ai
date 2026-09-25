import { app } from 'electron';

import type { RuntimeEnvironmentPort } from '../../core/application/ports/TeamViewReadModelPorts';

export const electronRuntimeEnvironment: RuntimeEnvironmentPort = {
  isPackaged: () => app.isPackaged,
};
