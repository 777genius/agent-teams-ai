export interface RenderedHostedCompose {
  services: Record<string, unknown>;
  [property: string]: unknown;
}

export interface RenderHostedContainerHardeningComposeOptions {
  profile: 'personal' | 'keycloak';
  root?: string;
  dockerBinary?: string;
  environment?: NodeJS.ProcessEnv;
}

export function parseRenderedHostedCompose(
  value: string | RenderedHostedCompose
): RenderedHostedCompose;

export function restoreExplicitBindCreateHostPathFalse<T extends RenderedHostedCompose>(
  renderedCompose: T,
  rawComposeSource: string
): T;

export function renderHostedContainerHardeningCompose(
  options: RenderHostedContainerHardeningComposeOptions
): RenderedHostedCompose;
