import path from 'path';

export class RuntimeTurnSettledSpoolPaths {
  constructor(private readonly teamsBasePath: string) {}

  getRootDir(): string {
    return path.join(this.teamsBasePath, '.member-work-sync', 'runtime-hooks');
  }

  getBinDir(): string {
    return path.join(this.getRootDir(), 'bin');
  }

  getHookScriptPath(): string {
    return path.join(this.getBinDir(), 'turn-settled-hook-v1.sh');
  }

  getIncomingDir(): string {
    return path.join(this.getRootDir(), 'incoming');
  }

  getProcessingDir(): string {
    return path.join(this.getRootDir(), 'processing');
  }

  getProcessedDir(): string {
    return path.join(this.getRootDir(), 'processed');
  }

  getInvalidDir(): string {
    return path.join(this.getRootDir(), 'invalid');
  }
}
