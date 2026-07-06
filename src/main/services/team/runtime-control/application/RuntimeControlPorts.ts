import type { RuntimeControlEvent } from '../domain/RuntimeControlEvent';

export interface RuntimeControlEventSink {
  record(event: RuntimeControlEvent): Promise<void> | void;
}
