import { RUNTIME_EXECUTION_BACKENDS, type RuntimeExecutionBackendKind } from '../../contracts';

export function isRuntimeExecutionBackend(value: unknown): value is RuntimeExecutionBackendKind {
  return (RUNTIME_EXECUTION_BACKENDS as readonly unknown[]).includes(value);
}

export function requireRuntimeExecutionBackend(value: unknown): RuntimeExecutionBackendKind {
  if (!isRuntimeExecutionBackend(value)) {
    throw new TypeError('runtime-execution-backend-unsupported');
  }
  return value;
}
