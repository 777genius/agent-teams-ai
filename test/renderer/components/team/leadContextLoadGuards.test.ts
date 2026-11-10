import { describe, expect, it } from 'vitest';

import {
  buildLeadSessionDetailRequestKey,
  deriveLeadContextButtonLabel,
  shouldFetchLeadSessionDetail,
  shouldLoadLeadSessionDetail,
} from '@renderer/components/team/leadContextLoadGuards';

describe('leadContextLoadGuards', () => {
  describe('shouldLoadLeadSessionDetail', () => {
    it('does not load when disabled', () => {
      expect(
        shouldLoadLeadSessionDetail({
          enabled: false,
          tabId: 'tab-1',
          projectId: 'project-1',
          leadSessionId: 'lead-1',
        })
      ).toBe(false);
    });

    it('requires all identifiers', () => {
      expect(
        shouldLoadLeadSessionDetail({
          enabled: true,
          tabId: null,
          projectId: 'project-1',
          leadSessionId: 'lead-1',
        })
      ).toBe(false);
      expect(
        shouldLoadLeadSessionDetail({
          enabled: true,
          tabId: 'tab-1',
          projectId: null,
          leadSessionId: 'lead-1',
        })
      ).toBe(false);
      expect(
        shouldLoadLeadSessionDetail({
          enabled: true,
          tabId: 'tab-1',
          projectId: 'project-1',
          leadSessionId: null,
        })
      ).toBe(false);
    });

    it('loads only when enabled and identifiers are valid', () => {
      expect(
        shouldLoadLeadSessionDetail({
          enabled: true,
          tabId: 'tab-1',
          projectId: 'project-1',
          leadSessionId: 'lead-1',
        })
      ).toBe(true);
    });
  });

  describe('buildLeadSessionDetailRequestKey', () => {
    it('builds a stable per-tab request key', () => {
      expect(
        buildLeadSessionDetailRequestKey({
          tabId: 'tab-1',
          projectId: 'project-1',
          leadSessionId: 'lead-1',
        })
      ).toBe('tab-1:project-1:lead-1');
    });
  });

  describe('shouldFetchLeadSessionDetail', () => {
    it('does not fetch without a requested session', () => {
      expect(
        shouldFetchLeadSessionDetail({
          requestedSessionId: null,
          loadedSessionId: null,
          loading: false,
          inFlightOrAttemptedRequestKey: null,
          nextRequestKey: null,
        })
      ).toBe(false);
    });

    it('does not fetch while loading', () => {
      expect(
        shouldFetchLeadSessionDetail({
          requestedSessionId: 'lead-1',
          loadedSessionId: null,
          loading: true,
          inFlightOrAttemptedRequestKey: null,
          nextRequestKey: 'tab-1:project-1:lead-1',
        })
      ).toBe(false);
    });

    it('does not fetch an already loaded session', () => {
      expect(
        shouldFetchLeadSessionDetail({
          requestedSessionId: 'lead-1',
          loadedSessionId: 'lead-1',
          loading: false,
          inFlightOrAttemptedRequestKey: null,
          nextRequestKey: 'tab-1:project-1:lead-1',
        })
      ).toBe(false);
    });

    it('does not refetch the same attempted request key', () => {
      expect(
        shouldFetchLeadSessionDetail({
          requestedSessionId: 'lead-1',
          loadedSessionId: null,
          loading: false,
          inFlightOrAttemptedRequestKey: 'tab-1:project-1:lead-1',
          nextRequestKey: 'tab-1:project-1:lead-1',
        })
      ).toBe(false);
    });

    it('fetches when the requested session is unloaded and not already attempted', () => {
      expect(
        shouldFetchLeadSessionDetail({
          requestedSessionId: 'lead-2',
          loadedSessionId: 'lead-1',
          loading: false,
          inFlightOrAttemptedRequestKey: null,
          nextRequestKey: 'tab-1:project-1:lead-2',
        })
      ).toBe(true);
    });
  });

  describe('deriveLeadContextButtonLabel', () => {
    it('uses live percent while the panel is closed', () => {
      expect(
        deriveLeadContextButtonLabel({
          liveContextUsedPercent: 25,
          fullContextUsedPercent: 90,
          contextPanelOpen: false,
        })
      ).toBe('25.0%');
    });

    it('prefers full percent while the panel is open', () => {
      expect(
        deriveLeadContextButtonLabel({
          liveContextUsedPercent: 25,
          fullContextUsedPercent: 90,
          contextPanelOpen: true,
        })
      ).toBe('90.0%');
    });

    it('falls back to live percent while open when full percent is unavailable', () => {
      expect(
        deriveLeadContextButtonLabel({
          liveContextUsedPercent: 25,
          fullContextUsedPercent: null,
          contextPanelOpen: true,
        })
      ).toBe('25.0%');
    });

    it('falls back to Context when no percent is available', () => {
      expect(
        deriveLeadContextButtonLabel({
          liveContextUsedPercent: null,
          fullContextUsedPercent: null,
          contextPanelOpen: false,
        })
      ).toBe('Context');
    });

    it('does not clamp full percent values', () => {
      expect(
        deriveLeadContextButtonLabel({
          liveContextUsedPercent: null,
          fullContextUsedPercent: 125.5,
          contextPanelOpen: true,
        })
      ).toBe('125.5%');
    });
  });
});
