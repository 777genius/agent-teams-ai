import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { delimiter, isAbsolute, join } from "node:path";
export async function resolveHostExecutable(input) {
    const env = input.env ?? process.env;
    const checked = [];
    for (const envName of input.envNames ?? []) {
        const value = env[envName]?.trim();
        if (!value)
            continue;
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
export function hostExecutableNotFoundMessage(resolution) {
    const checked = resolution.checked.length
        ? ` Checked: ${resolution.checked.join(", ")}.`
        : "";
    return `${resolution.name} executable was not found.${checked}`;
}
function pathCandidates(name, pathValue) {
    if (isAbsolute(name) || name.includes("/") || name.includes("\\")) {
        return [name];
    }
    return (pathValue ?? "")
        .split(delimiter)
        .map((entry) => entry.trim())
        .filter(Boolean)
        .map((entry) => join(entry, name));
}
async function isExecutable(path) {
    try {
        await access(path, constants.X_OK);
        return true;
    }
    catch {
        return false;
    }
}
//# sourceMappingURL=host-command.js.map