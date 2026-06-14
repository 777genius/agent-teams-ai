#!/usr/bin/env node
import { readFile, realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { loadAgentTaskHandler, runAgentTaskBridge } from "./bridge.js";
export async function runAgentTaskCli(argv = process.argv.slice(2), io = defaultIo) {
    try {
        const args = parseArgs(argv);
        const requestText = args.inputPath
            ? await readFile(args.inputPath, "utf8")
            : await io.readStdin();
        const request = JSON.parse(requestText);
        const handler = await loadAgentTaskHandler(args.handler, { cwd: io.cwd() });
        const run = await runAgentTaskBridge(request, handler, args.format === "event-ndjson"
            ? {
                onEvent: (event) => io.writeStdout(`${JSON.stringify(event)}\n`),
            }
            : {});
        if (args.format === "result-json") {
            io.writeStdout(`${JSON.stringify(run.result)}\n`);
        }
        return run.result.status === "completed" ? 0 : 1;
    }
    catch (error) {
        io.writeStderr(`${error instanceof Error ? error.message : "agent task bridge failed"}\n`);
        return 2;
    }
}
function parseArgs(argv) {
    let handler = null;
    let inputPath;
    let format = "event-ndjson";
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === "--handler") {
            handler = requiredValue(argv, index, arg);
            index += 1;
            continue;
        }
        if (arg === "--input") {
            inputPath = requiredValue(argv, index, arg);
            index += 1;
            continue;
        }
        if (arg === "--format") {
            const value = requiredValue(argv, index, arg);
            if (value !== "event-ndjson" && value !== "result-json") {
                throw new Error("--format must be event-ndjson or result-json");
            }
            format = value;
            index += 1;
            continue;
        }
        if (arg === "--help" || arg === "-h") {
            throw new Error("usage: subscription-runtime-agent-task --handler <module> [--input request.json] [--format event-ndjson|result-json]");
        }
        throw new Error(`unknown argument: ${arg}`);
    }
    if (!handler) {
        throw new Error("--handler is required");
    }
    return {
        handler,
        ...(inputPath ? { inputPath } : {}),
        format,
    };
}
function requiredValue(argv, index, flag) {
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
        throw new Error(`${flag} requires a value`);
    }
    return value;
}
const defaultIo = {
    async readStdin() {
        const chunks = [];
        for await (const chunk of process.stdin) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        return Buffer.concat(chunks).toString("utf8");
    },
    writeStdout(chunk) {
        process.stdout.write(chunk);
    },
    writeStderr(chunk) {
        process.stderr.write(chunk);
    },
    cwd() {
        return process.cwd();
    },
};
if (await isMainModule()) {
    process.exitCode = await runAgentTaskCli();
}
async function isMainModule() {
    if (!process.argv[1])
        return false;
    const modulePath = fileURLToPath(import.meta.url);
    try {
        return (await realpath(modulePath)) === (await realpath(process.argv[1]));
    }
    catch {
        return modulePath === process.argv[1];
    }
}
//# sourceMappingURL=cli.js.map