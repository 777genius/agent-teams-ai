import { describe, expect, it } from "vitest";
import {
  parseWorkerLaunchRequest,
  parseWorkerLaunchSpec,
} from "../index";

describe("worker launch spec", () => {
  it("accepts the stable kind and format without a versioned type name", () => {
    expect(parseWorkerLaunchRequest(workerLaunchRequest())).toMatchObject({
      kind: "worker-launch",
      format: 1,
      phaseId: "phase-01",
      laneId: "team-lifecycle-read",
    });
    expect(parseWorkerLaunchSpec(workerLaunchSpec())).toMatchObject({
      kind: "worker-launch",
      format: 1,
      registryStatus: "queued",
    });
  });

  it("rejects version-family aliases and future formats fail closed", () => {
    expect(() =>
      parseWorkerLaunchRequest({
        ...workerLaunchRequest(),
        schemaVersion: 1,
      }),
    ).toThrow("unexpected_field_schemaVersion");
    expect(() =>
      parseWorkerLaunchRequest({
        ...workerLaunchRequest(),
        format: 2,
      }),
    ).toThrow("format:contract_format_unsupported");
  });

  it("reports all structural problems instead of one field per retry", () => {
    expect(() =>
      parseWorkerLaunchRequest({
        kind: "worker-launch",
        format: 1,
        legacyContractSchema: "worker-start-v1",
      }),
    ).toThrow(
      /missing_field_canonicalSha.*missing_field_baseSha.*unexpected_field_legacyContractSchema/,
    );
  });

  it("rejects unsafe paths, duplicate ownership and ambiguous checks", () => {
    const request = workerLaunchRequest();
    expect(() =>
      parseWorkerLaunchRequest({
        ...request,
        ownedPaths: ["../outside", "../outside"],
        requiredChecks: [
          { id: "focused", cwd: "src", command: " npm test" },
          { id: "focused", cwd: "src", command: "npm test" },
        ],
        executionPolicy: {
          ...request.executionPolicy,
          mode: "host-access",
        },
      }),
    ).toThrow(
      /contract_relative_path_invalid.*contract_relative_path_invalid.*contract_requiredCheck_command_invalid.*mode/,
    );
  });

  it("requires both packet sources in mandatory docs", () => {
    const request = workerLaunchRequest();
    expect(() =>
      parseWorkerLaunchRequest({
        ...request,
        mandatoryDocs: [request.controllerPacket],
      }),
    ).toThrow("contract_mandatoryDocs_missing_packet");
  });
});

function workerLaunchRequest() {
  return {
    kind: "worker-launch" as const,
    format: 1 as const,
    canonicalSha: "a".repeat(40),
    baseSha: "b".repeat(40),
    phaseStartSha: "c".repeat(40),
    packetRevision: "p1-1d-r1",
    controllerPacket: "docs/hosted-web-phases/phase-01/controller.md",
    lanePacket: "docs/hosted-web-phases/phase-01/lanes/team-lifecycle-read.md",
    phaseId: "phase-01",
    laneId: "team-lifecycle-read",
    inputPatchHash: "d".repeat(64),
    reviewKind: "implementation" as const,
    ownedPaths: ["src/features/team-lifecycle/read.ts"],
    mandatoryDocs: [
      "docs/hosted-web-phases/phase-01/controller.md",
      "docs/hosted-web-phases/phase-01/lanes/team-lifecycle-read.md",
    ],
    mandatoryScripts: [],
    mandatoryFixtures: [],
    requiredChecks: [
      { id: "focused", cwd: "src", command: "cd .. && npm test" },
    ],
    executionPolicy: {
      mode: "sandbox-only" as const,
      sandboxRoot: "/tmp/subscription-runtime-worker-sandbox",
      forbiddenRealProjects: ["/Users/example/real-project"],
    },
  };
}

function workerLaunchSpec() {
  return {
    ...workerLaunchRequest(),
    jobId: "worker-job",
    workerId: "worker-job",
    revision: 0,
    retryCount: 0,
    workKey: "e".repeat(64),
    supersedes: null,
    registryStatus: "queued" as const,
    jobRoot: "/tmp/subscription-runtime-worker-job",
    workspaceRoot: "/tmp/subscription-runtime-worker-workspace",
    promptPath: "/tmp/subscription-runtime-worker-job/prompt.md",
  };
}
