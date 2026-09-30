import * as coordinationEventsMain from '@features/coordination-events/main';
import { describe, expect, expectTypeOf, it } from 'vitest';

import type {
  CreateHostedCoordinationEventStreamOptions,
  HostedCoordinationEventStorage,
  HostedCoordinationEventStream,
  HostedCoordinationEventStreamAuthorizer,
  HostedCoordinationEventStreamIdentityFactory,
  HostedCoordinationEventStreamWriteObserver,
} from '@features/coordination-events/main';

describe('hosted coordination event entrypoint', () => {
  it('wraps the hosted composition behind feature-owned public ports', () => {
    expect(coordinationEventsMain.createHostedCoordinationEventStream).toBeTypeOf('function');
    expect(Object.keys(coordinationEventsMain)).toEqual([
      'createHostedCoordinationEventStream',
      'createCoordinationEventsFeature',
    ]);

    expectTypeOf(coordinationEventsMain.createHostedCoordinationEventStream)
      .parameter(0)
      .toEqualTypeOf<CreateHostedCoordinationEventStreamOptions>();
    expectTypeOf(
      coordinationEventsMain.createHostedCoordinationEventStream
    ).returns.toEqualTypeOf<HostedCoordinationEventStream>();
    expectTypeOf<
      CreateHostedCoordinationEventStreamOptions['authorizer']
    >().toEqualTypeOf<HostedCoordinationEventStreamAuthorizer>();
    expectTypeOf<
      CreateHostedCoordinationEventStreamOptions['storage']
    >().toEqualTypeOf<HostedCoordinationEventStorage>();
    expectTypeOf<
      CreateHostedCoordinationEventStreamOptions['streamIdentityFactory']
    >().toEqualTypeOf<HostedCoordinationEventStreamIdentityFactory>();
    expectTypeOf<
      CreateHostedCoordinationEventStreamOptions['diagnosticObserver']
    >().toEqualTypeOf<HostedCoordinationEventStreamWriteObserver | undefined>();
    expectTypeOf<HostedCoordinationEventStream['handoff']['replay']>().toBeFunction();
  });
});
