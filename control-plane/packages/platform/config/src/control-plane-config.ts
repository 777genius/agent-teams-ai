import {
  createSafeError,
  type ControlPlaneBuildInfo,
  type SafeError,
  type ValidationIssue,
} from "@agent-teams-control-plane/shared";
import { z } from "zod";

export const CONTROL_PLANE_MODES = [
  "local-disabled",
  "hosted-official-app",
  "self-hosted-byo-app",
] as const;

export type ControlPlaneMode = (typeof CONTROL_PLANE_MODES)[number];

export type ControlPlaneConfig = Readonly<{
  environment: "development" | "test" | "production";
  mode: ControlPlaneMode;
  http: Readonly<{
    host: string;
    port: number;
  }>;
  persistence: Readonly<{
    enabled: boolean;
  }>;
  database: Readonly<{
    url?: string;
    sslMode: "disable" | "prefer" | "require";
    poolMax: number;
  }>;
  outbox: Readonly<{
    workerEnabled: boolean;
    batchSize: number;
    leaseSeconds: number;
    pollIntervalMs: number;
    shutdownTimeoutMs: number;
    maxAttempts: number;
  }>;
  retention: Readonly<{
    completedOutboxDays?: number;
    deadLetterDays?: number;
    externalContentDays?: number;
  }>;
  build: ControlPlaneBuildInfo;
  publicBaseUrl?: string;
  github: Readonly<{
    restApiVersion?: string;
    appId?: string;
    appSlug?: string;
    oauthClientId?: string;
  }>;
  secrets: Readonly<{
    githubPrivateKey?: string;
    githubWebhookSecret?: string;
    githubOAuthClientSecret?: string;
    encryptionMasterKey?: string;
  }>;
}>;

export type SafeControlPlaneConfigSummary = Readonly<{
  environment: ControlPlaneConfig["environment"];
  mode: ControlPlaneMode;
  http: ControlPlaneConfig["http"];
  build: Readonly<{
    revisionConfigured: boolean;
    createdAtConfigured: boolean;
  }>;
  publicBaseUrlConfigured: boolean;
  persistence: Readonly<{
    enabled: boolean;
  }>;
  database: Readonly<{
    urlConfigured: boolean;
    sslMode: ControlPlaneConfig["database"]["sslMode"];
    poolMax: number;
  }>;
  outbox: Readonly<{
    workerEnabled: boolean;
    batchSize: number;
    leaseSeconds: number;
    pollIntervalMs: number;
    shutdownTimeoutMs: number;
    maxAttempts: number;
  }>;
  retention: Readonly<{
    completedOutboxConfigured: boolean;
    deadLetterConfigured: boolean;
    externalContentConfigured: boolean;
  }>;
  github: Readonly<{
    restApiVersionConfigured: boolean;
    appIdConfigured: boolean;
    appSlugConfigured: boolean;
    oauthClientIdConfigured: boolean;
    privateKeyConfigured: boolean;
    webhookSecretConfigured: boolean;
    oauthClientSecretConfigured: boolean;
    encryptionMasterKeyConfigured: boolean;
  }>;
}>;

export class ControlPlaneConfigError extends Error {
  public readonly issues: readonly string[];
  public readonly validationIssues: readonly ValidationIssue[];
  public readonly safeError: SafeError;

  public constructor(validationIssues: readonly ValidationIssue[]) {
    const issues = validationIssues.map(formatValidationIssue);
    super(`Invalid control-plane configuration: ${issues.join("; ")}`);
    this.name = "ControlPlaneConfigError";
    this.issues = issues;
    this.validationIssues = validationIssues;
    this.safeError = createSafeError({
      category: "validation",
      code: "CONTROL_PLANE_CONFIG_INVALID",
      message: "Invalid control-plane configuration.",
      safeDetails: { issueCount: validationIssues.length },
    });
  }
}

const optionalBoolean = z
  .enum(["0", "1", "false", "true"])
  .transform((value) => value === "1" || value === "true")
  .optional();

const optionalPositiveInteger = z.coerce.number().int().positive().optional();

const rawConfigSchema = z.object({
  CONTROL_PLANE_BUILD_CREATED_AT: z.string().datetime().optional(),
  CONTROL_PLANE_BUILD_REVISION: z.string().min(1).max(128).optional(),
  CONTROL_PLANE_COMPLETED_OUTBOX_RETENTION_DAYS: optionalPositiveInteger,
  CONTROL_PLANE_DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(5),
  CONTROL_PLANE_DATABASE_SSL_MODE: z
    .enum(["disable", "prefer", "require"])
    .default("disable"),
  CONTROL_PLANE_DATABASE_URL: z.string().url().optional(),
  CONTROL_PLANE_DEAD_LETTER_RETENTION_DAYS: optionalPositiveInteger,
  CONTROL_PLANE_ENCRYPTION_MASTER_KEY: z.string().min(1).optional(),
  CONTROL_PLANE_EXTERNAL_CONTENT_RETENTION_DAYS: optionalPositiveInteger,
  CONTROL_PLANE_GITHUB_APP_ID: z.string().min(1).optional(),
  CONTROL_PLANE_GITHUB_APP_SLUG: z.string().min(1).optional(),
  CONTROL_PLANE_GITHUB_OAUTH_CLIENT_ID: z.string().min(1).optional(),
  CONTROL_PLANE_GITHUB_OAUTH_CLIENT_SECRET: z.string().min(1).optional(),
  CONTROL_PLANE_GITHUB_PRIVATE_KEY: z.string().min(1).optional(),
  CONTROL_PLANE_GITHUB_REST_API_VERSION: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  CONTROL_PLANE_GITHUB_WEBHOOK_SECRET: z.string().min(1).optional(),
  CONTROL_PLANE_HTTP_HOST: z.string().min(1).default("127.0.0.1"),
  CONTROL_PLANE_HTTP_PORT: z.coerce.number().int().min(1).max(65535).default(3030),
  CONTROL_PLANE_MODE: z.enum(CONTROL_PLANE_MODES).default("local-disabled"),
  CONTROL_PLANE_OUTBOX_BATCH_SIZE: z.coerce.number().int().min(1).max(100).default(10),
  CONTROL_PLANE_OUTBOX_LEASE_SECONDS: z.coerce.number().int().min(1).default(300),
  CONTROL_PLANE_OUTBOX_MAX_ATTEMPTS: z.coerce.number().int().min(1).default(10),
  CONTROL_PLANE_OUTBOX_POLL_INTERVAL_MS: z.coerce.number().int().min(50).default(1000),
  CONTROL_PLANE_OUTBOX_WORKER_ENABLED: optionalBoolean,
  CONTROL_PLANE_PERSISTENCE_ENABLED: optionalBoolean,
  CONTROL_PLANE_PUBLIC_BASE_URL: z.string().url().optional(),
  CONTROL_PLANE_WORKER_SHUTDOWN_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(100)
    .max(300_000)
    .default(30_000),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
});

type RawConfig = z.infer<typeof rawConfigSchema>;
type RawConfigKey = keyof RawConfig;

const hostedRequiredKeys = [
  "CONTROL_PLANE_PUBLIC_BASE_URL",
  "CONTROL_PLANE_GITHUB_APP_ID",
  "CONTROL_PLANE_GITHUB_APP_SLUG",
  "CONTROL_PLANE_GITHUB_REST_API_VERSION",
  "CONTROL_PLANE_GITHUB_PRIVATE_KEY",
  "CONTROL_PLANE_GITHUB_WEBHOOK_SECRET",
  "CONTROL_PLANE_GITHUB_OAUTH_CLIENT_ID",
  "CONTROL_PLANE_GITHUB_OAUTH_CLIENT_SECRET",
] as const satisfies readonly RawConfigKey[];

const persistenceRequiredKeys = [
  "CONTROL_PLANE_DATABASE_URL",
  "CONTROL_PLANE_ENCRYPTION_MASTER_KEY",
] as const satisfies readonly RawConfigKey[];

export function loadControlPlaneConfig(
  env: NodeJS.ProcessEnv = process.env,
): ControlPlaneConfig {
  const parsed = rawConfigSchema.safeParse(env);
  if (!parsed.success) {
    throw new ControlPlaneConfigError(parsed.error.issues.map(toValidationIssue));
  }

  const raw = parsed.data;
  const persistenceEnabled = isPersistenceEnabled(raw);
  const outboxWorkerEnabled = isOutboxWorkerEnabled(raw, persistenceEnabled);
  const missingKeys = getMissingRequiredKeys(raw, persistenceEnabled);
  if (missingKeys.length > 0) {
    throw new ControlPlaneConfigError(
      missingKeys.map((key) => ({
        code: "required",
        message: `${key} is required when CONTROL_PLANE_MODE=${raw.CONTROL_PLANE_MODE}`,
        path: [key],
      })),
    );
  }
  const validationIssues = validateCrossFieldConfig(raw, {
    outboxWorkerEnabled,
    persistenceEnabled,
  });
  if (validationIssues.length > 0) {
    throw new ControlPlaneConfigError(validationIssues);
  }

  const build = buildBuildInfo(raw);
  const github = buildGitHubConfig(raw);
  const secrets = buildSecretConfig(raw);
  const database = buildDatabaseConfig(raw);
  const outbox = buildOutboxConfig(raw, outboxWorkerEnabled);
  const retention = buildRetentionConfig(raw);

  const configBase = {
    build,
    database,
    environment: raw.NODE_ENV,
    github,
    http: {
      host: raw.CONTROL_PLANE_HTTP_HOST,
      port: raw.CONTROL_PLANE_HTTP_PORT,
    },
    mode: raw.CONTROL_PLANE_MODE,
    outbox,
    persistence: {
      enabled: persistenceEnabled,
    },
    retention,
    secrets,
  };

  if (raw.CONTROL_PLANE_PUBLIC_BASE_URL === undefined) {
    return configBase;
  }

  return {
    ...configBase,
    publicBaseUrl: raw.CONTROL_PLANE_PUBLIC_BASE_URL,
  };
}

export function getSafeConfigSummary(
  config: ControlPlaneConfig,
): SafeControlPlaneConfigSummary {
  return {
    build: {
      createdAtConfigured: config.build.createdAt !== undefined,
      revisionConfigured: config.build.revision !== undefined,
    },
    database: {
      poolMax: config.database.poolMax,
      sslMode: config.database.sslMode,
      urlConfigured: config.database.url !== undefined,
    },
    environment: config.environment,
    github: {
      appIdConfigured: config.github.appId !== undefined,
      appSlugConfigured: config.github.appSlug !== undefined,
      oauthClientIdConfigured: config.github.oauthClientId !== undefined,
      oauthClientSecretConfigured: config.secrets.githubOAuthClientSecret !== undefined,
      privateKeyConfigured: config.secrets.githubPrivateKey !== undefined,
      restApiVersionConfigured: config.github.restApiVersion !== undefined,
      webhookSecretConfigured: config.secrets.githubWebhookSecret !== undefined,
      encryptionMasterKeyConfigured: config.secrets.encryptionMasterKey !== undefined,
    },
    http: config.http,
    mode: config.mode,
    outbox: config.outbox,
    persistence: config.persistence,
    publicBaseUrlConfigured: config.publicBaseUrl !== undefined,
    retention: {
      completedOutboxConfigured: config.retention.completedOutboxDays !== undefined,
      deadLetterConfigured: config.retention.deadLetterDays !== undefined,
      externalContentConfigured: config.retention.externalContentDays !== undefined,
    },
  };
}

function toValidationIssue(issue: z.core.$ZodIssue): ValidationIssue {
  return {
    code: issue.code,
    message: issue.message,
    path: issue.path.map(String),
  };
}

function formatValidationIssue(issue: ValidationIssue): string {
  const path = issue.path.join(".");
  if (path.length === 0 || issue.message.startsWith(path)) {
    return issue.message;
  }
  return `${path}: ${issue.message}`;
}

function getMissingRequiredKeys(
  raw: RawConfig,
  persistenceEnabled: boolean,
): readonly RawConfigKey[] {
  const keys = [
    ...(raw.CONTROL_PLANE_MODE === "local-disabled" ? [] : hostedRequiredKeys),
    ...(persistenceEnabled ? persistenceRequiredKeys : []),
  ];
  return keys.filter((key) => !hasValue(raw[key]));
}

function hasValue(value: unknown): boolean {
  return typeof value === "string" ? value.trim().length > 0 : value !== undefined;
}

function buildBuildInfo(raw: RawConfig): ControlPlaneBuildInfo {
  const build: {
    revision?: string;
    createdAt?: string;
  } = {};

  if (raw.CONTROL_PLANE_BUILD_REVISION !== undefined) {
    build.revision = raw.CONTROL_PLANE_BUILD_REVISION;
  }
  if (raw.CONTROL_PLANE_BUILD_CREATED_AT !== undefined) {
    build.createdAt = raw.CONTROL_PLANE_BUILD_CREATED_AT;
  }

  return build;
}

function isPersistenceEnabled(raw: RawConfig): boolean {
  return (
    raw.CONTROL_PLANE_PERSISTENCE_ENABLED ?? raw.CONTROL_PLANE_MODE !== "local-disabled"
  );
}

function isOutboxWorkerEnabled(raw: RawConfig, persistenceEnabled: boolean): boolean {
  return raw.CONTROL_PLANE_OUTBOX_WORKER_ENABLED ?? persistenceEnabled;
}

function validateCrossFieldConfig(
  raw: RawConfig,
  flags: { persistenceEnabled: boolean; outboxWorkerEnabled: boolean },
): readonly ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  if (flags.outboxWorkerEnabled && !flags.persistenceEnabled) {
    issues.push({
      code: "invalid",
      message:
        "CONTROL_PLANE_OUTBOX_WORKER_ENABLED requires CONTROL_PLANE_PERSISTENCE_ENABLED.",
      path: ["CONTROL_PLANE_OUTBOX_WORKER_ENABLED"],
    });
  }

  if (flags.persistenceEnabled && raw.CONTROL_PLANE_ENCRYPTION_MASTER_KEY !== undefined) {
    const decoded = decodeBase64(raw.CONTROL_PLANE_ENCRYPTION_MASTER_KEY);
    if (decoded === undefined || decoded.byteLength !== 32) {
      issues.push({
        code: "invalid",
        message:
          "CONTROL_PLANE_ENCRYPTION_MASTER_KEY must be base64-encoded 32 bytes when persistence is enabled.",
        path: ["CONTROL_PLANE_ENCRYPTION_MASTER_KEY"],
      });
    }
  }

  return issues;
}

function decodeBase64(value: string): Buffer | undefined {
  try {
    const normalized = value.trim();
    if (normalized.length === 0) {
      return undefined;
    }
    return Buffer.from(normalized, "base64");
  } catch {
    return undefined;
  }
}

function buildDatabaseConfig(raw: RawConfig): ControlPlaneConfig["database"] {
  const database: {
    url?: string;
    sslMode: "disable" | "prefer" | "require";
    poolMax: number;
  } = {
    poolMax: raw.CONTROL_PLANE_DATABASE_POOL_MAX,
    sslMode: raw.CONTROL_PLANE_DATABASE_SSL_MODE,
  };

  if (raw.CONTROL_PLANE_DATABASE_URL !== undefined) {
    database.url = raw.CONTROL_PLANE_DATABASE_URL;
  }

  return database;
}

function buildOutboxConfig(
  raw: RawConfig,
  workerEnabled: boolean,
): ControlPlaneConfig["outbox"] {
  return {
    batchSize: raw.CONTROL_PLANE_OUTBOX_BATCH_SIZE,
    leaseSeconds: raw.CONTROL_PLANE_OUTBOX_LEASE_SECONDS,
    maxAttempts: raw.CONTROL_PLANE_OUTBOX_MAX_ATTEMPTS,
    pollIntervalMs: raw.CONTROL_PLANE_OUTBOX_POLL_INTERVAL_MS,
    shutdownTimeoutMs: raw.CONTROL_PLANE_WORKER_SHUTDOWN_TIMEOUT_MS,
    workerEnabled,
  };
}

function buildRetentionConfig(raw: RawConfig): ControlPlaneConfig["retention"] {
  const retention: {
    completedOutboxDays?: number;
    deadLetterDays?: number;
    externalContentDays?: number;
  } = {};

  if (raw.CONTROL_PLANE_COMPLETED_OUTBOX_RETENTION_DAYS !== undefined) {
    retention.completedOutboxDays = raw.CONTROL_PLANE_COMPLETED_OUTBOX_RETENTION_DAYS;
  }
  if (raw.CONTROL_PLANE_DEAD_LETTER_RETENTION_DAYS !== undefined) {
    retention.deadLetterDays = raw.CONTROL_PLANE_DEAD_LETTER_RETENTION_DAYS;
  }
  if (raw.CONTROL_PLANE_EXTERNAL_CONTENT_RETENTION_DAYS !== undefined) {
    retention.externalContentDays = raw.CONTROL_PLANE_EXTERNAL_CONTENT_RETENTION_DAYS;
  }

  return retention;
}

function buildGitHubConfig(raw: RawConfig): ControlPlaneConfig["github"] {
  const github: {
    restApiVersion?: string;
    appId?: string;
    appSlug?: string;
    oauthClientId?: string;
  } = {};

  if (raw.CONTROL_PLANE_GITHUB_REST_API_VERSION !== undefined) {
    github.restApiVersion = raw.CONTROL_PLANE_GITHUB_REST_API_VERSION;
  }
  if (raw.CONTROL_PLANE_GITHUB_APP_ID !== undefined) {
    github.appId = raw.CONTROL_PLANE_GITHUB_APP_ID;
  }
  if (raw.CONTROL_PLANE_GITHUB_APP_SLUG !== undefined) {
    github.appSlug = raw.CONTROL_PLANE_GITHUB_APP_SLUG;
  }
  if (raw.CONTROL_PLANE_GITHUB_OAUTH_CLIENT_ID !== undefined) {
    github.oauthClientId = raw.CONTROL_PLANE_GITHUB_OAUTH_CLIENT_ID;
  }

  return github;
}

function buildSecretConfig(raw: RawConfig): ControlPlaneConfig["secrets"] {
  const secrets: {
    githubPrivateKey?: string;
    githubWebhookSecret?: string;
    githubOAuthClientSecret?: string;
    encryptionMasterKey?: string;
  } = {};

  if (raw.CONTROL_PLANE_GITHUB_PRIVATE_KEY !== undefined) {
    secrets.githubPrivateKey = raw.CONTROL_PLANE_GITHUB_PRIVATE_KEY;
  }
  if (raw.CONTROL_PLANE_GITHUB_WEBHOOK_SECRET !== undefined) {
    secrets.githubWebhookSecret = raw.CONTROL_PLANE_GITHUB_WEBHOOK_SECRET;
  }
  if (raw.CONTROL_PLANE_GITHUB_OAUTH_CLIENT_SECRET !== undefined) {
    secrets.githubOAuthClientSecret = raw.CONTROL_PLANE_GITHUB_OAUTH_CLIENT_SECRET;
  }
  if (raw.CONTROL_PLANE_ENCRYPTION_MASTER_KEY !== undefined) {
    secrets.encryptionMasterKey = raw.CONTROL_PLANE_ENCRYPTION_MASTER_KEY;
  }

  return secrets;
}
