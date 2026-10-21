import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { isAbsolute, join, parse, resolve } from 'node:path';

import { TeamOwnerError } from '../../team/contracts.js';
import { digest, safeSegment } from '../../team/identity.js';

import type { TeamStore } from '../../team/ports.js';
import { withTeamFileFence, writeTeamJson } from './ControllerAdapter.js';

export class TeamOwnerStore implements TeamStore {
  readonly directory: string;
  private readonly teamName: string;

  constructor(
    readonly root: string,
    teamName: string
  ) {
    if (!isAbsolute(root) || resolve(root) !== root) throw new TeamOwnerError('invalid');
    // Trusted composition chooses the namespace. Never follow a symlink into ambient data.
    this.directory = join(root, 'teams', safeSegment(teamName), '.host-owner');
    this.teamName = teamName;
    let part = parse(this.directory).root;
    for (const segment of this.directory.slice(part.length).split('/')) {
      part = join(part, segment);
      try {
        const stat = lstatSync(part);
        if (stat.isSymbolicLink() || !stat.isDirectory()) throw new TeamOwnerError('invalid');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        mkdirSync(part);
      }
    }
  }

  fenced<T>(action: () => T): T {
    this.validateNamespace();
    return withTeamFileFence(join(this.directory, 'authority'), () => {
      this.validateNamespace();
      return action();
    });
  }

  /** Reject changed/symlinked product paths before the portable controller can follow them. */
  private validateNamespace(): void {
    const directoryPath = (target: string): void => {
      let part = parse(target).root;
      for (const segment of target.slice(part.length).split('/')) {
        part = join(part, segment);
        try {
          const stat = lstatSync(part);
          if (!stat.isDirectory() || stat.isSymbolicLink()) throw new TeamOwnerError('hold');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
          throw error;
        }
      }
    };
    const tree = (target: string): void => {
      let entries;
      try {
        entries = readdirSync(target, { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw error;
      }
      for (const entry of entries) {
        if (entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory()))
          throw new TeamOwnerError('hold');
        if (entry.isDirectory()) tree(join(target, entry.name));
      }
    };
    const team = join(this.root, 'teams', this.teamName);
    const tasks = join(this.root, 'tasks', this.teamName);
    directoryPath(this.directory);
    directoryPath(tasks);
    tree(team);
    tree(tasks);
  }

  read<T>(name: string): T | undefined {
    try {
      return JSON.parse(readFileSync(join(this.directory, name), 'utf8')) as T;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw new TeamOwnerError('hold');
    }
  }

  write(name: string, value: unknown): void {
    writeTeamJson(join(this.directory, name), value);
  }

  list<T>(directory: string): T[] {
    try {
      return readdirSync(join(this.directory, directory))
        .filter((name) => name.endsWith('.json'))
        .map((name) => {
          const value = this.read<T>(`${directory}/${name}`);
          if (!value) throw new TeamOwnerError('hold');
          return value;
        });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  /** Exact bytes establish not-applied after a synchronous policy rejection. */
  productFingerprint(teamName: string): string {
    const files: Record<string, string> = {};
    const visit = (directory: string): void => {
      let entries;
      try {
        entries = readdirSync(directory, { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw error;
      }
      for (const entry of entries) {
        if (entry.name === '.host-owner') continue;
        const file = join(directory, entry.name);
        if (entry.isSymbolicLink()) throw new TeamOwnerError('hold');
        if (entry.isDirectory()) visit(file);
        else if (entry.isFile() && entry.name.endsWith('.json'))
          files[file] = createHash('sha256').update(readFileSync(file)).digest('hex');
      }
    };
    visit(join(this.root, 'teams', teamName));
    visit(join(this.root, 'tasks', teamName));
    return digest(files);
  }
}
