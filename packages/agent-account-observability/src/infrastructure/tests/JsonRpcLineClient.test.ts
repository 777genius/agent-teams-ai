import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { JsonRpcLineClient } from "../JsonRpcLineClient";

describe("JsonRpcLineClient", () => {
  it("terminates its child when initialize times out", async () => {
    const root = await mkdtemp(join(tmpdir(), "json-rpc-timeout-"));
    const executable = join(root, "hung-app-server.sh");
    const pidPath = join(root, "child.pid");
    try {
      await writeFile(
        executable,
        `#!/bin/sh
echo $$ > "$PID_FILE"
trap 'exit 0' TERM INT
while IFS= read -r _line; do
  sleep 1
done
`,
      );
      await chmod(executable, 0o700);
      const client = new JsonRpcLineClient({
        command: executable,
        args: [],
        cwd: root,
        env: { PID_FILE: pidPath, PATH: process.env.PATH ?? "/usr/bin:/bin" },
        startupTimeoutMs: 1_000,
      });

      const started = client.start().then(
        () => ({ error: null }),
        (error: unknown) => ({ error }),
      );
      const pid = await waitForPidFile(pidPath);
      const startResult = await started;
      expect(startResult.error).toBeInstanceOf(Error);
      expect((startResult.error as Error).message).toBe(
        "json_rpc_request_timeout:initialize",
      );
      expect(Number.isInteger(pid)).toBe(true);
      await expectProcessToExit(pid);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a request safely when the child stdin reports EPIPE", async () => {
    const child = createFakeChildWithSecondWriteFailure();
    const client = new JsonRpcLineClient({
      command: "fake-app-server",
      args: [],
      cwd: "/tmp",
      env: {},
      spawnProcess: (() => child) as typeof import("node:child_process").spawn,
    });

    await client.start();
    await expect(client.call({ method: "account/read" })).rejects.toMatchObject({
      code: "EPIPE",
    });
    await client.close();
  });
});

function createFakeChildWithSecondWriteFailure(): ChildProcessWithoutNullStreams {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let writeCount = 0;
  const stdin = new Writable({
    write(_chunk, _encoding, callback) {
      writeCount += 1;
      if (writeCount === 1) {
        callback();
        queueMicrotask(() => stdout.write('{"id":1,"result":{}}\n'));
        return;
      }
      const error = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
      callback(error);
    },
  });
  const child = Object.assign(new EventEmitter(), {
    stdin,
    stdout,
    stderr,
    exitCode: null as number | null,
    signalCode: null,
    killed: false,
    kill(signal: NodeJS.Signals = "SIGTERM") {
      this.killed = true;
      this.exitCode = 0;
      queueMicrotask(() => this.emit("exit", 0, signal));
      return true;
    },
  });
  return child as unknown as ChildProcessWithoutNullStreams;
}

async function waitForPidFile(path: string): Promise<number> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      return Number((await readFile(path, "utf8")).trim());
    } catch {
      await delay(25);
    }
  }
  throw new Error("json_rpc_test_child_pid_missing");
}

async function expectProcessToExit(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (!isProcessAlive(pid)) return;
    await delay(25);
  }
  expect(isProcessAlive(pid)).toBe(false);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
