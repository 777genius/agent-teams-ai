/**
 * Store test utilities for creating isolated test store instances.
 */

import { create } from 'zustand';

import { createChangeReviewSlice } from '../../../src/renderer/store/slices/changeReviewSlice';
import { createCliInstallerSlice } from '../../../src/renderer/store/slices/cliInstallerSlice';
import { createConfigSlice } from '../../../src/renderer/store/slices/configSlice';
import { createConnectionSlice } from '../../../src/renderer/store/slices/connectionSlice';
import { createContextSlice } from '../../../src/renderer/store/slices/contextSlice';
import { createConversationSlice } from '../../../src/renderer/store/slices/conversationSlice';
import { createEditorSlice } from '../../../src/renderer/store/slices/editorSlice';
import { createNotificationSlice } from '../../../src/renderer/store/slices/notificationSlice';
import { createScheduleSlice } from '../../../src/renderer/store/slices/scheduleSlice';
import { createPaneSlice } from '../../../src/renderer/store/slices/paneSlice';
import { createProjectSlice } from '../../../src/renderer/store/slices/projectSlice';
import { createRepositorySlice } from '../../../src/renderer/store/slices/repositorySlice';
import { createSessionDetailSlice } from '../../../src/renderer/store/slices/sessionDetailSlice';
import { createSessionSlice } from '../../../src/renderer/store/slices/sessionSlice';
import { createSubagentSlice } from '../../../src/renderer/store/slices/subagentSlice';
import { createTabSlice } from '../../../src/renderer/store/slices/tabSlice';
import { createTabUISlice } from '../../../src/renderer/store/slices/tabUISlice';
import { createTeamSlice } from '../../../src/renderer/store/slices/teamSlice';
import { createUISlice } from '../../../src/renderer/store/slices/uiSlice';
import { createUpdateSlice } from '../../../src/renderer/store/slices/updateSlice';

import type { AppState } from '../../../src/renderer/store/types';

/**
 * Create an isolated store instance for testing.
 * Each test gets a fresh store with no shared state.
 */
export function createTestStore() {
  return create<AppState>()((...args) => ({
    ...createProjectSlice(...args),
    ...createRepositorySlice(...args),
    ...createSessionSlice(...args),
    ...createSessionDetailSlice(...args),
    ...createSubagentSlice(...args),
    ...createTeamSlice(...args),
    ...createConversationSlice(...args),
    ...createTabSlice(...args),
    ...createTabUISlice(...args),
    ...createPaneSlice(...args),
    ...createUISlice(...args),
    ...createNotificationSlice(...args),
    ...createConfigSlice(...args),
    ...createConnectionSlice(...args),
    ...createContextSlice(...args),
    ...createUpdateSlice(...args),
    ...createChangeReviewSlice(...args),
    ...createCliInstallerSlice(...args),
    ...createEditorSlice(...args),
    ...createScheduleSlice(...args),
  }));
}

export type TestStore = ReturnType<typeof createTestStore>;
