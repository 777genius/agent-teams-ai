export type HostedContainerHardeningProfile = 'personal' | 'keycloak';

export interface HostedContainerHardeningResult {
  format: 'hosted-container-hardening-verifier-result/v2';
  status: 'passed' | 'failed';
  summary: {
    checkedProfiles: number;
    checkedServices: number;
    violations: number;
  };
  violations: string[];
}

export interface HostedContainerHardeningMount {
  type?: string;
  source?: string;
  target?: string;
  read_only?: boolean;
  [property: string]: unknown;
}

export interface HostedContainerHardeningBuild {
  context?: string;
  dockerfile?: string;
  target?: string;
  args: Record<string, string>;
  [property: string]: unknown;
}

export interface HostedContainerHardeningNetwork {
  internal?: boolean;
  [property: string]: unknown;
}

export interface HostedContainerHardeningNetworkAttachment {
  [property: string]: unknown;
}

export interface HostedContainerHardeningPort {
  target?: number;
  published?: string | number;
  protocol?: string;
  [property: string]: unknown;
}

export interface HostedContainerHardeningService {
  user?: string;
  read_only?: boolean;
  cap_add?: string[];
  cap_drop?: string[];
  security_opt?: string[];
  pids_limit?: number | string;
  cpus?: number | string;
  mem_limit?: string;
  stop_grace_period?: string;
  restart?: string;
  volumes?: HostedContainerHardeningMount[];
  healthcheck?: Record<string, unknown>;
  depends_on?: Record<string, string | Record<string, unknown>>;
  networks?: Record<string, HostedContainerHardeningNetworkAttachment>;
  build?: HostedContainerHardeningBuild;
  image?: string;
  privileged?: boolean;
  devices?: Array<{ path?: string; [property: string]: unknown }>;
  volumes_from?: string[];
  pid?: string;
  ipc?: string;
  command?: string | string[];
  environment?: Record<string, string | number | boolean | null>;
  secrets?: Array<string | Record<string, unknown>>;
  entrypoint?: string | string[];
  tmpfs?: string[];
  ports?: HostedContainerHardeningPort[];
  network_mode?: string;
  [property: string]: unknown;
}

export interface HostedContainerHardeningCompose {
  services: Record<string, HostedContainerHardeningService>;
  networks: Record<string, HostedContainerHardeningNetwork>;
  volumes?: Record<string, Record<string, unknown>>;
  secrets?: Record<string, Record<string, unknown>>;
  [property: string]: unknown;
}

export interface HostedContainerHardeningComposeInput {
  services?: Record<string, unknown>;
  [property: string]: unknown;
}

export interface HostedContainerHardeningOptions {
  root?: string;
  profile?: string;
  dockerBinary?: string;
  environment?: NodeJS.ProcessEnv;
  dockerfile?: string;
  volumeInitializer?: string;
  renderedCompose?: string | HostedContainerHardeningCompose | HostedContainerHardeningComposeInput;
  renderedComposes?: Partial<
    Record<
      HostedContainerHardeningProfile,
      string | HostedContainerHardeningCompose | HostedContainerHardeningComposeInput
    >
  >;
}

export interface RenderHostedContainerHardeningComposeOptions {
  profile: HostedContainerHardeningProfile;
  root?: string;
  dockerBinary?: string;
  environment?: NodeJS.ProcessEnv;
}

export function verifyHostedContainerHardening(
  options?: HostedContainerHardeningOptions
): HostedContainerHardeningResult;

export function renderHostedContainerHardeningCompose(
  options: RenderHostedContainerHardeningComposeOptions
): HostedContainerHardeningCompose;
