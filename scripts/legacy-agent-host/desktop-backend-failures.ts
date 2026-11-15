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
    if (JSON.stringify(result).length > 4096)
      return { schemaVersion: 1, status: 'unavailable', reason: 'overflow' };
    const observations = own(attachments, 'commentInputObservations');
    const focus = own(observations, 'after one focus click');
    if (!record(focus)) {
      const base: typeof result & { commentInputFocus?: never } = result;
      return base;
    }
    const empty = (field: unknown) => typeof field === 'string' ? field === '' : null;
    const clear = (field: unknown) => field === null ? true : typeof field === 'string' ? false : null;
    const zero = (field: unknown) => {
      const count = integer(field, Number.MAX_SAFE_INTEGER);
      return count === null ? null : count === 0;
    };
    const sameSurface = (probe: unknown) => {
      const actual = text(own(probe, 'ownerSurfaceId')), reference = text(own(probe, 'expectedSurfaceId'));
      return actual !== null && reference !== null ? actual === reference : null;
    };
    const probe = (row: unknown) => ({
      present: boolean(own(row, 'present')), connected: boolean(own(row, 'connected')),
      disabled: boolean(own(row, 'disabled')), focused: boolean(own(row, 'focused')),
      detailPhase: choice(own(row, 'detailPhase'), ['hydrating', 'ready', 'missing', 'deleted', 'provisioning', 'unavailable']),
      refreshPending: boolean(own(row, 'refreshPending')), contextSwitching: boolean(own(row, 'contextSwitching')),
      ownerSurfaceMatchesExpected: sameSurface(row),
    });
    const history = own(observations, 'after one focus click transitions'), historyCount = length(history);
    const transitions = [];
    if (historyCount !== null) for (let index = 0; index < Math.min(historyCount, 12); index++) {
      const row = own(history, String(index)), currentProbe = own(row, 'inputProbe');
      const previousProbe = index === 0 ? missing : own(own(history, String(index - 1)), 'inputProbe');
      const currentRevision = integer(own(currentProbe, 'ownerRevision'), Number.MAX_SAFE_INTEGER);
      const previousRevision = integer(own(previousProbe, 'ownerRevision'), Number.MAX_SAFE_INTEGER);
      transitions.push({ ownerPresent: boolean(own(row, 'ownerPresent')), inputProbe: probe(currentProbe),
        ownerRevisionChangedFromPrevious: currentRevision !== null && previousRevision !== null
          ? currentRevision !== previousRevision : null });
    }
    const owner = own(focus, 'owner');
    const commentInputFocus = {
      source: 'retained-comment-input-observations', stage: 'after-one-focus-click',
      sample: 'last-observed', atomicWithFailure: false,
      ownerPresent: record(owner) ? true : owner === null ? false : null,
      settled: boolean(own(focus, 'settled')), inputEnabled: boolean(own(focus, 'inputEnabled')),
      focused: boolean(own(focus, 'focused')), documentFocused: boolean(own(focus, 'documentFocused')),
      visibility: choice(own(focus, 'visibility'), ['visible', 'hidden']),
      domEmpty: empty(own(focus, 'domValue')), draftEmpty: empty(own(owner, 'commentText')),
      submitPending: boolean(own(owner, 'submitPending')), canSubmit: boolean(own(owner, 'canSubmit')),
      submitErrorClear: clear(own(owner, 'submitError')), attachmentErrorClear: clear(own(owner, 'attachmentError')),
      attachmentsEmpty: zero(own(owner, 'pendingAttachmentCount')), preparationsEmpty: zero(own(owner, 'pendingPreparationCount')),
      inputProbe: probe(own(focus, 'inputProbe')),
      transitionsRecorded: historyCount !== null,
      captureMayBeCapped: historyCount === null ? null : historyCount >= 12,
      extraRetainedRowsOmitted: historyCount === null ? null : historyCount > 12, transitions,
    };
    if (JSON.stringify(commentInputFocus).length > 4096)
      return { schemaVersion: 1, status: 'unavailable', reason: 'overflow' };
    const enriched = { ...result, commentInputFocus };
    return JSON.stringify(enriched).length <= 8192 ? enriched
      : { schemaVersion: 1, status: 'unavailable', reason: 'overflow' };
  } catch { return { schemaVersion: 1, status: 'unavailable', reason: 'projection-failed' }; }
}

/** Project retained installer observations without treating attempts or missing receipts as effects. */
export function projectDesktopCodexInstallerFailure(value: unknown) {
  try {
    const own = (row: unknown, key: string): unknown => {
      if (row === null || typeof row !== 'object') return undefined;
      const field = Object.getOwnPropertyDescriptor(row, key);
      return field && 'value' in field ? field.value : undefined;
    };
    const recorded = (row: unknown) => row === undefined ? null : row !== null && typeof row === 'object' && !Array.isArray(row);
    const text = (field: unknown, maximum: number) => typeof field === 'string' && field.length <= maximum ? field : null;
    const boolean = (field: unknown) => typeof field === 'boolean' ? field : null;
    const choice = (field: unknown, allowed: readonly string[]) =>
      typeof field === 'string' && allowed.includes(field) ? field : null;
    const length = (rows: unknown, maximum: number) => {
      const size = Array.isArray(rows) ? own(rows, 'length') : undefined;
      return typeof size === 'number' && Number.isSafeInteger(size) && size >= 0 && size <= maximum ? size : null;
    };
    const labels: readonly (readonly [string, readonly string[]])[] = [
      ['launch', ['open original saved Team Launch', 'saved model hydrates original Launch',
        'original selected model preflight', 'launch original selection once', 'original Launch closes']],
      ['create', ['original Create launch settings', 'expand original Create launch settings',
        'original expanded Create settings settle', 'original saved Team approval choice', 'select original save-only Create']],
      ['catalog', ['original lead model selector', 'open original lead model selector', 'original Codex catalog', 'select original Codex provider']],
      ['update-notice', ['original measured A to B Update notice', 'original Codex Update notice', 'open original Codex Update dialog']],
      ['update-submit', ['original measured Update action', 'original Codex Update submit', 'install original Codex package exactly once']],
      ['update-ready', ['original installation and Host publication ready', 'close original completed Update dialog', 'original Update completed dialog closes']],
      ['selection', ['one selectable second TEST model', 'original second model', 'select original second model', 'select original High effort', 'High remains selected']],
      ['save', ['original save-only Create action', 'save original second selection once', 'original Create closes']],
      ['reload', ['fresh renderer after reload', 'reloaded original menu']],
      ['settings-menu', ['open original Settings menu after Update']],
      ['settings-open', ['open original Settings after Update']],
      ['settings-providers', ['original Providers settings after Update', 'open original Providers settings after Update',
        'visible original Providers page']],
      ['settings-details', ['original provider details after Update', 'expand original provider details after Update']],
      ['settings-provider-ready', ['original Settings Codex provider is ready after Update']],
      ['settings-manage', ['original Codex Manage after Update', 'open original Codex Manage after Update']],
      ['settings-account-ready', ['original Settings Codex account and runtime healthy']],
      ['settings-manage-close', ['close original Settings Codex Manage']],
      ['stop', ['original Team Stop', 'stop original selected Team once']],
    ];
    const stage = (field: unknown) => labels.find(([, names]) =>
      names.some(name => field === name || field === 'hover ' + name))?.[0] ?? null;
    const message = text(own(value, 'failure'), 4000);
    const methods = ['Runtime.evaluate', 'Runtime.enable', 'Page.enable', 'Page.captureScreenshot',
      'Page.bringToFront', 'Page.reload', 'Input.dispatchMouseEvent', 'Input.dispatchKeyEvent', 'Input.insertText'];
    const method = methods.find(name => message === 'CDP command timed out: ' + name) ?? null;
    const cdpFailure = {
      kind: method !== null ? 'command-timeout' : message === 'CDP connection closed' ? 'connection-closed' :
        message === 'Renderer evaluation failed' ? 'evaluation-failed' : null,
      method,
    };
    let failureSite: { operation: string | null; stage: string | null } = { operation: null, stage: null };
    for (const [selected, names] of labels) for (const name of names) {
      if (message === 'UI read timed out: ' + name + '; no mutation retry')
        failureSite = { operation: 'read-timeout', stage: selected };
      else if (message === 'UI scroll timed out: ' + name + '; no effect retry')
        failureSite = { operation: 'scroll-timeout', stage: selected };
      else if (message !== null && ['', ' after pointer enter', ' stable target'].some(suffix =>
        message.startsWith('UI target read failed: ' + name + suffix + '; facts=')))
        failureSite = { operation: 'target-read', stage: selected };
    }
    const proof = own(value, 'emulatedSelectionUiProof'), steps = own(proof, 'steps'), count = length(steps, 1024);
    const last = [];
    if (count !== null) for (let index = Math.max(0, count - 8); index < count; index++) {
      const row = own(steps, String(index));
      last.push({ action: choice(own(row, 'action'), ['mouseClick', 'mouseWheel', 'mouseMoved']),
        stage: stage(own(row, 'label')), attempted: own(row, 'state') === 'attempted' ? true : null });
    }
    const observations = own(proof, 'observations'), observedCount = length(observations, 128);
    const observed = observedCount ? own(observations, String(observedCount - 1)) : undefined;
    const snapshot = own(value, 'rendererFailureSnapshot'), dialogs = own(snapshot, 'dialogs'), dialogCount = length(dialogs, 3);
    let readyText: boolean | null = dialogCount === null ? null : false;
    if (dialogCount !== null) for (let index = 0; index < dialogCount; index++) {
      const body = text(own(own(dialogs, String(index)), 'text'), 8000);
      if (body === null) { readyText = null; break; }
      readyText ||= body.includes('Codex is ready for new launches.');
    }
    const installer = own(proof, 'installer'), settings = own(installer, 'settings');
    const cleanup = own(value, 'cleanup'), peer = own(value, 'emulatedRuntimeCleanup'), quit = own(value, 'failureQuit');
    const exitCode = own(cleanup, 'appExitCode'), signalCode = own(cleanup, 'appSignalCode');
    const cleanupFailureDescriptor = cleanup !== null && typeof cleanup === 'object'
      ? Object.getOwnPropertyDescriptor(cleanup, 'cleanupFailure') : undefined;
    const cleanupFailure: unknown = cleanupFailureDescriptor && 'value' in cleanupFailureDescriptor
      ? cleanupFailureDescriptor.value : undefined;
    const result = { schemaVersion: 1, status: 'available', source: 'retained-installer-observations', atomicWithFailure: false,
      cdpFailure,
      failureSite, proofRecorded: recorded(proof),
      steps: { count, overflow: Array.isArray(steps) ? count === null : null, last },
      lastLiveObservation: {
        phase: choice(own(observed, 'phase'), ['before-create', 'before-original-installer-update',
          'after-original-installer-ready', 'after-save-only', 'after-reload-before-next-launch', 'after-next-launch',
          'before-original-installer-settings', 'after-original-installer-settings', 'after-b-stop-during-a-input']),
        nativeReady: boolean(own(observed, 'nativeReady')), originalInputsUnchanged: boolean(own(observed, 'originalInputsUnchanged')),
      },
      milestones: { firstRuntimeRecorded: recorded(own(proof, 'a')), savedSelectionRecorded: recorded(own(proof, 'savedSelection')),
        nextRuntimeRecorded: recorded(own(proof, 'b')), completedInstallerReceiptRecorded: recorded(installer) },
      completedInstallerStatus: choice(own(installer, 'status'), ['PASS', 'INCOMPLETE']),
      settingsReceipt: { recorded: recorded(settings), status: choice(own(settings, 'status'), ['PASS', 'INCOMPLETE']) },
      cleanup: {
        recorded: recorded(cleanup), remainingCount: length(own(cleanup, 'remaining'), 256),
        capturedHostObserved: boolean(own(cleanup, 'capturedHostObserved')),
        capturedHostAbsent: boolean(own(cleanup, 'capturedHostAbsent')),
        failureRecorded: typeof cleanupFailure === 'string' ? true :
          recorded(cleanup) === true && cleanupFailure === undefined &&
          (cleanupFailureDescriptor === undefined || 'value' in cleanupFailureDescriptor) ? false : null,
        appExitCodeZero: typeof exitCode === 'number' && Number.isSafeInteger(exitCode) &&
          exitCode >= 0 && exitCode <= 255 ? exitCode === 0 : null,
        appSignalPresent: signalCode === null ? false :
          typeof signalCode === 'string' && signalCode.length > 0 && signalCode.length <= 32 ? true : null,
        peerRecorded: recorded(peer), peerAbsent: boolean(own(peer, 'absent')),
        peerObservationFailed: boolean(own(peer, 'observationFailed')), quitRequested: boolean(own(value, 'quitRequested')),
        failureQuit: { recorded: recorded(quit), attempted: boolean(own(quit, 'attempted')),
          reply: choice(own(quit, 'reply'), ['acknowledged', 'unconfirmed']), listenerAbsent: boolean(own(quit, 'listenerAbsent')) },
      },
      snapshot: { recorded: recorded(snapshot), unavailable: boolean(own(snapshot, 'unavailable')), readyText } };
    return Buffer.byteLength(JSON.stringify(result), 'utf8') <= 4096
      ? result : { schemaVersion: 1, status: 'unavailable', reason: 'overflow' };
  } catch { return { schemaVersion: 1, status: 'unavailable', reason: 'projection-failed' }; }
}

/** The last retained target sample is diagnostic only; it does not establish the refusal's cause. */
export function projectDesktopSelectionTargetFailure(value: unknown) {
  const unavailable = { schemaVersion: 1, status: 'unavailable', reason: 'unrecognized-target-facts' } as const;
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return unavailable;
    const descriptor = Object.getOwnPropertyDescriptor(value, 'failure');
    const message: unknown = descriptor && 'value' in descriptor ? descriptor.value : undefined;
    if (typeof message !== 'string' || message.length > 4000) return unavailable;
    const prefix = 'UI target read failed: select original save-only Create';
    const phases = [['', 'initial'], [' after pointer enter', 'after-pointer-enter'],
      [' stable target', 'stable-target']] as const;
    const phase = phases.find(([suffix]) => message.startsWith(prefix + suffix + '; facts='));
    if (!phase) return unavailable;
    const encoded = message.slice((prefix + phase[0] + '; facts=').length);
    if (encoded.length > 1024) return unavailable;
    const parsed: unknown = JSON.parse(encoded);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return unavailable;
    const facts = parsed as Record<string, unknown>;
    const flags = ['disabled', 'ariaDisabled', 'pointerEventsNone', 'centerInViewport', 'hitPresent'] as const;
    const keys = Object.keys(facts);
    if (keys.length !== 6 || keys.some(key => key !== 'matches' && !flags.some(flag => key === flag)) ||
        typeof facts.matches !== 'number' || !Number.isSafeInteger(facts.matches) ||
        facts.matches < 0 || facts.matches > 256 || flags.some(key => typeof facts[key] !== 'boolean'))
      return unavailable;
    const result = { schemaVersion: 1, status: 'available', source: 'retained-target-read-failure',
      atomicWithFailure: false, site: 'save-only-create', phase: phase[1],
      facts: { matches: facts.matches, disabled: facts.disabled, ariaDisabled: facts.ariaDisabled,
        pointerEventsNone: facts.pointerEventsNone, centerInViewport: facts.centerInViewport, hitPresent: facts.hitPresent } };
    return Buffer.byteLength(JSON.stringify(result), 'utf8') <= 1024 ? result : unavailable;
  } catch { return unavailable; }
}
