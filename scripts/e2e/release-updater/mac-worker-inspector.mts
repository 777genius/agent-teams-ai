import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { Cdp } from "./cdp.mts";

interface WorkerAttachment {
  sessionId: string;
  workerInfo: { workerId: string; type: string; url: string };
  waitingForDebugger: boolean;
}
interface WorkerReceipt extends WorkerAttachment {
  released: boolean;
}

// The inspector belongs to the already pinned TEST main process. Release only
// original packaged worker entry pauses, never alter modules or app API behavior.
export async function attachMacWorkerInspector(
  main: Pick<Cdp, "send" | "onEvent">,
  asar: string,
  persist: (receipts: readonly WorkerReceipt[]) => Promise<void>,
) {
  assert(path.isAbsolute(asar) && path.basename(asar) === "app.asar");
  const allowed = new Set([
    "team-data-worker.cjs",
    "team-fs-worker.cjs",
    "task-change-worker.cjs",
  ]);
  const receipts: WorkerReceipt[] = [];
  const sessions = new Set<string>();
  const pending = new Set<Promise<void>>();
  const replies = new Map<
    string,
    {
      resolve: () => void;
      reject: (error: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();
  let persistence = Promise.resolve();
  const record = () => {
    const snapshot = receipts.map((receipt) => ({ ...receipt }));
    persistence = persistence.then(() => persist(snapshot));
    return persistence;
  };
  let failure: Error | undefined;
  let rejectFailure!: (error: Error) => void;
  const failed = new Promise<never>((_, reject) => {
    rejectFailure = reject;
  });
  void failed.catch(() => undefined);
  const fail = (error: unknown) => {
    failure ??= error instanceof Error ? error : new Error(String(error));
    rejectFailure(failure);
  };
  async function release(raw: unknown) {
    const attachment = raw as WorkerAttachment;
    assert(
      attachment &&
        typeof attachment.sessionId === "string" &&
        attachment.sessionId.length > 0,
    );
    assert(
      !sessions.has(attachment.sessionId) && sessions.size < 16,
      "Duplicate or excessive owned worker session",
    );
    assert(attachment.workerInfo?.type === "worker");
    assert(/^\d+$/u.test(attachment.workerInfo.workerId));
    assert.equal(typeof attachment.waitingForDebugger, "boolean");
    const url = new URL(attachment.workerInfo.url);
    assert.equal(url.protocol, "file:");
    assert.equal(url.host, "");
    const worker = fileURLToPath(url);
    assert.equal(
      path.dirname(worker),
      path.join(asar, "dist-electron", "main"),
    );
    assert(
      allowed.has(path.basename(worker)),
      "Only original packaged workers may be released",
    );
    sessions.add(attachment.sessionId);
    const receipt = { ...attachment, released: false };
    receipts.push(receipt);
    await record();
    const reply = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        replies.delete(attachment.sessionId);
        reject(
          new Error("Owned worker inspector release acknowledgement timed out"),
        );
      }, 5000);
      replies.set(attachment.sessionId, { resolve, reject, timer });
    });
    void reply.catch(() => undefined);
    // Attach events can report waiting=false even when inherited inspect-brk
    // still waits. This standard command is idempotent when already running.
    await main.send("NodeWorker.sendMessageToWorker", {
      sessionId: attachment.sessionId,
      message: JSON.stringify({
        id: 1,
        method: "Runtime.runIfWaitingForDebugger",
      }),
    });
    await reply;
    receipt.released = true;
    await record();
  }
  const unsubscribe = main.onEvent((event) => {
    try {
      if (event.method === "NodeWorker.attachedToWorker") {
        const work = release(event.params);
        pending.add(work);
        void work.catch(fail).finally(() => pending.delete(work));
      } else if (event.method === "NodeWorker.receivedMessageFromWorker") {
        const value = event.params as { sessionId: string; message: string };
        const response = JSON.parse(value.message) as {
          id?: number;
          result?: unknown;
          error?: unknown;
        };
        if (response.id !== 1) return;
        const reply = replies.get(value.sessionId);
        assert(reply, "Unexpected owned worker release acknowledgement");
        replies.delete(value.sessionId);
        clearTimeout(reply.timer);
        if (response.error || response.result === undefined)
          reply.reject(new Error("Owned worker inspector release failed"));
        else reply.resolve();
      } else if (event.method === "NodeWorker.detachedFromWorker") {
        const value = event.params as { sessionId: string };
        const reply = replies.get(value.sessionId);
        if (reply) {
          replies.delete(value.sessionId);
          clearTimeout(reply.timer);
          reply.reject(
            new Error("Owned worker detached before release acknowledgement"),
          );
        }
      }
    } catch (error) {
      fail(error);
    }
  });
  try {
    await main.send("NodeWorker.enable", { waitForDebuggerOnStart: false });
  } catch (error) {
    unsubscribe();
    throw error;
  }
  return {
    guard: <T,>(operation: Promise<T>): Promise<T> =>
      Promise.race([operation, failed]),
    async stop() {
      unsubscribe();
      for (const reply of replies.values()) {
        clearTimeout(reply.timer);
        reply.reject(
          new Error("Owned worker inspector stopped with pending release"),
        );
      }
      replies.clear();
      await Promise.allSettled([...pending]);
      await main.send("NodeWorker.disable");
      if (failure) throw failure;
    },
  };
}
