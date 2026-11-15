/** Diagnostics only: no raw message, values, environment, causes or outside-source stack. */
export function projectDesktopHarnessFailure(value: unknown, repository: string, sources: readonly string[]): {
  kind: 'assertion' | 'error' | 'unclassified'; frames: string[];
} {
  try {
    if (!(value instanceof Error)) return { kind: 'unclassified', frames: [] };
    const prefix = repository.replaceAll('\\', '/').replace(/\/+$/u, '') + '/';
    const allowed = new Set(sources.filter(path =>
      /^(?:scripts\/legacy-agent-host\/|packages\/legacy-agent-host\/(?:src|dist|tests)\/)[A-Za-z0-9._/-]+\.(?:[cm]?[jt]s)$/u.test(path) &&
      !path.split('/').some(part => part === '.' || part === '..')));
    const frames: string[] = [];
    for (const line of (typeof value.stack === 'string' ? value.stack.slice(0, 16 * 1024) : '').split('\n').slice(1, 40)) {
      if (!/^\s+at /u.test(line)) continue;
      const frameText = line.trimStart().slice(3).replaceAll('\\', '/');
      const boundary = frameText.lastIndexOf(' (');
      let location = boundary >= 0 && frameText.endsWith(')')
        ? frameText.slice(boundary + 2, -1) : frameText.replace(/^async /u, '');
      location = location.replace(/^file:\/\//u, '');
      if (/^[A-Za-z]:\//u.test(prefix) && /^\/[A-Za-z]:\//u.test(location)) location = location.slice(1);
      if (!location.startsWith(prefix)) continue;
      const match = /^(.+):([1-9]\d{0,5}):([1-9]\d{0,5})$/u.exec(location.slice(prefix.length));
      if (!match || !allowed.has(match[1]!)) continue;
      const frame = match[1] + ':' + match[2] + ':' + match[3];
      if (!frames.includes(frame)) frames.push(frame);
      if (frames.length === 6) break;
    }
    return { kind: value.name === 'AssertionError' ? 'assertion' : 'error', frames };
  } catch { return { kind: 'unclassified', frames: [] }; }
}

/** Retained observations only; this projection neither advances nor diagnoses the original flow. */
export function projectDesktopMixedSettingsFailure(value: unknown) {
  try {
    const missing = Symbol('missing'), invalid = Symbol('invalid');
    const record = (row: unknown): row is Record<string, unknown> =>
      row !== null && typeof row === 'object' && !Array.isArray(row);
    const own = (row: unknown, key: string): unknown => {
      if (row === null || typeof row !== 'object') return missing;
      const field = Object.getOwnPropertyDescriptor(row, key);
      return field ? ('value' in field ? field.value : invalid) : missing;
    };
    const present = (row: unknown) => row === missing || row === undefined ? false : record(row) ? true : null;
    const boolean = (field: unknown) => typeof field === 'boolean' ? field : null;
    const integer = (field: unknown, max: number) =>
      typeof field === 'number' && Number.isSafeInteger(field) && field >= 0 && field <= max ? field : null;
    const choice = (field: unknown, allowed: readonly string[]) =>
      typeof field === 'string' && allowed.includes(field) ? field : null;
    const length = (rows: unknown, max: number) => Array.isArray(rows) ? integer(own(rows, 'length'), max) : null;
    const status = (row: unknown) => choice(own(row, 'status'), ['PASS', 'INCOMPLETE', 'UNKNOWN']);
    const stages: Record<string, string> = {
      'original menu for Settings': 'settings-menu',
      'original Settings': 'settings-open',
      'original Providers page': 'settings-providers',
      'original OpenCode Manage': 'settings-manage',
      'original Models tab': 'settings-models',
      'original project context': 'settings-project-context',
      'select original TEST project': 'settings-project-select',
      'Change: Default model': 'settings-global-change',
      'Use another model: This project: workspace': 'settings-project-change',
      'original configured provider': 'settings-provider',
      'expand original configured provider': 'settings-provider-expand',
      'select and verify original global default': 'settings-global-select',
      'select and verify original project default': 'settings-project-model-select',
      'Test the original project model once': 'settings-project-test',
      'clear original project override once': 'settings-project-clear',
      'close original Settings': 'settings-close',
      'close original member JSON': 'member-json-close',
      'expand original Carol model': 'member-model-expand',
      'temporarily select A through the existing model control': 'member-model-select',
      'original context limit': 'member-context-limit',
      'original output limit': 'member-output-limit',
      'Apply and verify original limits once': 'member-limits-apply',
      'restore original inherited Default before saving': 'member-default-restore',
      'collapse original Carol model': 'member-model-collapse',
      'Create the original saved3-member roster once': 'create-save',
      'open existing EditTeamDialog': 'edit-open',
      'save original Edit intent once': 'edit-save',
      'reopen existing EditTeamDialog after reload': 'edit-reopen',
      'open original mixed Launch dialog': 'launch-open',
      'reopen original mixed Launch before Submit': 'launch-reopen',
      'submit original mixed Launch once with successful captured readiness': 'launch-submit',
      'original whole Team Stop once': 'team-stop',
    };
    const mixed = own(value, 'mixedCreateLaunchProof'), settings = own(mixed, 'providerSettings');
    const cold = own(value, 'coldSettingsBoundary'), steps = own(mixed, 'steps');
    const total = length(steps, 0xffffffff), count = total !== null && total <= 1024 ? total : null;
    const last: { stage: string; action: string | null; attempted: boolean | null }[] | null = count === null ? null : [];
    if (last && count !== null) for (let index = Math.max(0, count - 8); index < count; index++) {
      const row = own(steps, String(index)), label = own(row, 'label');
      const stage = typeof label === 'string' ? own(stages, label) : missing;
      last.push({
        stage: typeof stage === 'string' ? stage : 'other',
        action: choice(own(row, 'action'), ['mouseMoved', 'mouseClick', 'mouseWheel']),
        attempted: own(row, 'state') === 'attempted' ? true : null,
      });
    }
    const settingsSteps = () => {
      const rows = own(settings, 'steps'), size = length(rows, 4), seen = new Set<string>();
      if (size === null) return null;
      const result: { step: string; phase: 'completed'; resourceHeld: boolean }[] = [];
      for (let index = 0; index < size; index++) {
        const row = own(rows, String(index));
        const step = choice(own(row, 'step'), ['global-default', 'project-default', 'project-test', 'local-limits']);
        const held = boolean(own(row, 'resourceHeld'));
        if (!record(row) || step === null || seen.has(step) || own(row, 'phase') !== 'completed' || held === null) return null;
        seen.add(step);
        result.push({ step, phase: 'completed', resourceHeld: held });
      }
      return result;
    };
    const cleanup = (row: unknown) => {
      if (!record(row)) return null;
      const failure = own(row, 'cleanupFailure');
      return {
        remaining: length(own(row, 'remaining'), 256),
        appExitCode: integer(own(row, 'appExitCode'), 255),
        appSignalCode: choice(own(row, 'appSignalCode'), [
          'SIGABRT', 'SIGALRM', 'SIGBUS', 'SIGCHLD', 'SIGCONT', 'SIGFPE', 'SIGHUP', 'SIGILL', 'SIGINT',
          'SIGIO', 'SIGKILL', 'SIGPIPE', 'SIGPROF', 'SIGQUIT', 'SIGSEGV', 'SIGSTOP', 'SIGSYS', 'SIGTERM',
          'SIGTRAP', 'SIGTSTP', 'SIGTTIN', 'SIGTTOU', 'SIGURG', 'SIGUSR1', 'SIGUSR2', 'SIGVTALRM',
          'SIGWINCH', 'SIGXCPU', 'SIGXFSZ',
        ]),
        capturedHostAbsent: boolean(own(row, 'capturedHostAbsent')),
        writerLockReleased: boolean(own(row, 'writerLockReleased')),
        failureRecorded: typeof failure === 'string' ? true : failure === missing || failure === undefined ? false : null,
      };
    };
    const result = {
      schemaVersion: 1, status: 'available',
      mixedRecorded: present(mixed), settingsRecorded: present(settings), coldRecorded: present(cold),
      generation: choice(own(mixed, 'openCodeGeneration'), ['v1', 'v2']),
      proofStatus: status(mixed), settingsStatus: status(settings), coldStatus: status(cold),
      uiSteps: { count, overflow: total === null ? null : total > 1024, last },
      settingsSteps: settingsSteps(),
      milestones: {
        projectOverrideRecorded: present(own(settings, 'projectOverride')),
        clearedProjectRecorded: present(own(settings, 'clearedProject')),
        defaultBeforeSaveRecorded: present(own(settings, 'defaultBeforeSave')),
        createdRecorded: present(own(mixed, 'created')),
        nativeCaptureRecorded: present(own(settings, 'nativeCapture')),
      },
      originalSettingsOwnersReleased: boolean(own(settings, 'originalSettingsOwnersReleased')),
      sameSettingsAfterCold: boolean(own(settings, 'sameSettingsAfterCold')),
      successorOwnersReleased: boolean(own(settings, 'successorOwnersReleased')),
      quitAttempted: boolean(own(own(cold, 'firstQuit'), 'attempted')),
      secondEpochRecorded: present(own(cold, 'secondEpoch')),
      cleanup: {
        first: cleanup(own(cold, 'firstCleanup')),
        second: cleanup(own(cold, 'secondCleanup')),
        final: cleanup(own(value, 'cleanup')),
      },
    };
    return Buffer.byteLength(JSON.stringify(result), 'utf8') <= 4096
      ? result : { schemaVersion: 1, status: 'unavailable', reason: 'overflow' };
  } catch { return { schemaVersion: 1, status: 'unavailable', reason: 'projection-failed' }; }
}

/** Existing Taskboard failure observations only; no new read, input, retry or ownership decision. */
export function projectDesktopTaskBoardFailure(value: unknown) {
  try {
    const missing = Symbol('missing');
    const own = (row: unknown, key: string): unknown => {
      if (row === null || typeof row !== 'object') return missing;
      const field = Object.getOwnPropertyDescriptor(row, key);
      return field && 'value' in field ? field.value : missing;
    };
    const record = (row: unknown) => row !== null && typeof row === 'object' && !Array.isArray(row);
    const text = (field: unknown, maximum = 1024) =>
      typeof field === 'string' && field.length > 0 && field.length <= maximum ? field : null;
    const boolean = (field: unknown) => typeof field === 'boolean' ? field : null;
    const integer = (field: unknown, maximum: number) =>
      typeof field === 'number' && Number.isSafeInteger(field) && field >= 0 && field <= maximum ? field : null;
    const choice = (field: unknown, allowed: readonly string[]) =>
      typeof field === 'string' && allowed.includes(field) ? field : null;
    const length = (rows: unknown) => Array.isArray(rows) ? integer(own(rows, 'length'), 0xffffffff) : null;
    const terms = (field: unknown) => {
      if (typeof field !== 'string') return { recorded: false, bounded: null, terms: [] as string[] };
      if (field.length > 8000) return { recorded: true, bounded: false, terms: [] as string[] };
      const lower = field.toLowerCase();
      return { recorded: true, bounded: true, terms: ['loading', 'not found', 'unavailable', 'deleted',
        'provisioning', 'read-only', 'comments', 'attachments', 'retry'].filter(term => lower.includes(term)) };
    };
    // Decode only the already observed, canonical TaskCommentInput ID format.
    // These comparisons are diagnostics, never a replacement for the current React owner check.
    const input = (field: unknown): { surface: string; identity: string } | null => {
      const id = text(field, 8192), prefix = 'task-comment-input-';
      if (!id?.startsWith(prefix)) return null;
      try {
        const encoded = id.slice(prefix.length), parsed: unknown = JSON.parse(decodeURIComponent(encoded));
        if (!Array.isArray(parsed) || parsed.length !== 2 || !text(parsed[0]) || !text(parsed[1], 4096) ||
            encodeURIComponent(JSON.stringify(parsed)) !== encoded) return null;
        return { surface: parsed[0] as string, identity: parsed[1] as string };
      } catch { return null; }
    };
    const board = own(value, 'taskBoardUiProof'), attachments = own(board, 'attachments');
    const submitted = own(attachments, 'commentComposerCompleted'), identity = own(submitted, 'identity');
    const context = text(own(identity, 'contextId')), team = text(own(identity, 'teamName'));
    const task = text(own(identity, 'taskId')), surface = text(own(submitted, 'surfaceId'));
    const originalInput = input(own(submitted, 'inputId'));
    const expected = context !== null && team !== null && task !== null && surface !== null &&
      own(submitted, 'teamName') === team && own(submitted, 'taskId') === task &&
      own(own(own(board, 'createReceipt'), 'effects'), 'taskId') === task &&
      originalInput !== null && originalInput.surface === surface && originalInput.identity === JSON.stringify([context, team, task]);
    const matches = (field: unknown, original: string | null) =>
      expected && text(field) !== null && original !== null ? field === original : null;
    const snapshot = own(value, 'rendererFailureSnapshot'), store = own(snapshot, 'store');
    const global = own(store, 'globalTaskDetail'), composer = own(snapshot, 'commandComposer');
    const single = own(composer, 'single'), dialogRows = own(snapshot, 'dialogs'), dialogCount = length(dialogRows);
    const dialogs = [];
    if (dialogCount !== null) for (let index = 0; index < Math.min(dialogCount, 3); index++)
      dialogs.push(terms(own(own(dialogRows, String(index)), 'text')));
    const eventRows = own(snapshot, 'inputEvents'), eventCount = length(eventRows);
    const events = [];
    if (eventCount !== null) for (let index = Math.max(0, eventCount - 8); index < eventCount; index++) {
      const row = own(eventRows, String(index));
      const observed = input(own(own(row, 'target'), 'id')) ??
        input(own(own(row, 'focusAfterDispatch'), 'id')) ?? input(own(own(row, 'focusAfterMicrotask'), 'id'));
      events.push({ type: choice(own(row, 'type'), ['pointerdown', 'pointerup', 'click', 'focusin', 'focusout', 'keydown', 'keyup']),
        trusted: boolean(own(row, 'trusted')), cardTaskMatchesOriginal: matches(own(row, 'taskId'), task),
        inputRecorded: observed !== null, ownerTaskContextMatchesOriginal: expected && observed
          ? observed.identity === originalInput!.identity : null,
        sameOriginalSurface: expected && observed ? observed.surface === surface : null });
    }
    const cardRows = own(snapshot, 'visibleTaskCardIds'), cardCount = length(cardRows);
    let originalTaskCardObserved: boolean | null = expected && cardCount !== null ? false : null;
    if (expected && cardCount !== null) for (let index = 0; index < Math.min(cardCount, 24); index++)
      if (own(cardRows, String(index)) === task) originalTaskCardObserved = true;
    const result = { schemaVersion: 1, status: 'available', source: 'retained-failure-snapshot', atomicWithFailure: false,
      original: { submittedRecorded: record(submitted), identityConsistent: expected,
        commentReceiptCompleted: own(own(attachments, 'commentReceipt'), 'phase') === 'completed',
        submittedEmpty: typeof own(submitted, 'commentText') === 'string' ? own(submitted, 'commentText') === '' : null,
        submitPending: boolean(own(submitted, 'submitPending')) },
      snapshotRecorded: record(snapshot), snapshotUnavailable: boolean(own(snapshot, 'unavailable')),
      documentFocused: boolean(own(snapshot, 'documentFocused')),
      visibility: choice(own(snapshot, 'visibility'), ['visible', 'hidden']),
      selectedTeamMatchesOriginal: matches(own(store, 'selectedTeamName'), team),
      selectedTeamError: terms(own(store, 'selectedTeamError')), globalTaskRecorded: record(global),
      globalTeamMatchesOriginal: matches(own(global, 'teamName'), team),
      globalTaskMatchesOriginal: matches(own(global, 'taskId'), task), originalTaskCardObserved,
      dialogs: { count: dialogCount === null ? null : Math.min(dialogCount, 4),
        overflow: dialogCount === null ? null : dialogCount > 3, items: dialogs },
      composer: { recorded: record(composer), textareaCount: integer(own(composer, 'textareaCount'), 5),
        textareaOverflow: boolean(own(composer, 'textareaOverflow')), singleRecorded: record(single),
        disabled: boolean(own(single, 'disabled')), focused: boolean(own(single, 'focused')),
        readOnly: boolean(own(single, 'readOnly')), connected: boolean(own(single, 'connected')) },
      inputEvents: { count: eventCount === null ? null : Math.min(eventCount, 97),
        overflow: eventCount === null ? null : eventCount > 96, last: events } };
    return JSON.stringify(result).length <= 4096 ? result : { schemaVersion: 1, status: 'unavailable', reason: 'overflow' };
  } catch { return { schemaVersion: 1, status: 'unavailable', reason: 'projection-failed' }; }
}
