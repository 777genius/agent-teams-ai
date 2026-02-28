import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  getNonEmptyCategories,
  groupSessionsByDate,
} from '../../../src/renderer/utils/dateGrouping';
import type { Session } from '../../../src/renderer/types/data';

// Helper to create a session with a specific date
function createSession(id: string, createdAt: Date): Session {
  return {
    id,
    projectId: 'test-project',
    projectPath: '/test',
    createdAt: createdAt.getTime(),
    hasSubagents: false,
    messageCount: 1,
  };
}

describe('dateGrouping', () => {
  beforeEach(() => {
    // Mock current date to 2024-01-15 12:00:00
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-15T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('groupSessionsByDate', () => {
    it('should group session from today', () => {
      const today = new Date('2024-01-15T10:00:00Z');
      const sessions = [createSession('1', today)];

      const result = groupSessionsByDate(sessions);

      expect(result.Today).toHaveLength(1);
      expect(result.Yesterday).toHaveLength(0);
      expect(result['Previous 7 Days']).toHaveLength(0);
      expect(result.Older).toHaveLength(0);
    });

    it('should group session from yesterday', () => {
      const yesterday = new Date('2024-01-14T10:00:00Z');
      const sessions = [createSession('1', yesterday)];

      const result = groupSessionsByDate(sessions);

      expect(result.Today).toHaveLength(0);
      expect(result.Yesterday).toHaveLength(1);
      expect(result['Previous 7 Days']).toHaveLength(0);
      expect(result.Older).toHaveLength(0);
    });

    it('should group session from 3 days ago to Previous 7 Days', () => {
      const threeDaysAgo = new Date('2024-01-12T10:00:00Z');
      const sessions = [createSession('1', threeDaysAgo)];

      const result = groupSessionsByDate(sessions);

      expect(result.Today).toHaveLength(0);
      expect(result.Yesterday).toHaveLength(0);
      expect(result['Previous 7 Days']).toHaveLength(1);
      expect(result.Older).toHaveLength(0);
    });

    it('should group session from 10 days ago to Older', () => {
      const tenDaysAgo = new Date('2024-01-05T10:00:00Z');
      const sessions = [createSession('1', tenDaysAgo)];

      const result = groupSessionsByDate(sessions);

      expect(result.Today).toHaveLength(0);
      expect(result.Yesterday).toHaveLength(0);
      expect(result['Previous 7 Days']).toHaveLength(0);
      expect(result.Older).toHaveLength(1);
    });

    it('should distribute multiple sessions to correct groups', () => {
      const sessions = [
        createSession('1', new Date('2024-01-15T10:00:00Z')), // Today
        createSession('2', new Date('2024-01-15T08:00:00Z')), // Today
        createSession('3', new Date('2024-01-14T10:00:00Z')), // Yesterday
        createSession('4', new Date('2024-01-12T10:00:00Z')), // Previous 7 Days
        createSession('5', new Date('2024-01-01T10:00:00Z')), // Older
      ];

      const result = groupSessionsByDate(sessions);

      expect(result.Today).toHaveLength(2);
      expect(result.Yesterday).toHaveLength(1);
      expect(result['Previous 7 Days']).toHaveLength(1);
      expect(result.Older).toHaveLength(1);
    });

    it('should handle empty sessions array', () => {
      const result = groupSessionsByDate([]);

      expect(result.Today).toHaveLength(0);
      expect(result.Yesterday).toHaveLength(0);
      expect(result['Previous 7 Days']).toHaveLength(0);
      expect(result.Older).toHaveLength(0);
    });

    it('should maintain order within groups', () => {
      const sessions = [
        createSession('first', new Date('2024-01-15T08:00:00Z')),
        createSession('second', new Date('2024-01-15T10:00:00Z')),
        createSession('third', new Date('2024-01-15T12:00:00Z')),
      ];

      const result = groupSessionsByDate(sessions);

      expect(result.Today.map((s) => s.id)).toEqual(['first', 'second', 'third']);
    });
  });

  describe('getNonEmptyCategories', () => {
    it('should return only non-empty categories', () => {
      const grouped = {
        Today: [createSession('1', new Date())],
        Yesterday: [],
        'Previous 7 Days': [createSession('2', new Date())],
        Older: [],
      };

      const result = getNonEmptyCategories(grouped);

      expect(result).toEqual(['Today', 'Previous 7 Days']);
    });

    it('should return categories in display order', () => {
      const grouped = {
        Today: [createSession('1', new Date())],
        Yesterday: [createSession('2', new Date())],
        'Previous 7 Days': [createSession('3', new Date())],
        Older: [createSession('4', new Date())],
      };

      const result = getNonEmptyCategories(grouped);

      expect(result).toEqual(['Today', 'Yesterday', 'Previous 7 Days', 'Older']);
    });

    it('should return empty array when all categories are empty', () => {
      const grouped = {
        Today: [],
        Yesterday: [],
        'Previous 7 Days': [],
        Older: [],
      };

      const result = getNonEmptyCategories(grouped);

      expect(result).toEqual([]);
    });
  });
});
