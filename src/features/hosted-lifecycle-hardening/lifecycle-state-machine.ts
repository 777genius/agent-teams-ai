export const LIFECYCLE_STATES = [
  'accepting',
  'admission_closed',
  'draining_http_sse',
  'flushing_state_audit',
  'releasing_owned_runtime',
  'stopped',
] as const;

export type LifecycleState = (typeof LIFECYCLE_STATES)[number];

const NEXT_STATE: Readonly<Partial<Record<LifecycleState, LifecycleState>>> = {
  accepting: 'admission_closed',
  admission_closed: 'draining_http_sse',
  draining_http_sse: 'flushing_state_audit',
  flushing_state_audit: 'releasing_owned_runtime',
  releasing_owned_runtime: 'stopped',
};

/** Pure, forward-only state model for the hosted shutdown sequence. */
export class LifecycleStateMachine {
  private currentState: LifecycleState = 'accepting';
  private readonly visitedStates: LifecycleState[] = ['accepting'];

  get state(): LifecycleState {
    return this.currentState;
  }

  get history(): readonly LifecycleState[] {
    return [...this.visitedStates];
  }

  transition(next: LifecycleState): void {
    if (NEXT_STATE[this.currentState] !== next) {
      throw new Error(`Invalid lifecycle transition: ${this.currentState} -> ${next}`);
    }

    this.currentState = next;
    this.visitedStates.push(next);
  }

  /** Ends coordination without claiming that an unproven phase was reached. */
  stopAfterTerminalOutcome(): void {
    if (this.currentState !== 'stopped') {
      this.currentState = 'stopped';
      this.visitedStates.push('stopped');
    }
  }
}
