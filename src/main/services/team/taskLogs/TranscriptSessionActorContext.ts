interface SessionActorContextState {
  agentId?: string;
  agentName?: string;
  isSidechain?: boolean;
  agentIdAmbiguous: boolean;
  agentNameAmbiguous: boolean;
  isSidechainAmbiguous: boolean;
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function hasBoolean(value: unknown): value is boolean {
  return typeof value === 'boolean';
}

function cloneWithContext<T extends Record<string, unknown>>(
  record: T,
  updates: Record<string, unknown>
): T {
  return {
    ...record,
    ...updates,
  };
}

export class TranscriptSessionActorContextTracker {
  private readonly contextsBySessionId = new Map<string, SessionActorContextState>();

  remember(record: Record<string, unknown>): void {
    const sessionId = readNonEmptyString(record.sessionId);
    if (!sessionId) {
      return;
    }

    const agentId = readNonEmptyString(record.agentId);
    const agentName = readNonEmptyString(record.agentName);
    const isSidechain = hasBoolean(record.isSidechain) ? record.isSidechain : undefined;
    if (!agentId && !agentName && isSidechain === undefined) {
      return;
    }

    const current = this.contextsBySessionId.get(sessionId) ?? {
      agentIdAmbiguous: false,
      agentNameAmbiguous: false,
      isSidechainAmbiguous: false,
    };

    const next: SessionActorContextState = { ...current };
    if (agentId) {
      if (current.agentId && current.agentId !== agentId) {
        next.agentIdAmbiguous = true;
      } else {
        next.agentId = agentId;
      }
    }

    if (agentName) {
      if (current.agentName && current.agentName !== agentName) {
        next.agentNameAmbiguous = true;
      } else {
        next.agentName = agentName;
      }
    }

    if (isSidechain !== undefined) {
      if (current.isSidechain !== undefined && current.isSidechain !== isSidechain) {
        next.isSidechainAmbiguous = true;
      } else {
        next.isSidechain = isSidechain;
      }
    }

    this.contextsBySessionId.set(sessionId, next);
  }

  apply<T extends Record<string, unknown>>(record: T): T {
    const sessionId = readNonEmptyString(record.sessionId);
    if (!sessionId) {
      return record;
    }

    const context = this.contextsBySessionId.get(sessionId);
    if (!context) {
      return record;
    }

    const updates: Record<string, unknown> = {};
    if (!readNonEmptyString(record.agentId) && context.agentId && !context.agentIdAmbiguous) {
      updates.agentId = context.agentId;
    }

    if (!readNonEmptyString(record.agentName) && context.agentName && !context.agentNameAmbiguous) {
      updates.agentName = context.agentName;
    }

    if (
      !hasBoolean(record.isSidechain) &&
      context.isSidechain !== undefined &&
      !context.isSidechainAmbiguous
    ) {
      updates.isSidechain = context.isSidechain;
    }

    return Object.keys(updates).length > 0 ? cloneWithContext(record, updates) : record;
  }
}
