import type {
  RuntimeProviderManagementViewDto,
  RuntimeProviderModelDto,
  RuntimeProviderModelTestResultDto,
} from '@features/runtime-provider-management/contracts';

export function buildFailedModelTestResult(
  providerId: string,
  modelId: string,
  message: string
): RuntimeProviderModelTestResultDto {
  return {
    providerId,
    modelId,
    ok: false,
    availability: 'unknown',
    message,
    diagnostics: [],
  };
}

export function applyModelTestResultToModel(
  model: RuntimeProviderModelDto,
  result: RuntimeProviderModelTestResultDto
): RuntimeProviderModelDto {
  if (model.modelId !== result.modelId) return model;
  return {
    ...model,
    availability: result.availability,
    proofState: result.ok ? 'verified' : 'failed',
    accessKind: result.ok ? 'verified' : model.accessKind,
    requiresExecutionProof: result.ok ? false : model.requiresExecutionProof,
  };
}

export function applyModelTestResultToView(
  view: RuntimeProviderManagementViewDto | null,
  result: RuntimeProviderModelTestResultDto
): RuntimeProviderManagementViewDto | null {
  if (!view?.configuredModels) return view;
  return {
    ...view,
    configuredModels: view.configuredModels.map((model) =>
      applyModelTestResultToModel(model, result)
    ),
  };
}
