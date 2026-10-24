import assert from 'node:assert/strict';
import type {
  CloseReceipt,
  Event,
  Handoff,
  Input,
  InteractionReply,
  Reply,
  Session,
} from '@agent-teams/provider-session-contracts';
class Events implements AsyncIterable<Event> {
  private readonly queue: Event[] = [];
  private waiter: ((result: IteratorResult<Event>) => void) | undefined;
  private ended = false;
  push(event: Event): void {
    if (this.waiter) {
      const next = this.waiter;
      this.waiter = undefined;
      next({ done: false, value: event });
    } else this.queue.push(event);
  }
  end(): void {
    this.ended = true;
    this.waiter?.({ done: true, value: undefined });
    this.waiter = undefined;
  }
  [Symbol.asyncIterator](): AsyncIterator<Event> {
    return {
      next: () => {
        const event = this.queue.shift();
        if (event) return Promise.resolve({ done: false, value: event });
        if (this.ended) return Promise.resolve({ done: true, value: undefined });
        return new Promise((resolve) => {
          this.waiter = resolve;
        });
      },
    };
  }
}

export class ControlledSession implements Session {
  readonly events = new Events();
  readonly submits: Input[] = [];
  readonly interrupts: string[] = [];
  readonly replies: { ref: string; reply: InteractionReply }[] = [];
  closeCalls = 0;
  cleanup: CloseReceipt['cleanup'] = 'confirmed';
  submitAction: ((input: Input) => Promise<Reply<Handoff>>) | undefined;
  interruptAction: (() => Promise<Reply<{ requested: true; terminal: 'unconfirmed' }>>) | undefined;
  readonly sessionRef: string;
  constructor(sessionRef: string) {
    this.sessionRef = sessionRef;
  }
  submit = async (input: Input): Promise<Reply<Handoff>> => {
    this.submits.push(input);
    return this.submitAction
      ? this.submitAction(input)
      : {
          ok: true,
          value: {
            inputId: input.inputId,
            operationRef: input.operationRef,
            delivery: 'client-consumed',
            providerAcceptance: 'unknown',
          },
        };
  };
  observe = (): AsyncIterable<Event> => this.events;
  respondToInteraction = async (ref: string, reply: InteractionReply): Promise<Reply<void>> => {
    this.replies.push({ ref, reply });
    return { ok: true, value: undefined };
  };
  interrupt = async (ref: string): Promise<Reply<{ requested: true; terminal: 'unconfirmed' }>> => {
    this.interrupts.push(ref);
    return this.interruptAction
      ? this.interruptAction()
      : { ok: true, value: { requested: true, terminal: 'unconfirmed' } };
  };
  checkReadiness = async (): Promise<Reply<void>> => ({ ok: true, value: undefined });
  checkpoint = (): Reply<unknown> => ({ ok: false, code: 'unsupported' });
  close = async (): Promise<CloseReceipt> => {
    this.closeCalls++;
    this.events.end();
    return { logicallyClosed: true, cleanup: this.cleanup };
  };
  result(index = 0, outcome: 'succeeded' | 'failed' | 'cancelled' | 'unknown' = 'succeeded'): void {
    const input = this.submits[index];
    assert.ok(input);
    this.events.push({
      sessionRef: this.sessionRef,
      inputId: input.inputId,
      operationRef: input.operationRef,
      kind: 'result',
      outcome,
    });
  }
}
