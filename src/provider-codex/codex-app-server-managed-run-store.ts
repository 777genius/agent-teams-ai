import type {
  ManagedRunInputRequest,
  ManagedRunRecord,
  ManagedRunResumeHandle,
  ManagedRunStorePort,
} from "@vioxen/subscription-runtime/core";

export class InMemoryManagedRunStore implements ManagedRunStorePort {
  private readonly records = new Map<string, ManagedRunRecord>();

  async get(input: { readonly runId: string }): Promise<ManagedRunRecord | null> {
    return this.records.get(input.runId) ?? null;
  }

  async saveWaitingInput(input: {
    readonly runId: string;
    readonly request: ManagedRunInputRequest;
    readonly resumeHandle: ManagedRunResumeHandle;
    readonly recoveryPacket?: ManagedRunRecord["recoveryPacket"];
    readonly taskId?: string;
    readonly assignedWorkerId?: string;
    readonly providerInstanceId?: string;
    readonly workspacePath?: string;
    readonly outputText?: string;
    readonly now: Date;
  }): Promise<ManagedRunRecord> {
    const current = this.records.get(input.runId);
    const record: ManagedRunRecord = {
      runId: input.runId,
      status: "waiting_for_input",
      request: input.request,
      resumeHandle: input.resumeHandle,
      ...(input.recoveryPacket === undefined
        ? current?.recoveryPacket === undefined
          ? {}
          : { recoveryPacket: current.recoveryPacket }
        : { recoveryPacket: input.recoveryPacket }),
      ...(input.taskId === undefined
        ? current?.taskId === undefined
          ? {}
          : { taskId: current.taskId }
        : { taskId: input.taskId }),
      ...(input.assignedWorkerId === undefined
        ? current?.assignedWorkerId === undefined
          ? {}
          : { assignedWorkerId: current.assignedWorkerId }
        : { assignedWorkerId: input.assignedWorkerId }),
      ...(input.providerInstanceId === undefined
        ? current?.providerInstanceId === undefined
          ? {}
          : { providerInstanceId: current.providerInstanceId }
        : { providerInstanceId: input.providerInstanceId }),
      ...(input.workspacePath === undefined
        ? current?.workspacePath === undefined
          ? {}
          : { workspacePath: current.workspacePath }
        : { workspacePath: input.workspacePath }),
      ...(input.outputText === undefined ? {} : { outputText: input.outputText }),
      updatedAt: input.now,
    };
    this.records.set(input.runId, record);
    return record;
  }

  async resume(input: {
    readonly runId: string;
    readonly requestId: string;
    readonly answer: string;
    readonly now: Date;
  }): Promise<ManagedRunRecord> {
    const current = this.records.get(input.runId);
    if (
      !current ||
      current.status !== "waiting_for_input" ||
      current.request?.id !== input.requestId
    ) {
      throw new Error("managed_run_request_mismatch");
    }
    const record: ManagedRunRecord = {
      runId: input.runId,
      status: "active",
      ...(current.recoveryPacket === undefined
        ? {}
        : { recoveryPacket: current.recoveryPacket }),
      ...(current.taskId === undefined ? {} : { taskId: current.taskId }),
      ...(current.assignedWorkerId === undefined
        ? {}
        : { assignedWorkerId: current.assignedWorkerId }),
      ...(current.providerInstanceId === undefined
        ? {}
        : { providerInstanceId: current.providerInstanceId }),
      ...(current.workspacePath === undefined
        ? {}
        : { workspacePath: current.workspacePath }),
      ...(current.outputText === undefined
        ? {}
        : { outputText: current.outputText }),
      updatedAt: input.now,
    };
    this.records.set(input.runId, record);
    return record;
  }

  async complete(input: {
    readonly runId: string;
    readonly outputText: string;
    readonly now: Date;
  }): Promise<ManagedRunRecord> {
    const current = this.records.get(input.runId);
    const record: ManagedRunRecord = {
      ...(current ?? { runId: input.runId }),
      runId: input.runId,
      status: "completed",
      outputText: input.outputText,
      updatedAt: input.now,
    };
    this.records.set(input.runId, record);
    return record;
  }

  async fail(
    input: Parameters<ManagedRunStorePort["fail"]>[0],
  ): Promise<ManagedRunRecord> {
    const current = this.records.get(input.runId);
    const record: ManagedRunRecord = {
      ...(current ?? { runId: input.runId }),
      runId: input.runId,
      status: "failed",
      failure: input.failure,
      updatedAt: input.now,
    };
    this.records.set(input.runId, record);
    return record;
  }
}
