import { ManagementCommandError } from '../management/commandRecords.js';
import { codexManagementProfileSchema } from '../management/profile.js';
import type { ProviderManagementProfile } from '../management/profile.js';
import type { RuntimeSourceCandidate, RuntimeSourceRefusal } from './runtimeSourceContracts.js';

export class RuntimeSourceAdmissionError extends ManagementCommandError {
  constructor(readonly reason: RuntimeSourceRefusal) {
    super('held');
  }
}

/** Existing four provider routes only. Identity does not qualify a new native protocol. */
export function assertRuntimeSourceNativePolicy(
  seed: ProviderManagementProfile,
  candidate: RuntimeSourceCandidate
): void {
  const cli = candidate.nativeCli;
  if (!cli) return;
  const unqualified = (): never => {
    throw new RuntimeSourceAdmissionError('unqualified-version');
  };
  const [major, minor] = cli.version.split('.').map(Number);
  if (seed.provider === 'opencode') {
    const generation = seed.nativeGeneration ?? 'v1';
    if (cli.generation !== generation)
      throw new RuntimeSourceAdmissionError('generation-change-unqualified');
    // Same stable V1 minimum as the existing installer, generation.ts (1.16.0).
    // Stable V2 CLI is only a selector; the seed's qualified 2.1.4 engine still executes.
    if (
      generation === 'v1'
        ? major !== 1 || minor! < 16
        : major !== 2 || seed.protocolRevision !== '2.1.4' || seed.embedded?.version !== '2.1.4'
    )
      unqualified();
  } else {
    if (cli.generation !== undefined)
      throw new RuntimeSourceAdmissionError('generation-change-unqualified');
    if (seed.provider === 'codex' &&
        !codexManagementProfileSchema.shape.protocolRevision.safeParse(cli.version).success) unqualified();
    // Claude CLI compatibility is proven against the original seed's actual version below;
    // its SDK revision is deliberately not used as a CLI version.
  }
  if (
    !(seed.provider === 'opencode' && seed.nativeGeneration === 'v2') &&
    (cli.executable.path !== candidate.executable.path ||
      cli.executable.sha256 !== candidate.executable.sha256)
  )
    throw new RuntimeSourceAdmissionError('source-changed');
}
