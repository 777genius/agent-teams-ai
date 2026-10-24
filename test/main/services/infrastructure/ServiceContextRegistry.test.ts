// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import { ServiceContextRegistry } from '../../../../src/main/services/infrastructure/ServiceContextRegistry';

import type { ServiceContext } from '../../../../src/main/services/infrastructure/ServiceContext';

function context(id: string) {
  return {
    id,
    type: id === 'local' ? 'local' : 'ssh',
    startFileWatcher: vi.fn(),
    stopFileWatcher: vi.fn(),
    retireDetailReads: vi.fn(),
    dispose: vi.fn(),
  } as unknown as ServiceContext;
}
function fixture() {
  const registry = new ServiceContextRegistry();
  const local = context('local'),
    ssh = context('ssh:TEST');
  registry.registerContext(local);
  registry.registerContext(ssh);
  return { registry, local, ssh };
}

describe('registry-owned active selection authority', () => {
  it('never revives a captured local selection after A to B to A', () => {
    const { registry } = fixture();
    const original = registry.captureActiveSelection();
    registry.switch('ssh:TEST');
    registry.switch('local');
    expect(original.isCurrent()).toBe(false);
    expect(registry.captureActiveSelection().isCurrent()).toBe(true);
    registry.dispose();
  });
  it('revokes an active physical replacement before disposing the old context', () => {
    const { registry, local } = fixture();
    const original = registry.captureActiveSelection();
    vi.mocked(local.dispose).mockImplementation(() => {
      expect(original.isCurrent()).toBe(false);
    });
    registry.replaceContext('local', context('local'));
    expect(original.isCurrent()).toBe(false);
    expect(registry.captureActiveSelection().isCurrent()).toBe(true);
    registry.dispose();
  });
  it('keeps a selection across no-op operations and unrelated inactive replacement', () => {
    const { registry, local } = fixture();
    const original = registry.captureActiveSelection();
    registry.switch('local');
    registry.replaceContext('local', local);
    registry.replaceContext('ssh:TEST', context('ssh:TEST'));
    expect(original.isCurrent()).toBe(true);
    registry.dispose();
    expect(original.isCurrent()).toBe(false);
  });
  it('revokes before active destruction and cannot revive on re-registration', () => {
    const { registry, ssh } = fixture();
    registry.switch('ssh:TEST');
    const original = registry.captureActiveSelection();
    vi.mocked(ssh.dispose).mockImplementation(() => {
      expect(original.isCurrent()).toBe(false);
    });
    registry.destroy('ssh:TEST');
    registry.registerContext(context('ssh:TEST'));
    registry.switch('ssh:TEST');
    expect(original.isCurrent()).toBe(false);
    registry.dispose();
  });
});
