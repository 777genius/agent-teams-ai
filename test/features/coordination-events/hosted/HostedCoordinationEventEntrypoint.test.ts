import * as coordinationEventsMain from '@features/coordination-events/main';
import * as hostedCoordinationEventsMain from '@features/coordination-events/main/hosted';
import { describe, expect, expectTypeOf, it } from 'vitest';

import type {
  CreateHostedCoordinationEventStreamOptions,
  HostedCoordinationEventStream,
  HostedCoordinationEventStreamAuthorizer,
} from '@features/coordination-events/main/hosted';

describe('hosted coordination event entrypoint', () => {
  it('exports only the hosted stream composition from its dedicated main-process facet', () => {
    expect(hostedCoordinationEventsMain.createHostedCoordinationEventStream).toBeTypeOf('function');
    expect(Object.keys(hostedCoordinationEventsMain)).toEqual([
      'createHostedCoordinationEventStream',
    ]);
    expect(coordinationEventsMain).not.toHaveProperty('createHostedCoordinationEventStream');

    expectTypeOf(hostedCoordinationEventsMain.createHostedCoordinationEventStream)
      .parameter(0)
      .toEqualTypeOf<CreateHostedCoordinationEventStreamOptions>();
    expectTypeOf(
      hostedCoordinationEventsMain.createHostedCoordinationEventStream
    ).returns.toEqualTypeOf<HostedCoordinationEventStream>();
    expectTypeOf<
      CreateHostedCoordinationEventStreamOptions['authorizer']
    >().toEqualTypeOf<HostedCoordinationEventStreamAuthorizer>();
  });
});
