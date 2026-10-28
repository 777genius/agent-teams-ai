import { Arch } from 'electron-builder';

import { stageUapRuntime } from '../stage-uap-runtime.ts';

export default async function beforePackUap(context: {
  electronPlatformName: string;
  arch: number;
}): Promise<void> {
  await stageUapRuntime({
    platform: `${context.electronPlatformName}-${Arch[context.arch]}`,
    ensure: true,
  });
}
