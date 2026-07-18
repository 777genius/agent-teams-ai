import type {
  ManagedRunStorePort,
} from "@vioxen/subscription-runtime/core";
import type { ResolvedCodexExecutionProfile } from "../../codex-execution-profile";
import type { CodexMaterializedSession } from "../../codex-json-execution-engine";
import type {
  CodexAppServerChildProcessSignaler,
  CodexAppServerProcessFactory,
} from "./app-server-process-port";
import {
  appServerStartupTimeoutMs,
  throwIfAborted,
} from "../domain/app-server-errors";
import {
  defaultReconnectGraceMs,
  defaultTimeoutMs,
  type CodexAppServerCommandApprovalPolicy,
  type CodexAppServerNativeToolSurface,
} from "../domain/app-server-types";
import { CodexAppServerClient } from "./app-server-client";
import { AppServerGoalRunner } from "./app-server-goal-runner";
import { AppServerTurnRunner } from "./app-server-turn-runner";

export type AppServerSlot = {
  readonly key: string;
  readonly client: CodexAppServerClient;
  readonly turnRunner: AppServerTurnRunner;
  readonly goalRunner: AppServerGoalRunner;
  sessionHash: string | null;
};

export class AppServerSlotPool {
  private readonly slots = new Map<string, AppServerSlot>();

  constructor(
    private readonly options: {
      readonly codexBinaryPath: string;
      readonly sourceEnv?: Readonly<Record<string, string | undefined>>;
      readonly processFactory: CodexAppServerProcessFactory;
      readonly signalChildProcess: CodexAppServerChildProcessSignaler;
      readonly runStore: ManagedRunStorePort;
      readonly executionProfile: ResolvedCodexExecutionProfile;
      readonly commandApprovalPolicy?: CodexAppServerCommandApprovalPolicy;
      readonly nativeToolSurface?: CodexAppServerNativeToolSurface;
      readonly cleanThreadPrewarm: boolean;
      readonly timeoutMs?: number;
      readonly startupTimeoutMs?: number;
      readonly reconnectGraceMs?: number;
    },
  ) {}

  async ensureSlot(input: {
    readonly session: CodexMaterializedSession;
    readonly workspacePath: string;
    readonly abortSignal: AbortSignal;
  }): Promise<AppServerSlot> {
    const key = input.session.codexHome;
    const sessionHash = input.session.sessionHash ?? null;
    const existing = this.slots.get(key);
    if (existing && existing.sessionHash === sessionHash) {
      return existing;
    }

    if (existing) {
      await existing.client.stop();
      this.slots.delete(key);
    }

    throwIfAborted(input.abortSignal);
    const sourceEnv = {
      ...(this.options.sourceEnv ?? process.env),
      ...input.session.env,
    };
    const client = new CodexAppServerClient({
      codexBinaryPath: this.options.codexBinaryPath,
      sourceEnv,
      processFactory: this.options.processFactory,
      signalChildProcess: this.options.signalChildProcess,
      session: input.session,
      workspacePath: input.workspacePath,
      executionProfile: this.options.executionProfile,
      ...(this.options.commandApprovalPolicy === undefined
        ? {}
        : { commandApprovalPolicy: this.options.commandApprovalPolicy }),
      ...(this.options.nativeToolSurface === undefined
        ? {}
        : { nativeToolSurface: this.options.nativeToolSurface }),
      timeoutMs: this.options.timeoutMs ?? defaultTimeoutMs,
      startupTimeoutMs: appServerStartupTimeoutMs({
        ...(this.options.timeoutMs === undefined
          ? {}
          : { timeoutMs: this.options.timeoutMs }),
        ...(this.options.startupTimeoutMs === undefined
          ? {}
          : { startupTimeoutMs: this.options.startupTimeoutMs }),
      }),
      reconnectGraceMs: this.options.reconnectGraceMs ?? defaultReconnectGraceMs,
      abortSignal: input.abortSignal,
    });
    try {
      await client.start();
    } catch (error) {
      await client.stop().catch(() => undefined);
      throw error;
    }
    const slot = {
      key,
      client,
      turnRunner: new AppServerTurnRunner({
        client,
        cleanThreadPrewarm: this.options.cleanThreadPrewarm,
      }),
      goalRunner: new AppServerGoalRunner({
        client,
        runStore: this.options.runStore,
      }),
      sessionHash,
    };
    this.slots.set(key, slot);
    return slot;
  }

  async disposeSessionSlot(session: CodexMaterializedSession): Promise<void> {
    const slot = this.slots.get(session.codexHome);
    if (!slot) return;
    this.slots.delete(session.codexHome);
    await slot.client.stop();
  }

  async dispose(): Promise<void> {
    const slots = [...this.slots.values()];
    this.slots.clear();
    await Promise.all(slots.map((slot) => slot.client.stop()));
  }
}
