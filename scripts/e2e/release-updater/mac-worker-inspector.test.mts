import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

import { Cdp, waitFor } from "./cdp.mts";
import { attachMacWorkerInspector } from "./mac-worker-inspector.mts";

// Actual Node worker execution distinguishes inherited entry-break suspension
// from a slow API, while retaining the original inspector for source/root reads.
async function observeWorker(release: boolean) {
  const root = await realpath(
    await mkdtemp(path.join(tmpdir(), "TEST-mac-worker-inspector-")),
  );
  const main = path.join(root, "entry.cjs");
  const workerPath = path.join(
    root,
    "app.asar",
    "dist-electron",
    "main",
    "team-data-worker.cjs",
  );
  await mkdir(path.dirname(workerPath), { recursive: true });
  await writeFile(
    workerPath,
    'require("node:worker_threads").parentPort.postMessage({value:42,execArgv:process.execArgv})',
  );
  await writeFile(
    main,
    'globalThis.__TEST_inspectorUrl=require("node:inspector").url();const {Worker}=require("node:worker_threads");globalThis.__TEST_worker={online:false,message:null};const worker=new Worker(require("node:path").join(__dirname,"app.asar/dist-electron/main/team-data-worker.cjs"));worker.on("online",()=>globalThis.__TEST_worker.online=true);worker.on("message",value=>globalThis.__TEST_worker.message=value);setInterval(()=>{},1000);',
  );
  const child = spawn(
    process.execPath,
    ["--no-warnings", "--inspect-brk=127.0.0.1:0", main],
    {
      cwd: root,
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  let stderr = "";
  child.stderr.on("data", (value: Buffer) => {
    stderr += value.toString();
  });
  let client: Cdp | undefined;
  let control: Awaited<ReturnType<typeof attachMacWorkerInspector>> | undefined;
  const records: unknown[] = [];
  try {
    const url = await waitFor(
      () =>
        Promise.resolve(
          /Debugger listening on (ws:\/\/127\.0\.0\.1:\S+)/u.exec(
            stderr,
          )?.[1] ?? null,
        ),
      "owned TEST inspector",
      5000,
    );
    client = await Cdp.connect(url);
    await client.send("Debugger.enable");
    await client.send("Runtime.runIfWaitingForDebugger");
    const paused = (await waitFor(
      () =>
        Promise.resolve(
          client?.events.find((event) => event.method === "Debugger.paused")
            ?.params ?? null,
        ),
      "owned TEST entry pause",
      5000,
    )) as { callFrames: { callFrameId: string }[] };
    const frame = paused.callFrames[0];
    assert(frame);
    assert.equal(await client.evaluate("__filename", frame.callFrameId), main);
    if (release)
      control = await attachMacWorkerInspector(
        client,
        path.join(root, "app.asar"),
        async (receipts) => {
          records.push(structuredClone(receipts));
        },
      );
    await client.send("Debugger.resume");
    const active = client;
    if (release) {
      const result = await control!.guard(
        waitFor(
          () =>
            active.evaluate<{ value: number; execArgv: string[] } | null>(
              "globalThis.__TEST_worker?.message ?? null",
            ),
          "worker executes with original inherited arguments",
          5000,
        ),
      );
      assert.equal(result.value, 42);
      assert.deepEqual(result.execArgv, [
        "--no-warnings",
        "--inspect-brk=127.0.0.1:0",
      ]);
      await waitFor(
        () =>
          Promise.resolve(
            records.some(
              (value) => Array.isArray(value) && value[0]?.released === true,
            )
              ? true
              : null,
          ),
        "release acknowledgement persisted",
        5000,
      );
      assert.equal(
        await active.evaluate("globalThis.__TEST_inspectorUrl"),
        url,
      );
    } else {
      await assert.rejects(
        waitFor(
          () => active.evaluate("globalThis.__TEST_worker?.message ?? null"),
          "inherited worker entry remains paused",
          500,
        ),
        /inherited worker entry remains paused/u,
      );
    }
  } catch (error) {
    console.error(
      JSON.stringify(
        client?.events.filter(
          (event) =>
            event.method === "Debugger.paused" ||
            event.method?.startsWith("NodeWorker."),
        ),
      ),
    );
    throw error;
  } finally {
    try {
      await control?.stop();
    } finally {
      client?.close();
      if (child.pid && child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await waitFor(
          () =>
            Promise.resolve(
              child.exitCode !== null || child.signalCode !== null
                ? true
                : null,
            ),
          "owned TEST child exit",
          5000,
        );
      }
      await rm(root, { recursive: true, force: true });
    }
  }
}

void test("default worker inherits entry break and never executes while main inspector stays attached", async () => {
  await observeWorker(false);
});
void test("releasing attached owned worker through Runtime permits execution and keeps main debugger and original flags", async () => {
  await observeWorker(true);
});

const asar = "/TEST-owned/Agent Teams AI.app/Contents/Resources/app.asar";
const attachment = {
  sessionId: "owned-session",
  workerInfo: {
    workerId: "1",
    type: "worker",
    url: pathToFileURL(
      path.join(asar, "dist-electron", "main", "team-data-worker.cjs"),
    ).href,
  },
  waitingForDebugger: false,
};
function protocolPeer(error = false, omitReply = false) {
  let listener: Parameters<Cdp["onEvent"]>[0] | undefined;
  const commands: string[] = [];
  const client: Pick<Cdp, "send" | "onEvent"> = {
    onEvent(value) {
      listener = value;
      return () => {
        listener = undefined;
      };
    },
    async send<T>(method: string, params: Record<string, unknown> = {}) {
      commands.push(method);
      if (method === "NodeWorker.sendMessageToWorker") {
        assert.equal(params.sessionId, attachment.sessionId);
        assert.deepEqual(JSON.parse(String(params.message)), {
          id: 1,
          method: "Runtime.runIfWaitingForDebugger",
        });
        if (!omitReply)
          listener?.({
            method: "NodeWorker.receivedMessageFromWorker",
            params: {
              sessionId: params.sessionId,
              message: JSON.stringify(
                error
                  ? { id: 1, error: { message: "original worker refused" } }
                  : { id: 1, result: {} },
              ),
            },
          });
      }
      return {} as T;
    },
  };
  return {
    client,
    commands,
    emit: (method: string, params: unknown) => listener?.({ method, params }),
    subscribed: () => Boolean(listener),
  };
}
for (const [name, url] of [
  [
    "foreign app",
    "file:///OTHER/App.app/Contents/Resources/app.asar/dist-electron/main/team-data-worker.cjs",
  ],
  [
    "unknown original module",
    pathToFileURL(path.join(asar, "dist-electron/main/unknown.cjs")).href,
  ],
  ["network source", "https://example.invalid/team-data-worker.cjs"],
] as const) {
  void test(`foreign or unknown worker identity fails without any release: ${name}`, async () => {
    const peer = protocolPeer();
    const control = await attachMacWorkerInspector(
      peer.client,
      asar,
      async () => undefined,
    );
    peer.emit("NodeWorker.attachedToWorker", {
      ...attachment,
      workerInfo: { ...attachment.workerInfo, url },
    });
    await assert.rejects(control.guard(new Promise<never>(() => undefined)));
    assert(!peer.commands.includes("NodeWorker.sendMessageToWorker"));
    await assert.rejects(control.stop());
    assert.equal(peer.subscribed(), false);
  });
}
void test("worker protocol refusal is fatal and removes the subscription during cleanup", async () => {
  const peer = protocolPeer(true);
  const control = await attachMacWorkerInspector(
    peer.client,
    asar,
    async () => undefined,
  );
  peer.emit("NodeWorker.attachedToWorker", attachment);
  await assert.rejects(
    control.guard(new Promise<never>(() => undefined)),
    /release failed/u,
  );
  await assert.rejects(control.stop(), /release failed/u);
  assert.equal(peer.subscribed(), false);
});
void test("stopping an unacknowledged release drains pending work and cannot report success", async () => {
  const peer = protocolPeer(false, true);
  const control = await attachMacWorkerInspector(
    peer.client,
    asar,
    async () => undefined,
  );
  peer.emit("NodeWorker.attachedToWorker", attachment);
  await waitFor(
    () =>
      Promise.resolve(
        peer.commands.includes("NodeWorker.sendMessageToWorker") ? true : null,
      ),
    "owned request submitted",
    1000,
  );
  await assert.rejects(control.stop(), /pending release/u);
  assert.equal(peer.subscribed(), false);
});
void test("durable receipt failure prevents the worker release and fails the proof", async () => {
  const peer = protocolPeer();
  const control = await attachMacWorkerInspector(
    peer.client,
    asar,
    async () => {
      throw new Error("owned receipt failed");
    },
  );
  peer.emit("NodeWorker.attachedToWorker", attachment);
  await assert.rejects(
    control.guard(new Promise<never>(() => undefined)),
    /owned receipt failed/u,
  );
  assert(!peer.commands.includes("NodeWorker.sendMessageToWorker"));
  await assert.rejects(control.stop(), /owned receipt failed/u);
});
