#!/usr/bin/env node
/* global AbortController */

import { resolve } from "node:path";
import { clearTimeout, setTimeout } from "node:timers";
import { fileURLToPath } from "node:url";

const DEFAULT_TIMEOUT_MS = 10_000;
const NON_PRODUCTION_HOST_PATTERN = /(staging|stage|sandbox|dev|test|preview|beta)/i;
const SECRET_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/i,
  /\bgh[opsu]_[A-Za-z0-9_]{20,}\b/,
  /postgres(?:ql)?:\/\/[^"'\s]+:[^"'\s]+@/i,
  /\b(private-key|oauth-secret|webhook-secret|client-secret|encryption-master-key)\b/i,
];

export function validateHostedSmokeConfig(env = process.env) {
  const rawBaseUrl = env.CONTROL_PLANE_HOSTED_SMOKE_BASE_URL;
  if (!rawBaseUrl?.trim()) {
    throw new Error("CONTROL_PLANE_HOSTED_SMOKE_BASE_URL is required.");
  }

  const baseUrl = new URL(rawBaseUrl.trim());
  if (baseUrl.protocol !== "https:") {
    throw new Error("CONTROL_PLANE_HOSTED_SMOKE_BASE_URL must use https.");
  }
  if (baseUrl.username || baseUrl.password || baseUrl.hash) {
    throw new Error(
      "CONTROL_PLANE_HOSTED_SMOKE_BASE_URL must not include credentials or hash.",
    );
  }
  if (
    !NON_PRODUCTION_HOST_PATTERN.test(baseUrl.hostname) &&
    env.CONTROL_PLANE_HOSTED_SMOKE_ALLOW_PRODUCTION !== "1"
  ) {
    throw new Error(
      "Hosted smoke refuses production-looking hosts unless CONTROL_PLANE_HOSTED_SMOKE_ALLOW_PRODUCTION=1.",
    );
  }

  return {
    baseUrl,
    expectedMode: env.CONTROL_PLANE_HOSTED_SMOKE_EXPECTED_MODE?.trim() || undefined,
    expectedRevision:
      env.CONTROL_PLANE_HOSTED_SMOKE_EXPECTED_REVISION?.trim() || undefined,
    timeoutMs: parseTimeoutMs(env.CONTROL_PLANE_HOSTED_SMOKE_TIMEOUT_MS),
  };
}

export async function runHostedOperationsSmoke(input) {
  const fetchImpl = input.fetchImpl ?? fetch;
  const health = await getJson(fetchImpl, input.baseUrl, "/health", input.timeoutMs);
  const ready = await getJson(fetchImpl, input.baseUrl, "/ready", input.timeoutMs);

  assertNoSecretLeak(health, "health");
  assertNoSecretLeak(ready, "ready");
  assertHealthShape(health, "health");
  assertHealthShape(ready, "ready");

  if (ready.httpStatus !== 200 || ready.body?.readiness?.status !== "ready") {
    throw new Error("Hosted readiness endpoint is not ready.");
  }

  if (input.expectedMode && health.body.mode !== input.expectedMode) {
    throw new Error(
      `Hosted health mode mismatch. Expected ${input.expectedMode}, got ${health.body.mode}.`,
    );
  }
  if (
    input.expectedRevision &&
    health.body.service?.build?.revision !== input.expectedRevision
  ) {
    throw new Error("Hosted health build revision does not match expected revision.");
  }
  if (
    input.expectedRevision &&
    ready.body.service?.build?.revision !== input.expectedRevision
  ) {
    throw new Error("Hosted readiness build revision does not match expected revision.");
  }
  if (
    health.body.service?.build?.revision !== undefined &&
    ready.body.service?.build?.revision !== health.body.service.build.revision
  ) {
    throw new Error("Hosted health and readiness revisions differ.");
  }

  return {
    mode: health.body.mode,
    ready: ready.body.readiness.status,
    serviceName: health.body.service.name,
    serviceVersion: health.body.service.version,
    buildRevisionConfigured: health.body.service.build?.revision !== undefined,
  };
}

export function assertNoSecretLeak(value, label = "payload") {
  const text = JSON.stringify(value);
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.test(text)) {
      throw new Error(`${label} contains a secret-looking value.`);
    }
  }
}

function assertHealthShape(result, label) {
  const body = result.body;
  if (result.httpStatus < 200 || result.httpStatus >= 300) {
    throw new Error(`${label} returned HTTP ${result.httpStatus}.`);
  }
  if (body?.service?.name !== "agent-teams-control-plane") {
    throw new Error(`${label} service name is invalid.`);
  }
  if (typeof body.service.version !== "string") {
    throw new Error(`${label} service version is invalid.`);
  }
  if (typeof body.status !== "string" || typeof body.mode !== "string") {
    throw new Error(`${label} status or mode is invalid.`);
  }
  if (!body.readiness || typeof body.readiness.status !== "string") {
    throw new Error(`${label} readiness is invalid.`);
  }
}

async function getJson(fetchImpl, baseUrl, path, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const url = new URL(path, baseUrl);
    const response = await fetchImpl(url.href, {
      headers: { accept: "application/json" },
      redirect: "manual",
      signal: controller.signal,
    });
    if (response.status >= 300 && response.status < 400) {
      throw new Error(`${path} redirected unexpectedly.`);
    }
    const text = await response.text();
    return {
      body: text.trim() ? JSON.parse(text) : null,
      httpStatus: response.status,
    };
  } finally {
    clearTimeout(timer);
  }
}

function parseTimeoutMs(value) {
  if (!value) return DEFAULT_TIMEOUT_MS;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1_000 || parsed > 60_000) {
    throw new Error("CONTROL_PLANE_HOSTED_SMOKE_TIMEOUT_MS must be 1000..60000.");
  }
  return parsed;
}

async function main() {
  const config = validateHostedSmokeConfig();
  const result = await runHostedOperationsSmoke(config);
  console.log(
    JSON.stringify(
      {
        buildRevisionConfigured: result.buildRevisionConfigured,
        mode: result.mode,
        ready: result.ready,
        serviceName: result.serviceName,
        serviceVersion: result.serviceVersion,
      },
      null,
      2,
    ),
  );
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === currentFile) {
  await main();
}
