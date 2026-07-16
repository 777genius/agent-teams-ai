import { describe, expect, it } from "vitest";
import {
  runCodexGoalCli,
  type CodexGoalCliIo,
} from "../codex-goal-cli";

describe("codex goal cli doctor", () => {
  it("doctors the SDK-backed control surface", async () => {
    const io = captureIo();

    const exitCode = await runCodexGoalCli(["doctor-control"], io);

    expect(exitCode).toBe(0);
    expect(JSON.parse(io.stdout)).toMatchObject({
      ok: true,
      mode: "sdk-in-process",
      missingTools: [],
    });
  });
});

function captureIo(): CodexGoalCliIo & {
  readonly stdout: string;
  readonly stderr: string;
} {
  let stdout = "";
  let stderr = "";
  return {
    writeStdout(chunk): void {
      stdout += chunk;
    },
    writeStderr(chunk): void {
      stderr += chunk;
    },
    cwd(): string {
      return "/tmp";
    },
    env(): Readonly<Record<string, string | undefined>> {
      return {};
    },
    get stdout(): string {
      return stdout;
    },
    get stderr(): string {
      return stderr;
    },
  };
}
