import type { RuntimeProviderModelDto } from '@features/runtime-provider-management/contracts';

export function isUnknownOpenCodeModelRoute(model: RuntimeProviderModelDto): boolean {
  return model.accessKind === 'unknown_model' || model.accessKind === 'no_model';
}

export function canTestOpenCodeModelRoute(model: RuntimeProviderModelDto): boolean {
  return !isUnknownOpenCodeModelRoute(model);
}

export function needsOpenCodeModelExecutionProof(model: RuntimeProviderModelDto): boolean {
  return (
    (model.requiresExecutionProof === true || model.proofState === 'needs_probe') &&
    model.proofState !== 'verified' &&
    model.availability !== 'available' &&
    model.accessKind !== 'verified'
  );
}

export function canUseOpenCodeModelRoute(model: RuntimeProviderModelDto): boolean {
  return (
    model.catalogStatus !== 'deprecated' &&
    model.availability !== 'unavailable' &&
    model.availability !== 'not-authenticated' &&
    !isUnknownOpenCodeModelRoute(model) &&
    model.accessKind !== 'not_authenticated' &&
    model.accessKind !== 'execution_failed' &&
    model.proofState !== 'failed' &&
    !needsOpenCodeModelExecutionProof(model)
  );
}
