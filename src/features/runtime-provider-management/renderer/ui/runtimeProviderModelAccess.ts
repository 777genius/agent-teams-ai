import type { useAppTranslation } from '@features/localization/renderer';
import type {
  RuntimeProviderDefaultScopeDto,
  RuntimeProviderModelDto,
} from '@features/runtime-provider-management/contracts';

type SettingsT = ReturnType<typeof useAppTranslation>['t'];

export function isUnknownOpenCodeModelRoute(model: RuntimeProviderModelDto): boolean {
  return model.accessKind === 'unknown_model' || model.accessKind === 'no_model';
}

export function canTestOpenCodeModelRoute(model: RuntimeProviderModelDto): boolean {
  return !isUnknownOpenCodeModelRoute(model);
}

export function needsOpenCodeModelExecutionProof(model: RuntimeProviderModelDto): boolean {
  if (
    model.catalogStatus === 'deprecated' ||
    model.proofState === 'failed' ||
    model.availability === 'unavailable' ||
    model.availability === 'not-authenticated' ||
    model.accessKind === 'not_authenticated' ||
    model.accessKind === 'execution_failed' ||
    isUnknownOpenCodeModelRoute(model)
  ) {
    return false;
  }

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

export function canAttemptOpenCodeDefaultSelection(
  model: RuntimeProviderModelDto,
  scope: RuntimeProviderDefaultScopeDto
): boolean {
  if (model.catalogStatus === 'deprecated' || isUnknownOpenCodeModelRoute(model)) {
    return false;
  }
  if (scope === 'all_projects') {
    return true;
  }
  return canUseOpenCodeModelRoute(model) || needsOpenCodeModelExecutionProof(model);
}

export function getOpenCodeRouteUnavailableTitle(
  model: RuntimeProviderModelDto,
  t: SettingsT
): string | undefined {
  if (model.catalogStatus === 'deprecated') {
    return 'OpenCode marks this model as deprecated. Refresh the catalog and choose an active model.';
  }
  if (isUnknownOpenCodeModelRoute(model)) {
    return t('runtimeProvider.models.routeUnavailableUnknown');
  }
  if (model.accessKind === 'not_authenticated') {
    return model.accessReason ?? t('runtimeProvider.models.routeUnavailableAuth');
  }
  if (model.accessKind === 'execution_failed' || model.proofState === 'failed') {
    return model.accessReason ?? t('runtimeProvider.models.routeUnavailableFailed');
  }
  if (needsOpenCodeModelExecutionProof(model)) {
    return model.accessReason ?? 'Test this model successfully before using it.';
  }
  return undefined;
}
