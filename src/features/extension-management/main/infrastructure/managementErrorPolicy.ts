import { ManagementError } from '@uap/management-sdk';

/** These refusals follow durable replay lookup and prove no new acceptance. */
export const isDefinitiveManagementRefusal = (error: unknown): boolean =>
  error instanceof ManagementError && ['PLAN_STALE', 'HISTORY_FULL'].includes(error.code);
