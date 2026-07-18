import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type CodexOpenAiBridgeAccount = {
  readonly name: string;
  readonly sourceCodexHome: string;
};

export type IsolatedCodexOpenAiBridgeAccount = {
  readonly home: string;
  readonly codexHome: string;
};

export async function discoverCodexBridgeAccounts(input: {
  readonly authRootDir: string;
  readonly accountNames?: readonly string[];
}): Promise<readonly CodexOpenAiBridgeAccount[]> {
  const allow = input.accountNames
    ? new Set(input.accountNames.map((name) => name.trim()).filter(Boolean))
    : null;
  const entries = await readdir(input.authRootDir, { withFileTypes: true });
  const accounts = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .filter((entry) => !allow || allow.has(entry.name))
      .map(async (entry) => {
        const sourceCodexHome = join(input.authRootDir, entry.name);
        if (!(await hasReadableCodexAuthJson(sourceCodexHome))) return null;
        return { name: entry.name, sourceCodexHome };
      }),
  );
  return accounts
    .filter((account): account is CodexOpenAiBridgeAccount => account !== null)
    .sort((left, right) => left.name.localeCompare(right.name));
}

async function hasReadableCodexAuthJson(sourceCodexHome: string): Promise<boolean> {
  try {
    await access(join(sourceCodexHome, "auth.json"));
    return true;
  } catch {
    return false;
  }
}

export async function seedIsolatedBridgeAccount(input: {
  readonly stateDir: string;
  readonly account: CodexOpenAiBridgeAccount;
}): Promise<IsolatedCodexOpenAiBridgeAccount> {
  const home = accountHome(input.stateDir, input.account.name);
  const codexHome = accountCodexHome(input.stateDir, input.account.name);
  await mkdir(home, { recursive: true, mode: 0o700 });
  await mkdir(codexHome, { recursive: true, mode: 0o700 });
  const authJson = await readFile(
    join(input.account.sourceCodexHome, "auth.json"),
    "utf8",
  );
  await writeFile(join(codexHome, "auth.json"), authJson, { mode: 0o600 });
  return { home, codexHome };
}

function accountHome(stateDir: string, accountName: string): string {
  return join(stateDir, "home", accountName);
}

function accountCodexHome(stateDir: string, accountName: string): string {
  return join(stateDir, "codex-home", accountName);
}
