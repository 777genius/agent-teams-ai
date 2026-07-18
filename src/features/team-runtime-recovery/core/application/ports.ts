import type {
  RuntimeFailureReasonCode,
  RuntimeFailureSignal,
  TeamRuntimeRecoveryConfig,
} from '../../contracts';
import type {
  RuntimeRecoveryDeliveryResult,
  RuntimeRecoveryJob,
  RuntimeRecoveryPreflightResult,
  RuntimeRecoveryTeamState,
} from './types';

export interface RuntimeRecoveryClockPort {
  now(): Date;
}

export interface RuntimeRecoveryHashPort {
  sha256Hex(value: string): string;
}

export interface RuntimeRecoveryConfigPort {
  getConfig(): TeamRuntimeRecoveryConfig;
}

export interface RuntimeRecoveryRepositoryPort {
  read(teamName: string): Promise<RuntimeRecoveryTeamState>;
  update<T>(
    teamName: string,
    updater: (state: RuntimeRecoveryTeamState) => { state: RuntimeRecoveryTeamState; result: T }
  ): Promise<T>;
  listTeamNames(): Promise<string[]>;
}

export interface RuntimeRecoveryTargetPort {
  preflight(job: RuntimeRecoveryJob): Promise<RuntimeRecoveryPreflightResult>;
}

export interface RuntimeRecoveryDeliveryPort {
  deliver(input: {
    job: RuntimeRecoveryJob;
    memberName: string;
    text: string;
    payloadHash: string;
    reasonCode: RuntimeFailureReasonCode;
  }): Promise<RuntimeRecoveryDeliveryResult>;
  escalate?(input: { job: RuntimeRecoveryJob; leadName: string; reason: string }): Promise<void>;
}

export interface RuntimeRecoveryNotificationPort {
  scheduled?(job: RuntimeRecoveryJob): Promise<void> | void;
  completed?(job: RuntimeRecoveryJob): Promise<void> | void;
  manual?(signal: RuntimeFailureSignal, reason: string): Promise<void> | void;
  failed?(job: RuntimeRecoveryJob, reason: string): Promise<void> | void;
  cancelled?(job: RuntimeRecoveryJob, reason: string): Promise<void> | void;
}

export interface RuntimeRecoveryLoggerPort {
  debug(message: string, metadata?: Record<string, unknown>): void;
  warn(message: string, metadata?: Record<string, unknown>): void;
  error(message: string, metadata?: Record<string, unknown>): void;
}
