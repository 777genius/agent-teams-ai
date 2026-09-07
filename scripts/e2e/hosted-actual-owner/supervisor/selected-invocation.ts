import type { FilePin, IntegrationDescriptor } from '../contracts';
import { canonicalJson, exactRecord } from './canonical';

/** Selected by recipe v3 under the existing independently signed freeze. The
 * launcher ELF, Node executable, loader and bundled JS module are distinct. */
export interface SelectedSupervisorInvocation {
  readonly format: 'agent-teams.hosted-selected-supervisor-invocation/v1';
  readonly launcher: FilePin;
  readonly executable: FilePin;
  readonly loader: FilePin;
  readonly module: FilePin;
  readonly argv: readonly string[];
}

function check(value: unknown, reason: string): asserts value {
  if (!value) throw new Error(`selected_supervisor_invocation_${reason}`);
}

export function parseSelectedSupervisorInvocation(
  value: unknown,
  descriptor: IntegrationDescriptor,
): SelectedSupervisorInvocation {
  const row = exactRecord(value, ['format', 'launcher', 'executable', 'loader', 'module', 'argv'],
    'selected_supervisor_invocation');
  check(row.format === 'agent-teams.hosted-selected-supervisor-invocation/v1', 'version');
  check(canonicalJson(row.launcher) === canonicalJson(descriptor.p3b2.supervisor) &&
    canonicalJson(row.executable) === canonicalJson(descriptor.toolchain.node) &&
    canonicalJson(row.loader) === canonicalJson(descriptor.toolchain.loader), 'images');
  const module = exactRecord(row.module,
    ['root', 'relativePath', 'device', 'inode', 'size', 'mode', 'nlink', 'sha256'], 'supervisor_module');
  check(module.root === 'p3b2' && module.mode === 0o400 && module.nlink === 1 &&
    Number.isSafeInteger(module.size) && Number(module.size) > 0 && Number(module.size) <= 32 * 1024 * 1024 &&
    typeof module.relativePath === 'string' && module.relativePath.length < 512 &&
    /^[\x21-\x7e]+\.cjs$/u.test(module.relativePath) &&
    !module.relativePath.includes('\\') && !module.relativePath.includes(':') &&
    module.relativePath.split('/').every(part => part && part !== '.' && part !== '..') &&
    typeof module.sha256 === 'string' && /^[0-9a-f]{64}$/u.test(module.sha256), 'module');
  for (const part of [module.device, module.inode]) {
    check(typeof part === 'string' && /^(?:0|[1-9][0-9]{0,19})$/u.test(part) &&
      BigInt(part) <= 0xffffffffffffffffn, 'module_identity');
  }
  check(module.inode !== '0', 'module_inode');
  const argv = ['--selected-namespace-v1', descriptor.toolchain.loader.relativePath,
    descriptor.toolchain.node.relativePath, module.relativePath as string];
  check(argv.slice(1).every(path => path.length > 0 && path.length < 512 &&
    /^[\x21-\x7e]+$/u.test(path) && !path.includes('\\') && !path.includes(':') &&
    path.split('/').every(part => part && part !== '.' && part !== '..')), 'path');
  check(canonicalJson(row.argv) === canonicalJson(argv), 'argv');
  const selectedModule = Object.freeze({ ...module }) as unknown as FilePin;
  const pins = [selectedModule, descriptor.p3b2.supervisor, descriptor.p3b2.entry, descriptor.p3b2.recipe];
  check(new Set(pins.map(pin => pin.relativePath)).size === pins.length &&
    new Set(pins.map(pin => `${pin.device}:${pin.inode}`)).size === pins.length, 'module_alias');
  return Object.freeze({
    format: 'agent-teams.hosted-selected-supervisor-invocation/v1',
    launcher: Object.freeze({ ...descriptor.p3b2.supervisor }),
    executable: Object.freeze({ ...descriptor.toolchain.node }),
    loader: Object.freeze({ ...descriptor.toolchain.loader }),
    module: selectedModule,
    argv: Object.freeze(argv),
  });
}
