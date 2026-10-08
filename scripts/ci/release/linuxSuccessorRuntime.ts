import { canonical, requireThat } from './contract.js';
import { at, list, object } from './nativeReadinessAuthority.js';

function equal(actual: unknown, expected: unknown, label: string): void {
  requireThat(canonical(actual) === canonical(expected), `Native proof mismatch: ${label}`);
}

export function checkLinuxSuccessorRuntime(value: Record<string, unknown>): void {
  const seal = at(value, 'automaticLaunchSeal', 'launch');
  const kernel = value.automaticSealAfterPaint;
  const sealed = list(at(seal, 'command'), 'sealed command');
  const inspector = object(value.automaticReadOnlyInspector, 'automatic successor Inspector');
  const identity = object(inspector.identity, 'automatic successor identity');
  requireThat(
    typeof identity.pid === 'number' &&
      Number.isSafeInteger(identity.pid) &&
      identity.pid > 0 &&
      typeof identity.start === 'string' &&
      identity.start.length > 0,
    'Missing automatic successor generation'
  );
  equal(identity.pid, at(kernel, 'identity', 'pid'), 'Successor Inspector PID');
  equal(identity.start, at(kernel, 'identity', 'start'), 'Successor Inspector start');
  equal(identity.pid, at(value, 'automaticProcess', 'pid'), 'Automatic successor PID');
  equal(identity.start, at(value, 'automaticProcess', 'start'), 'Automatic successor start');
  const actual = object(inspector.actual, 'automatic successor runtime');
  equal(actual.pid, identity.pid, 'Successor runtime PID');
  for (const field of ['home', 'profile', 'userData', 'version', 'executable'])
    requireThat(
      typeof actual[field] === 'string' && actual[field].trim().length > 0,
      `Missing successor runtime ${field}`
    );
  equal(actual.home, at(seal, 'home'), 'Successor HOME');
  equal(actual.profile, at(seal, 'userData'), 'Successor profile');
  equal(actual.userData, at(seal, 'userData'), 'Successor Electron userData');
  const argv = list(actual.argv, 'successor argv');
  const execArgv = list(actual.execArgv, 'successor execArgv');
  requireThat(
    [...argv, ...execArgv].every((item) => typeof item === 'string'),
    'Invalid successor runtime arguments'
  );
  equal(argv, sealed, 'Successor argv');
  equal(execArgv, at(seal, 'runtime', 'execArgv'), 'Successor execArgv');
  equal(actual.version, value.targetVersion, 'Successor version');
  equal(actual.executable, at(kernel, 'executable'), 'Successor executable');
  const markers = object(at(kernel, 'markers'), 'successor kernel markers');
  if (markers.HOME !== undefined) equal(markers.HOME, at(seal, 'home'), 'Sealed HOME');
  if (markers.AGENT_TEAMS_ELECTRON_USER_DATA_DIR !== undefined)
    equal(markers.AGENT_TEAMS_ELECTRON_USER_DATA_DIR, at(seal, 'userData'), 'Sealed profile');
}
