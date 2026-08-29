// @vitest-environment node

import { createHostedOperatorSurfacesComposition } from '@main/composition/hosted/hostedOperatorSurfacesComposition';
import { describe, expect, it, vi } from 'vitest';

import type { HostedRouteAdmission } from '@main/composition/hosted/application';
import type { RouteDescriptor } from '@main/composition/hosted/routing';
import type { FastifyInstance } from 'fastify';

const registrations = vi.hoisted(() => ({
  readiness: vi.fn(),
  memberLog: vi.fn(),
  approvals: vi.fn(),
  diagnostics: vi.fn(),
  readinessDescriptor: Object.freeze({
    id: 'hosted-readiness.projection.v1',
    method: 'GET',
    path: '/api/hosted/v1/readiness',
  }),
}));

vi.mock('@features/hosted-readiness/main/hosted', () => ({
  HOSTED_READINESS_ROUTE_DESCRIPTORS: Object.freeze([registrations.readinessDescriptor]),
  registerHostedReadinessHttp: registrations.readiness,
}));
vi.mock('@features/member-log-stream/main/hosted', () => ({
  registerHostedMemberLogHttp: registrations.memberLog,
}));
vi.mock('@features/team-approvals/main/hosted', () => ({
  registerHostedTeamApprovalsHttp: registrations.approvals,
}));
vi.mock('@features/hosted-operations/main/hosted', () => ({
  registerHostedDiagnosticsHttp: registrations.diagnostics,
}));

function route(id: string, path: string): RouteDescriptor {
  return Object.freeze({
    id,
    method: 'POST',
    path,
    owner: 'test',
    trustKind: 'browser',
    authPolicyId: 'hosted.browser.session',
    readiness: Object.freeze(['serve', 'auth', 'read'] as const),
    requestSchemaId: `${id}.request`,
    responseSchemaId: `${id}.response`,
    handlerId: `${id}.handler`,
    clientId: `${id}.client`,
    semanticTestId: `${id}.semantic`,
    testOnly: true,
  });
}

describe('createHostedOperatorSurfacesComposition', () => {
  it('injects one shared admission into operator routes without self-admitting readiness', () => {
    const app = Object.freeze({}) as unknown as FastifyInstance;
    const routeAdmission = Object.freeze({}) as unknown as HostedRouteAdmission;
    const readinessContext = vi.fn();
    const memberContext = vi.fn();
    const approvalContext = vi.fn();
    const diagnosticsContext = vi.fn();
    const readinessFacade = Object.freeze({ getReadiness: vi.fn() });
    const memberFacade = Object.freeze({ getPage: vi.fn() });
    const approvalFacade = Object.freeze({
      getPage: vi.fn(),
      getPreview: vi.fn(),
      decide: vi.fn(),
    });
    const approvalRoute = route('team-approvals.page.v1', '/approvals');
    const approvalRoutes = Object.freeze([approvalRoute]);
    const approvalContribution = Object.freeze({
      id: 'team-approvals.hosted.v1',
      facade: approvalFacade,
      routes: approvalRoutes,
    });
    const diagnosticsFacade = Object.freeze({ getDiagnostics: vi.fn() });

    const composition = createHostedOperatorSurfacesComposition({
      routeAdmission,
      readiness: {
        contribution: Object.freeze({
          id: 'hosted-readiness.projection.hosted.v1',
          facade: readinessFacade,
          routes: Object.freeze([registrations.readinessDescriptor as unknown as RouteDescriptor]),
        }),
        createContext: readinessContext,
      },
      memberLog: {
        contribution: Object.freeze({
          id: 'member-log-stream.hosted.v1',
          facade: memberFacade,
          routes: Object.freeze([route('member-log.page.v1', '/member-log')]),
        }),
        createContext: memberContext,
      },
      approvals: {
        contribution: approvalContribution,
        createContext: approvalContext,
      },
      diagnostics: {
        contribution: Object.freeze({
          id: 'hosted-operations.diagnostics.hosted.v1',
          facade: diagnosticsFacade,
          routes: Object.freeze([route('diagnostics.v1', '/diagnostics')]),
        }),
        createContext: diagnosticsContext,
      },
    } as never);

    composition.register(app);

    expect(registrations.readiness).toHaveBeenCalledWith(app, readinessFacade, readinessContext);
    expect(registrations.memberLog).toHaveBeenCalledWith(
      app,
      expect.objectContaining({ facade: memberFacade }),
      routeAdmission,
      memberContext
    );
    expect(registrations.approvals).toHaveBeenCalledWith(
      app,
      approvalContribution,
      routeAdmission,
      undefined,
      approvalContext
    );
    const registeredApprovalContribution = registrations.approvals.mock.calls[0]?.[1];
    expect(registeredApprovalContribution).toBe(approvalContribution);
    expect(registeredApprovalContribution.routes).toBe(approvalRoutes);
    expect(registeredApprovalContribution.routes[0]).toBe(approvalRoute);
    expect(registrations.diagnostics).toHaveBeenCalledWith(
      app,
      expect.objectContaining({ facade: diagnosticsFacade }),
      routeAdmission,
      diagnosticsContext
    );
    expect(() => composition.register(app)).toThrow('hosted-operator-surfaces-already-registered');
  });

  it('rejects a copied readiness descriptor instead of trusting structural equality', () => {
    const composition = createHostedOperatorSurfacesComposition({
      routeAdmission: Object.freeze({}) as unknown as HostedRouteAdmission,
      readiness: {
        contribution: Object.freeze({
          id: 'hosted-readiness.projection.hosted.v1',
          facade: Object.freeze({ getReadiness: vi.fn() }),
          routes: Object.freeze([
            { ...registrations.readinessDescriptor } as unknown as RouteDescriptor,
          ]),
        }),
        createContext: vi.fn(),
      },
    } as never);

    expect(() => composition.register(Object.freeze({}) as unknown as FastifyInstance)).toThrow(
      'hosted-readiness-route-contribution-invalid'
    );
  });
});
