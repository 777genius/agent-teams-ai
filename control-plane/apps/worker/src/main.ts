import "reflect-metadata";

import { NestFactory } from "@nestjs/core";

import { WorkerRunner, type WorkerRunMode } from "./worker-runner.js";
import { WorkerModule } from "./worker.module.js";

const workerMode: WorkerRunMode =
  process.env.CONTROL_PLANE_WORKER_SMOKE === "1" ? "smoke" : "serve";

const app = await NestFactory.createApplicationContext(WorkerModule, {
  bufferLogs: true,
});

app.enableShutdownHooks();

const runner = app.get(WorkerRunner);

if (workerMode === "smoke") {
  await runner.run(workerMode);
  await app.close();
} else {
  const workerRun = runner.run(workerMode);
  await waitForShutdownSignal();
  const result = await runner.stop(workerRun);
  if (result === undefined) {
    process.exitCode = 1;
  }
  await app.close();
}

async function waitForShutdownSignal(): Promise<void> {
  await new Promise<void>((resolve) => {
    const resolveOnce = (): void => {
      process.off("SIGINT", resolveOnce);
      process.off("SIGTERM", resolveOnce);
      resolve();
    };

    process.once("SIGINT", resolveOnce);
    process.once("SIGTERM", resolveOnce);
  });
}
