import type {
  RuntimeProviderAuthMethodDto,
  RuntimeProviderSetupAuthOptionDto,
  RuntimeProviderSetupFormDto,
} from '../../contracts';

export type RuntimeProviderConnectionIntent = 'connect' | 'reconnect';

export interface RuntimeProviderSetupPresentation {
  readonly kind: 'default' | 'replace-api-credential' | 'reauthorize-oauth';
  readonly prefersBrowserCode: boolean;
}

function findSelectedAuthOption(
  form: RuntimeProviderSetupFormDto,
  selectedAuthOptionId: string | null
): RuntimeProviderSetupAuthOptionDto | null {
  return form.authOptions?.find((option) => option.id === selectedAuthOptionId) ?? null;
}

export function selectRuntimeProviderSetupAuthOptionId(input: {
  readonly form: RuntimeProviderSetupFormDto;
  readonly intent: RuntimeProviderConnectionIntent;
  readonly connectedAuthHint: string | null | undefined;
}): string | null {
  const options = input.form.authOptions ?? [];
  if (input.intent === 'reconnect') {
    const connectedMethod: RuntimeProviderAuthMethodDto | null =
      input.connectedAuthHint === 'api' || input.connectedAuthHint === 'oauth'
        ? input.connectedAuthHint
        : null;
    const matchingOption = connectedMethod
      ? options.find((option) => option.supported && option.method === connectedMethod)
      : null;
    if (matchingOption) {
      return matchingOption.id;
    }
  }
  return input.form.defaultAuthOptionId ?? options[0]?.id ?? null;
}

export function getRuntimeProviderSetupPresentation(input: {
  readonly form: RuntimeProviderSetupFormDto;
  readonly intent: RuntimeProviderConnectionIntent | null;
  readonly selectedAuthOptionId: string | null;
}): RuntimeProviderSetupPresentation {
  if (input.intent !== 'reconnect') {
    return {
      kind: 'default',
      prefersBrowserCode: false,
    };
  }

  const selectedOption = findSelectedAuthOption(input.form, input.selectedAuthOptionId);
  const method = selectedOption?.method ?? input.form.method;
  if (method === 'api') {
    return {
      kind: 'replace-api-credential',
      prefersBrowserCode: false,
    };
  }
  if (method === 'oauth') {
    return {
      kind: 'reauthorize-oauth',
      prefersBrowserCode: selectedOption?.label.toLowerCase().includes('browser code') ?? false,
    };
  }
  return {
    kind: 'default',
    prefersBrowserCode: false,
  };
}
