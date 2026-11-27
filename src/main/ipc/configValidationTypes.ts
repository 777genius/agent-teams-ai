import type { AppConfig } from '../services';

export type ConfigSection = keyof AppConfig;

export interface ValidationSuccess<K extends ConfigSection> {
  valid: true;
  section: K;
  data: Partial<AppConfig[K]>;
}

export interface ValidationFailure {
  valid: false;
  error: string;
}

export type ConfigUpdateValidationResult =
  | ValidationSuccess<'notifications'>
  | ValidationSuccess<'teamRuntimeRecovery'>
  | ValidationSuccess<'general'>
  | ValidationSuccess<'providerConnections'>
  | ValidationSuccess<'runtime'>
  | ValidationSuccess<'display'>
  | ValidationSuccess<'httpServer'>
  | ValidationSuccess<'ssh'>
  | ValidationFailure;
