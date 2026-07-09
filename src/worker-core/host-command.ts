export * from "./host-command/safe-command-policy";

export type HostExecutableResolutionSource =
  | "env"
  | "path"
  | "candidate"
  | "unresolved";

export type HostExecutableResolution = {
  readonly name: string;
  readonly executable: string;
  readonly found: boolean;
  readonly source: HostExecutableResolutionSource;
  readonly sourceName?: string;
  readonly checked: readonly string[];
};

export type HostExecutableLookup = {
  readonly name: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly envNames?: readonly string[];
  readonly additionalCandidates?: readonly string[];
};

export function hostExecutableNotFoundMessage(
  resolution: HostExecutableResolution,
): string {
  const checked = resolution.checked.length
    ? ` Checked: ${resolution.checked.join(", ")}.`
    : "";
  return `${resolution.name} executable was not found.${checked}`;
}
