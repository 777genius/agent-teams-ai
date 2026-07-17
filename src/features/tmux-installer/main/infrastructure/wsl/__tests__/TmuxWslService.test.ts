import { describe, expect, it } from 'vitest';

import { TmuxWslService } from '../TmuxWslService';

function createPreferenceStore(initialPreferredDistro: string | null = null): {
  getPreferredDistro: () => Promise<string | null>;
  getPreferredDistroSync: () => string | null;
  setPreferredDistro: (preferredDistroName: string) => Promise<void>;
  clearPreferredDistro: () => Promise<void>;
} {
  let preferredDistro = initialPreferredDistro;
  return {
    async getPreferredDistro() {
      return preferredDistro;
    },
    getPreferredDistroSync() {
      return preferredDistro;
    },
    async setPreferredDistro(nextPreferredDistroName: string) {
      preferredDistro = nextPreferredDistroName;
    },
    async clearPreferredDistro() {
      preferredDistro = null;
    },
  };
}

function createExecFileMock(
  handlers: Record<
    string,
    { error?: NodeJS.ErrnoException | null; stdout?: string | Buffer; stderr?: string | Buffer }
  >
): (
  command: string,
  args: string[],
  options: {
    timeout: number;
    windowsHide: boolean;
    maxBuffer: number;
    encoding: 'buffer';
  },
  callback: (error: Error | null, stdout: string | Buffer, stderr: string | Buffer) => void
) => void {
  return (_command, args, _options, callback) => {
    const key = args.join(' ');
    const result = handlers[key];
    if (!result) {
      const error = new Error(`Unexpected WSL command: ${key}`) as NodeJS.ErrnoException;
      error.code = 'EFAIL';
      callback(error, '', '');
      return;
    }
    callback(result.error ?? null, result.stdout ?? '', result.stderr ?? '');
  };
}

describe('TmuxWslService', () => {
  it('reports missing WSL when status and list commands both fail', async () => {
    const service = new TmuxWslService(
      createExecFileMock({
        '--status': {
          error: Object.assign(new Error('wsl missing'), { code: 'EFAIL' }),
          stderr: 'WSL is not installed',
        },
        '--list --quiet': {
          error: Object.assign(new Error('wsl missing'), { code: 'EFAIL' }),
          stderr: 'WSL is not installed',
        },
      }),
      createPreferenceStore() as never
    );

    const result = await service.probe();

    expect(result.status.wslInstalled).toBe(false);
    expect(result.status.statusDetail).toContain('WSL');
    expect(result.preference).toBeNull();
  });

  it('detects a bootstrapped Ubuntu distro with tmux available', async () => {
    const service = new TmuxWslService(
      createExecFileMock({
        '--status': { stdout: 'Default Distribution: Ubuntu\nDefault Version: 2\n' },
        '--list --quiet': { stdout: 'Ubuntu\n' },
        '--list --verbose': { stdout: '* Ubuntu    Running    2\n' },
        '-d Ubuntu -- sh -lc printf ready': { stdout: 'ready' },
        '-d Ubuntu -- sh -lc . /etc/os-release >/dev/null 2>&1 && printf %s "$ID"': {
          stdout: 'ubuntu',
        },
        '-d Ubuntu -- sh -lc command -v tmux >/dev/null 2>&1 && { tmux -V; printf "\\n"; command -v tmux; }':
          {
            stdout: 'tmux 3.4\n/usr/bin/tmux\n',
          },
      }),
      createPreferenceStore() as never
    );

    const result = await service.probe();

    expect(result.preference?.preferredDistroName).toBe('Ubuntu');
    expect(result.status.wslInstalled).toBe(true);
    expect(result.status.distroName).toBe('Ubuntu');
    expect(result.status.distroVersion).toBe(2);
    expect(result.status.distroBootstrapped).toBe(true);
    expect(result.status.innerPackageManager).toBe('apt');
    expect(result.status.tmuxAvailableInsideWsl).toBe(true);
    expect(result.status.tmuxVersion).toBe('tmux 3.4');
    expect(result.status.tmuxBinaryPath).toBe('/usr/bin/tmux');
  });

  it('does not target Docker Desktop when it is the only WSL distribution', async () => {
    const service = new TmuxWslService(
      createExecFileMock({
        '--status': { stdout: 'Default Distribution: docker-desktop\nDefault Version: 2\n' },
        '--list --quiet': { stdout: 'docker-desktop\n' },
      }),
      createPreferenceStore() as never
    );

    const result = await service.probe();

    expect(result.preference).toBeNull();
    expect(result.status.wslInstalled).toBe(true);
    expect(result.status.distroName).toBeNull();
    expect(result.status.distroBootstrapped).toBe(false);
    expect(result.status.innerPackageManager).toBeNull();
    expect(result.status.tmuxAvailableInsideWsl).toBe(false);
    expect(result.status.statusDetail).toContain('only service distributions');
    expect(result.status.statusDetail).toContain('docker-desktop');
  });

  it('ignores a service default distro and targets the only user distro', async () => {
    const service = new TmuxWslService(
      createExecFileMock({
        '--status': { stdout: 'Default Distribution: docker-desktop\nDefault Version: 2\n' },
        '--list --quiet': { stdout: 'docker-desktop\nUbuntu\n' },
        '--list --verbose': {
          stdout: '* docker-desktop    Running    2\n  Ubuntu    Stopped    2\n',
        },
        '-d Ubuntu -- sh -lc printf ready': { stdout: 'ready' },
        '-d Ubuntu -- sh -lc . /etc/os-release >/dev/null 2>&1 && printf %s "$ID"': {
          stdout: 'ubuntu',
        },
        '-d Ubuntu -- sh -lc command -v tmux >/dev/null 2>&1 && { tmux -V; printf "\\n"; command -v tmux; }':
          {
            stdout: '',
            stderr: '',
            error: Object.assign(new Error('tmux missing'), { code: 'EFAIL' }),
          },
      }),
      createPreferenceStore() as never
    );

    const result = await service.probe();

    expect(result.preference?.preferredDistroName).toBe('Ubuntu');
    expect(result.preference?.source).toBe('manual');
    expect(result.status.distroName).toBe('Ubuntu');
    expect(result.status.innerPackageManager).toBe('apt');
    expect(result.status.tmuxAvailableInsideWsl).toBe(false);
    expect(result.status.statusDetail).toBe(
      'tmux is not installed inside the Ubuntu WSL distro yet.'
    );
  });

  it('uses a recommended Ubuntu target when a service distro is default among multiple user distros', async () => {
    const service = new TmuxWslService(
      createExecFileMock({
        '--status': { stdout: 'Default Distribution: docker-desktop\nDefault Version: 2\n' },
        '--list --quiet': { stdout: 'docker-desktop\nDebian\nUbuntu-24.04\nFedora\n' },
        '--list --verbose': {
          stdout:
            '* docker-desktop    Running    2\n  Debian    Stopped    2\n  Ubuntu-24.04    Stopped    2\n  Fedora    Stopped    2\n',
        },
        '-d Ubuntu-24.04 -- sh -lc printf ready': { stdout: 'ready' },
        '-d Ubuntu-24.04 -- sh -lc . /etc/os-release >/dev/null 2>&1 && printf %s "$ID"': {
          stdout: 'ubuntu',
        },
        '-d Ubuntu-24.04 -- sh -lc command -v tmux >/dev/null 2>&1 && { tmux -V; printf "\\n"; command -v tmux; }':
          {
            stdout: 'tmux 3.4\n/usr/bin/tmux\n',
          },
      }),
      createPreferenceStore() as never
    );

    const result = await service.probe();

    expect(result.preference?.preferredDistroName).toBe('Ubuntu-24.04');
    expect(result.preference?.source).toBe('manual');
    expect(result.status.distroName).toBe('Ubuntu-24.04');
    expect(result.status.tmuxAvailableInsideWsl).toBe(true);
  });

  it('prefers the persisted distro over the default WSL marker', async () => {
    const service = new TmuxWslService(
      createExecFileMock({
        '--status': { stdout: 'Default Distribution: Debian\nDefault Version: 2\n' },
        '--list --quiet': { stdout: 'Ubuntu\nDebian\n' },
        '--list --verbose': { stdout: '* Debian    Running    2\n  Ubuntu    Stopped    2\n' },
        '-d Ubuntu -- sh -lc printf ready': { stdout: 'ready' },
        '-d Ubuntu -- sh -lc . /etc/os-release >/dev/null 2>&1 && printf %s "$ID"': {
          stdout: 'ubuntu',
        },
        '-d Ubuntu -- sh -lc command -v tmux >/dev/null 2>&1 && { tmux -V; printf "\\n"; command -v tmux; }':
          {
            stdout: 'tmux 3.4\n/usr/bin/tmux\n',
          },
      }),
      createPreferenceStore('Ubuntu') as never
    );

    const result = await service.probe();

    expect(result.preference?.preferredDistroName).toBe('Ubuntu');
    expect(result.preference?.source).toBe('persisted');
    expect(result.status.distroName).toBe('Ubuntu');
  });

  it('prefers the persisted user distro over a service default distro', async () => {
    const service = new TmuxWslService(
      createExecFileMock({
        '--status': { stdout: 'Default Distribution: docker-desktop\nDefault Version: 2\n' },
        '--list --quiet': { stdout: 'docker-desktop\nUbuntu\nDebian\n' },
        '--list --verbose': {
          stdout:
            '* docker-desktop    Running    2\n  Ubuntu    Stopped    2\n  Debian    Stopped    2\n',
        },
        '-d Debian -- sh -lc printf ready': { stdout: 'ready' },
        '-d Debian -- sh -lc . /etc/os-release >/dev/null 2>&1 && printf %s "$ID"': {
          stdout: 'debian',
        },
        '-d Debian -- sh -lc command -v tmux >/dev/null 2>&1 && { tmux -V; printf "\\n"; command -v tmux; }':
          {
            stdout: 'tmux 3.4\n/usr/bin/tmux\n',
          },
      }),
      createPreferenceStore('Debian') as never
    );

    const result = await service.probe();

    expect(result.preference?.preferredDistroName).toBe('Debian');
    expect(result.preference?.source).toBe('persisted');
    expect(result.status.distroName).toBe('Debian');
    expect(result.status.tmuxAvailableInsideWsl).toBe(true);
  });

  it('clears a stale preferred distro when WSL has no installed distributions', async () => {
    const preferenceStore = createPreferenceStore('Ubuntu');
    const service = new TmuxWslService(
      createExecFileMock({
        '--status': { stdout: 'Default Version: 2\n' },
        '--list --quiet': { stdout: '' },
      }),
      preferenceStore as never
    );

    const result = await service.probe();

    expect(result.status.distroName).toBeNull();
    expect(preferenceStore.getPreferredDistroSync()).toBeNull();
  });

  it('ignores Docker internal WSL distros when choosing a teammate runtime distro', async () => {
    const service = new TmuxWslService(
      createExecFileMock({
        '--status': { stdout: 'Default Distribution: docker-desktop\nDefault Version: 2\n' },
        '--list --quiet': { stdout: 'docker-desktop\ndocker-desktop-data\n' },
      }),
      createPreferenceStore() as never
    );

    const result = await service.probe();

    expect(result.status.wslInstalled).toBe(true);
    expect(result.status.distroName).toBeNull();
    expect(result.status.statusDetail).toContain('only service distributions');
    expect(result.status.statusDetail).toContain('docker-desktop');
  });

  it('switches preference source away from persisted after clearing a stale distro', async () => {
    const preferenceStore = createPreferenceStore('Ubuntu');
    const service = new TmuxWslService(
      createExecFileMock({
        '--status': { stdout: 'Default Distribution: Debian\nDefault Version: 2\n' },
        '--list --quiet': { stdout: 'Debian\n' },
        '--list --verbose': { stdout: '* Debian    Running    2\n' },
        '-d Debian -- sh -lc printf ready': { stdout: 'ready' },
        '-d Debian -- sh -lc . /etc/os-release >/dev/null 2>&1 && printf %s "$ID"': {
          stdout: 'debian',
        },
        '-d Debian -- sh -lc command -v tmux >/dev/null 2>&1 && { tmux -V; printf "\\n"; command -v tmux; }':
          {
            stdout: 'tmux 3.4\n/usr/bin/tmux\n',
          },
      }),
      preferenceStore as never
    );

    const result = await service.probe();

    expect(result.preference?.preferredDistroName).toBe('Debian');
    expect(result.preference?.source).toBe('default');
    expect(preferenceStore.getPreferredDistroSync()).toBeNull();
  });

  it('detects a reboot requirement from localized Windows output', async () => {
    const service = new TmuxWslService(
      createExecFileMock({
        '--status': {
          stdout:
            'Требуемая операция выполнена успешно. Чтобы сделанные изменения вступили в силу, следует перезагрузить систему.',
        },
        '--list --quiet': { stdout: '' },
      }),
      createPreferenceStore() as never
    );

    const result = await service.probe();

    expect(result.status.wslInstalled).toBe(true);
    expect(result.status.rebootRequired).toBe(true);
    expect(result.status.statusDetail).toContain('restart');
  });

  it('detects a reboot requirement from pending Windows optional feature state', async () => {
    const execFileMock = (
      command: string,
      args: string[],
      _options: {
        timeout: number;
        windowsHide: boolean;
        maxBuffer: number;
        encoding: 'buffer';
      },
      callback: (error: Error | null, stdout: string | Buffer, stderr: string | Buffer) => void
    ): void => {
      if (command === 'powershell.exe') {
        callback(
          null,
          JSON.stringify([
            {
              FeatureName: 'Microsoft-Windows-Subsystem-Linux',
              State: 'EnablePending',
              RestartRequired: 'Possible',
            },
            {
              FeatureName: 'VirtualMachinePlatform',
              State: 'EnablePending',
              RestartRequired: 'Possible',
            },
          ]),
          ''
        );
        return;
      }

      const key = args.join(' ');
      if (key === '--status') {
        callback(null, 'ok', '');
        return;
      }
      if (key === '--list --quiet') {
        callback(null, '', '');
        return;
      }

      callback(
        Object.assign(new Error(`Unexpected command: ${command} ${key}`), { code: 'EFAIL' }),
        '',
        ''
      );
    };

    const service = new TmuxWslService(execFileMock, createPreferenceStore() as never);

    const result = await service.probe();

    expect(result.status.wslInstalled).toBe(true);
    expect(result.status.rebootRequired).toBe(true);
    expect(result.status.statusDetail).toContain('restart');
  });
});
