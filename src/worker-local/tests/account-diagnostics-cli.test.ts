import { describe, expect, it } from "vitest";
import {
  runAccountDiagnosticsCli,
  type AccountDiagnosticsCliIo,
  type AccountDiagnosticsProviderFactory,
} from "../account-diagnostics-cli";

describe("subscription runtime account diagnostics CLI", () => {
  it("emits JSON status without probing by default", async () => {
    let probeCalls = 0;
    const stdout: string[] = [];
    const exitCode = await runAccountDiagnosticsCli(
      ["--provider", "codex", "--json"],
      fakeIo(stdout),
      {
        providerFactory: fakeFactory({
          probeCalls: () => {
            probeCalls += 1;
          },
        }),
      },
    );

    expect(exitCode).toBe(0);
    expect(probeCalls).toBe(0);
    expect(JSON.parse(stdout.join(""))).toMatchObject({
      protocolVersion: 1,
      provider: "codex",
      probeMode: "cached",
      diagnostics: [
        {
          provider: "codex",
          slotId: "account-a",
          availability: "available",
          safeIdentity: "codex:a",
        },
      ],
    });
  });

  it("filters JSON output by availability", async () => {
    const stdout: string[] = [];
    const exitCode = await runAccountDiagnosticsCli(
      ["--provider", "codex", "--json", "--only", "reconnect_required"],
      fakeIo(stdout),
      {
        providerFactory: fakeFactory({ reconnectSecondAccount: true }),
      },
    );

    expect(exitCode).toBe(1);
    expect(JSON.parse(stdout.join(""))).toMatchObject({
      diagnostics: [
        {
          slotId: "account-b",
          availability: "reconnect_required",
          recommendedAction: "relogin",
          schedulerEligible: false,
        },
      ],
    });
  });

  it("passes probe mode and timeout to the provider probe", async () => {
    let observedTimeoutMs: number | undefined;
    const stdout: string[] = [];
    const exitCode = await runAccountDiagnosticsCli(
      ["--provider", "codex", "--json", "--probe", "--timeout-ms", "1234"],
      fakeIo(stdout),
      {
        providerFactory: fakeFactory({
          probeCalls: (input) => {
            observedTimeoutMs = input.timeoutMs;
          },
        }),
      },
    );

    expect(exitCode).toBe(0);
    expect(observedTimeoutMs).toBe(1234);
    expect(JSON.parse(stdout.join(""))).toMatchObject({
      probeMode: "live_probe",
      diagnostics: [
        {
          availability: "available",
          source: "live_probe",
        },
      ],
    });
  });
});

function fakeIo(stdout: string[]): AccountDiagnosticsCliIo {
  return {
    writeStdout(chunk) {
      stdout.push(chunk);
    },
    writeStderr() {},
    cwd() {
      return "/tmp";
    },
    env() {
      return {};
    },
  };
}

function fakeFactory(input: {
  readonly reconnectSecondAccount?: boolean;
  readonly probeCalls?: (input: { readonly timeoutMs?: number }) => void;
}): AccountDiagnosticsProviderFactory {
  return async ({ provider }) => ({
    registry: {
      async listAccounts() {
        return input.reconnectSecondAccount
          ? [
              { provider, slotId: "account-a" },
              { provider, slotId: "account-b" },
            ]
          : [{ provider, slotId: "account-a" }];
      },
    },
    identityReader: {
      async readIdentity({ account }) {
        if (account.slotId === "account-b") {
          return {
            identity: { safeIdentity: `${provider}:b` },
            signal: {
              availability: "reconnect_required" as const,
              source: "cached" as const,
              reason: "provider_session_invalid",
              reconnectRequired: true,
            },
          };
        }
        return {
          identity: { safeIdentity: `${provider}:a` },
        };
      },
    },
    healthProbe: {
      async probeAccount(probeInput) {
        input.probeCalls?.({
          ...(probeInput.timeoutMs ? { timeoutMs: probeInput.timeoutMs } : {}),
        });
        return {
          availability: "available" as const,
          source: "live_probe" as const,
        };
      },
    },
  });
}
