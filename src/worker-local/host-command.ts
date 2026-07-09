import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { delimiter, isAbsolute, join } from "node:path";
import type {
  HostExecutableLookup,
  HostExecutableResolution,
} from "@vioxen/subscription-runtime/worker-core";

export async function resolveHostExecutable(
  input: HostExecutableLookup,
): Promise<HostExecutableResolution> {
  const env = input.env ?? process.env;
  const checked: string[] = [];
  for (const envName of input.envNames ?? []) {
    const value = env[envName]?.trim();
    if (!value) continue;
    checked.push(value);
    if (await isExecutable(value)) {
      return {
        name: input.name,
        executable: value,
        found: true,
        source: "env",
        sourceName: envName,
        checked,
      };
    }
  }

  for (const candidate of pathCandidates(input.name, env.PATH)) {
    checked.push(candidate);
    if (await isExecutable(candidate)) {
      return {
        name: input.name,
        executable: candidate,
        found: true,
        source: "path",
        checked,
      };
    }
  }

  for (const candidate of input.additionalCandidates ?? []) {
    checked.push(candidate);
    if (await isExecutable(candidate)) {
      return {
        name: input.name,
        executable: candidate,
        found: true,
        source: "candidate",
        checked,
      };
    }
  }

  return {
    name: input.name,
    executable: input.name,
    found: false,
    source: "unresolved",
    checked,
  };
}

function pathCandidates(name: string, pathValue: string | undefined): readonly string[] {
  if (isAbsolute(name) || name.includes("/") || name.includes("\\")) {
    return [name];
  }
  return (pathValue ?? "")
    .split(delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => join(entry, name));
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
