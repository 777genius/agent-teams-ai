import { mergeJsonSettingsArgs } from './cliSettingsArgs';

export function buildProviderLaunchCliCommandArgs(
  providerArgs: string[],
  args: string[]
): string[] {
  return mergeJsonSettingsArgs([...providerArgs, ...args]);
}

export function stripProviderControlPlaneUnsupportedArgs(providerArgs: string[]): string[] {
  const filtered: string[] = [];
  let index = 0;
  while (index < providerArgs.length) {
    const arg = providerArgs[index];
    if (arg === '-c' || arg === '--config') {
      index += 2;
      continue;
    }
    if (arg.startsWith('-c=') || arg.startsWith('--config=')) {
      index += 1;
      continue;
    }
    filtered.push(arg);
    index += 1;
  }
  return filtered;
}

export function buildProviderControlPlaneCliCommandArgs(
  providerArgs: string[],
  args: string[]
): string[] {
  return mergeJsonSettingsArgs([
    ...stripProviderControlPlaneUnsupportedArgs(providerArgs),
    ...args,
  ]);
}
