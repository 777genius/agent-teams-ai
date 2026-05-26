#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createServer } from "node:net";

const useDist = process.argv.includes("--dist");
const port = await getAvailablePort();
const env = {
  ...process.env,
  CONTROL_PLANE_HTTP_PORT: String(port),
  CONTROL_PLANE_MODE: "local-disabled",
};
const command = useDist ? process.execPath : "tsx";
const args = useDist
  ? ["--conditions=production", "apps/api/dist/main.js"]
  : ["apps/api/src/main.ts"];
const output = [];

const child = spawn(command, args, {
  env,
  stdio: ["ignore", "pipe", "pipe"],
});

child.stdout.on("data", (chunk) => output.push(String(chunk)));
child.stderr.on("data", (chunk) => output.push(String(chunk)));

try {
  const response = await waitForHealth(port, child);
  if (response.status !== "ok" || response.mode !== "local-disabled") {
    throw new Error(`Unexpected /health response: ${JSON.stringify(response)}`);
  }
  console.log(`API ${useDist ? "dist" : "source"} smoke passed on 127.0.0.1:${port}`);
} catch (error) {
  console.error(output.join(""));
  throw error;
} finally {
  child.kill("SIGTERM");
  await waitForExit(child);
}

async function getAvailablePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  if (address === null || typeof address === "string") {
    throw new Error("Unable to allocate an API smoke port");
  }
  return address.port;
}

async function waitForHealth(port, child) {
  const deadline = Date.now() + 15_000;
  let exitCode;
  child.once("exit", (code) => {
    exitCode = code;
  });

  while (Date.now() < deadline) {
    if (exitCode !== undefined) {
      throw new Error(`API process exited before /health responded: ${exitCode}`);
    }

    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) {
        if (!response.headers.get("x-correlation-id")) {
          throw new Error("API /health response is missing x-correlation-id");
        }
        if (!response.headers.get("x-request-id")) {
          throw new Error("API /health response is missing x-request-id");
        }
        return response.json();
      }
    } catch {
      // Keep polling until Nest finishes booting.
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error("Timed out waiting for API /health");
}

async function waitForExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  await new Promise((resolve) => child.once("exit", resolve));
}
