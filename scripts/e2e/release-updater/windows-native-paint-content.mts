export type WindowsNativePaintPhase =
  | 'caption-ready'
  | 'available'
  | 'fresh'
  | 'automatic-successor';

export function windowsNativePaintContentReady(
  phase: WindowsNativePaintPhase,
  names: readonly string[],
  targetVersion: string
): boolean {
  const text = names.join('\n');
  if (/Preparing workspace/iu.test(text)) return false;
  switch (phase) {
    case 'caption-ready':
      return (
        names.includes('Settings') &&
        names.includes('Manage your app preferences') &&
        names.includes('CLI RUNTIME') &&
        names.includes('Tasks') &&
        names.includes('Version 2.17.1') &&
        names.filter((name) => /^Version\s/iu.test(name)).every((name) => name === 'Version 2.17.1')
      );
    case 'available':
      return text.includes(targetVersion) && /^Download$/imu.test(text);
    case 'fresh':
    case 'automatic-successor':
      return /Providers\s*&\s*plans/iu.test(text) && /^Tasks$/imu.test(text);
    default:
      return false;
  }
}
