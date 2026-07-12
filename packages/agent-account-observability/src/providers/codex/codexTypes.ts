import type { AccountSlot } from "../../domain/model";

export type CodexAccountSlot = AccountSlot & {
  readonly authHome: string;
  readonly authJsonPath?: string;
  readonly codexBinaryPath?: string;
};

export interface CodexAppServerClientPort {
  call(input: {
    readonly method: string;
    readonly params?: unknown;
    readonly timeoutMs?: number;
  }): Promise<unknown>;
  close?(): Promise<void>;
}

export interface CodexAppServerClientFactoryPort {
  open(input: {
    readonly account: CodexAccountSlot;
    readonly timeoutMs?: number;
  }): Promise<CodexAppServerClientPort>;
}
