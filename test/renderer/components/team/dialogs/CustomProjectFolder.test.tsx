import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { CustomProjectFolderNotice } from '@renderer/components/team/dialogs/CustomProjectFolderNotice';
import { getCustomProjectFolderNotice } from '@renderer/components/team/dialogs/customProjectFolderNoticeModel';
import {
  type CustomProjectFolderModel,
  useCustomProjectFolder,
} from '@renderer/components/team/dialogs/useCustomProjectFolder';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { TeamProviderId } from '@shared/types';

const getStateMock = vi.fn();
const createMock = vi.fn();
const invalidateCatalogMock = vi.fn();
const fetchCliProviderStatusMock = vi.fn();

vi.mock('@renderer/api', () => ({
  api: {
    projectFolder: {
      getState: (request: unknown) => getStateMock(request),
      create: (request: unknown) => createMock(request),
    },
  },
}));

vi.mock('@renderer/store', () => ({
  useStore: (selector: (state: unknown) => unknown) =>
    selector({
      invalidateCliProviderModelCatalog: invalidateCatalogMock,
      fetchCliProviderStatus: fetchCliProviderStatusMock,
    }),
}));

function model(overrides: Partial<CustomProjectFolderModel>): CustomProjectFolderModel {
  return {
    path: '/tmp/new-project',
    status: 'missing',
    checking: false,
    creating: false,
    createError: null,
    create: vi.fn().mockResolvedValue(true),
    createsMissingOnSubmit: true,
    requiredBeforeSubmit: false,
    blocksSubmit: false,
    ...overrides,
  };
}

async function render(element: React.ReactElement): Promise<{
  host: HTMLDivElement;
  rerender: (next: React.ReactElement) => Promise<void>;
  unmount: () => Promise<void>;
}> {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(element);
    await Promise.resolve();
  });
  return {
    host,
    rerender: async (next) => {
      await act(async () => {
        root.render(next);
        await Promise.resolve();
      });
    },
    unmount: async () => {
      await act(async () => {
        root.unmount();
        await Promise.resolve();
      });
    },
  };
}

describe('custom project folder notice model', () => {
  it('only promises creation on submit where the dialog really creates the folder', () => {
    expect(
      getCustomProjectFolderNotice({
        status: 'missing',
        createsMissingOnSubmit: true,
        requiredBeforeSubmit: false,
      })
    ).toEqual({ tone: 'muted', message: 'folder.missingCreatedOnSubmit', canCreate: true });
    expect(
      getCustomProjectFolderNotice({
        status: 'missing',
        createsMissingOnSubmit: false,
        requiredBeforeSubmit: false,
      })
    ).toEqual({ tone: 'error', message: 'folder.missingMustExist', canCreate: true });
    expect(
      getCustomProjectFolderNotice({
        status: 'unknown',
        createsMissingOnSubmit: false,
        requiredBeforeSubmit: false,
      })
    ).toBeNull();
    expect(
      getCustomProjectFolderNotice({
        status: 'exists',
        createsMissingOnSubmit: true,
        requiredBeforeSubmit: true,
      })
    ).toBeNull();
  });

  it('asks for the folder up front when OpenCode needs it for preflight', () => {
    expect(
      getCustomProjectFolderNotice({
        status: 'missing',
        createsMissingOnSubmit: true,
        requiredBeforeSubmit: true,
      })
    ).toEqual({ tone: 'warning', message: 'folder.missingRequiredBeforeCreate', canCreate: true });
  });
});

describe('CustomProjectFolderNotice', () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it('explains why OpenCode needs the folder now and creates it on click', async () => {
    const folder = model({ requiredBeforeSubmit: true });
    const { host, unmount } = await render(<CustomProjectFolderNotice folder={folder} />);

    expect(host.textContent).toContain(
      'This folder does not exist yet. OpenCode checks models inside the project folder, so create it first.'
    );
    expect(host.textContent).not.toContain('created automatically');
    const button = host.querySelector('button');
    expect(button?.textContent).toBe('Create folder');
    await act(async () => {
      button?.click();
      await Promise.resolve();
    });
    expect(folder.create).toHaveBeenCalledTimes(1);

    await unmount();
  });

  it('shows the create failure reason', async () => {
    const { host, unmount } = await render(
      <CustomProjectFolderNotice folder={model({ createError: 'permission_denied' })} />
    );

    expect(host.querySelector('[role="alert"]')?.textContent).toBe(
      'Could not create the folder: permission denied.'
    );

    await unmount();
  });
});

function Probe(props: {
  path: string;
  createsMissingOnSubmit: boolean;
  providerIds: TeamProviderId[];
  invalidatePrepareProvider: (providerId: TeamProviderId) => void;
  onModel: (model: CustomProjectFolderModel) => void;
}): null {
  const folder = useCustomProjectFolder({ enabled: true, ...props });
  props.onModel(folder);
  return null;
}

describe('useCustomProjectFolder', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    getStateMock.mockReset();
    createMock.mockReset();
    invalidateCatalogMock.mockReset();
    fetchCliProviderStatusMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.replaceChildren();
  });

  it('blocks Launch for a missing folder and refreshes provider checks after creating it', async () => {
    getStateMock.mockResolvedValue({ state: 'missing' });
    createMock.mockResolvedValue({ state: 'exists' });
    const invalidatePrepareProvider = vi.fn();
    let latest: CustomProjectFolderModel | null = null;
    const props = {
      path: ' /tmp/new-project ',
      createsMissingOnSubmit: false,
      providerIds: ['anthropic', 'opencode'] as TeamProviderId[],
      invalidatePrepareProvider,
      onModel: (next: CustomProjectFolderModel) => {
        latest = next;
      },
    };
    const { unmount } = await render(<Probe {...props} />);

    expect(latest!.status).toBe('checking');
    expect(latest!.blocksSubmit).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(getStateMock).toHaveBeenCalledWith({ path: '/tmp/new-project' });
    expect(latest!.status).toBe('missing');
    expect(latest!.blocksSubmit).toBe(true);
    expect(latest!.requiredBeforeSubmit).toBe(true);

    let created = false;
    await act(async () => {
      created = await latest!.create();
    });
    expect(created).toBe(true);
    expect(createMock).toHaveBeenCalledWith({ path: '/tmp/new-project' });
    expect(latest!.status).toBe('exists');
    expect(latest!.blocksSubmit).toBe(false);
    expect(invalidateCatalogMock).toHaveBeenCalledTimes(1);
    expect(fetchCliProviderStatusMock).toHaveBeenCalledWith('opencode', {
      silent: true,
      checkReason: 'launch_preflight',
      projectPath: '/tmp/new-project',
    });
    expect(invalidatePrepareProvider.mock.calls).toEqual([['anthropic'], ['opencode']]);

    await unmount();
  });

  it('does not refresh provider checks when creation fails', async () => {
    getStateMock.mockResolvedValue({ state: 'missing' });
    createMock.mockResolvedValue({ state: 'missing', error: 'permission_denied' });
    const invalidatePrepareProvider = vi.fn();
    let latest: CustomProjectFolderModel | null = null;
    const { unmount } = await render(
      <Probe
        path="/tmp/locked/new-project"
        createsMissingOnSubmit
        providerIds={['opencode']}
        invalidatePrepareProvider={invalidatePrepareProvider}
        onModel={(next) => {
          latest = next;
        }}
      />
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });

    await act(async () => {
      await latest!.create();
    });
    expect(latest!.createError).toBe('permission_denied');
    expect(latest!.blocksSubmit).toBe(false);
    expect(invalidateCatalogMock).not.toHaveBeenCalled();
    expect(invalidatePrepareProvider).not.toHaveBeenCalled();

    await unmount();
  });

  it('keeps Launch blocked while a typed custom path is still being checked', async () => {
    getStateMock.mockResolvedValue({ state: 'exists' });
    const invalidatePrepareProvider = vi.fn();
    let latest: CustomProjectFolderModel | null = null;
    const props = {
      createsMissingOnSubmit: false,
      providerIds: ['anthropic'] as TeamProviderId[],
      invalidatePrepareProvider,
      onModel: (next: CustomProjectFolderModel) => {
        latest = next;
      },
    };
    const { rerender, unmount } = await render(<Probe path="/tmp/existing-project" {...props} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(latest!.status).toBe('exists');
    expect(latest!.blocksSubmit).toBe(false);

    getStateMock.mockResolvedValue({ state: 'missing' });
    await rerender(<Probe path="/tmp/gone-project" {...props} />);
    expect(latest!.checking).toBe(true);
    expect(latest!.blocksSubmit).toBe(true);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(latest!.status).toBe('missing');
    expect(latest!.blocksSubmit).toBe(true);

    await unmount();
  });
});
