/** Human opt-in only. The Host derives objective identity and authority from the original message. */
export interface AutonomousGoalOptions {
  durationHours: number;
  maxAttempts: number;
}

export interface AutonomousGoalStatus {
  goalId: string;
  revision: number;
  disposition: 'active' | 'finalizing' | 'accepted' | 'stopped';
  startedAt: string;
  deadlineAt: string;
  attemptLimit: number;
  attemptsUsed: number;
  reason?: string;
  resultMessageId?: string;
  published?: boolean;
  canResume?: boolean;
}

export interface AutonomousGoalControl {
  goalId: string;
  expectedRevision: number;
  action: 'stop' | 'resume' | 'extend';
  deadlineAt?: string;
  attemptLimit?: number;
}

export const DEFAULT_AUTONOMOUS_GOAL_OPTIONS: Readonly<AutonomousGoalOptions> = {
  durationHours: 12,
  maxAttempts: 100,
};

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid goal');
  return value as Record<string, unknown>;
}
function integer(value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max)
    throw new Error('Invalid goal limit');
  return value;
}
function text(value: unknown, max = 256): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0'))
    throw new Error('Invalid goal text');
  return value;
}
function date(value: unknown): string {
  const result = text(value, 64);
  if (!Number.isFinite(Date.parse(result))) throw new Error('Invalid goal date');
  return result;
}

export function readAutonomousGoalOptions(value: unknown): AutonomousGoalOptions {
  const source = object(value);
  if (Object.keys(source).some((key) => !['durationHours', 'maxAttempts'].includes(key)))
    throw new Error('Invalid goal options');
  return {
    durationHours: integer(source.durationHours, 1, 24),
    maxAttempts: integer(source.maxAttempts, 1, 1000),
  };
}

export function readAutonomousGoalControl(value: unknown): AutonomousGoalControl {
  const source = object(value);
  if (
    Object.keys(source).some(
      (key) => !['goalId', 'expectedRevision', 'action', 'deadlineAt', 'attemptLimit'].includes(key)
    )
  )
    throw new Error('Invalid goal control');
  if (source.action !== 'stop' && source.action !== 'resume' && source.action !== 'extend')
    throw new Error('Invalid goal action');
  if (
    source.action !== 'extend' &&
    (source.deadlineAt !== undefined || source.attemptLimit !== undefined)
  )
    throw new Error('Only extension may change limits');
  if (
    source.action === 'extend' &&
    source.deadlineAt === undefined &&
    source.attemptLimit === undefined
  )
    throw new Error('Missing goal extension');
  return {
    goalId: text(source.goalId),
    expectedRevision: integer(source.expectedRevision, 1, Number.MAX_SAFE_INTEGER),
    action: source.action,
    ...(source.deadlineAt === undefined ? {} : { deadlineAt: date(source.deadlineAt) }),
    ...(source.attemptLimit === undefined
      ? {}
      : { attemptLimit: integer(source.attemptLimit, 1, 1000) }),
  };
}

/** Project a bounded public status. Private owner fields never cross the transport. */
export function readAutonomousGoalStatus(value: unknown): AutonomousGoalStatus {
  const source = object(value);
  if (
    typeof source.disposition !== 'string' ||
    !['active', 'finalizing', 'accepted', 'stopped'].includes(source.disposition)
  )
    throw new Error('Invalid goal disposition');
  for (const key of ['published', 'canResume'])
    if (source[key] !== undefined && typeof source[key] !== 'boolean')
      throw new Error('Invalid goal state');
  const attemptLimit = integer(source.attemptLimit, 1, 1000);
  return {
    goalId: text(source.goalId),
    revision: integer(source.revision, 1, Number.MAX_SAFE_INTEGER),
    disposition: source.disposition as AutonomousGoalStatus['disposition'],
    startedAt: date(source.startedAt),
    deadlineAt: date(source.deadlineAt),
    attemptLimit,
    attemptsUsed: integer(source.attemptsUsed, 0, attemptLimit),
    ...(source.reason === undefined ? {} : { reason: text(source.reason, 512) }),
    ...(source.resultMessageId === undefined
      ? {}
      : { resultMessageId: text(source.resultMessageId) }),
    ...(source.published === undefined ? {} : { published: source.published as boolean }),
    ...(source.canResume === undefined ? {} : { canResume: source.canResume as boolean }),
  };
}
