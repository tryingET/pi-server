import type { StoredSessionInfo } from "./session-store.js";

interface StoredSessionControlRecord {
  epoch: number;
  info: StoredSessionInfo;
}

/**
 * Session control plane.
 *
 * Authoritative responsibilities:
 * - monotonic per-session epochs (prevents ABA across delete/recreate)
 * - canonical stored-session inventory snapshot for fast list reads
 * - discovered-session cache kept separate from stored session identity
 */
export class SessionControlPlane {
  private epochs = new Map<string, number>();
  private storedSessions = new Map<string, StoredSessionControlRecord>();
  private discoveredSessionsByPath = new Map<string, StoredSessionInfo>();

  beginSessionEpoch(sessionId: string): number {
    const nextEpoch = (this.epochs.get(sessionId) ?? 0) + 1;
    this.epochs.set(sessionId, nextEpoch);
    return nextEpoch;
  }

  getCurrentEpoch(sessionId: string): number | undefined {
    return this.epochs.get(sessionId);
  }

  isCurrentEpoch(sessionId: string, epoch: number): boolean {
    return this.epochs.get(sessionId) === epoch;
  }

  seedStoredSessions(
    records: Array<{ sessionId: string; epoch: number; info: StoredSessionInfo }>
  ): void {
    this.storedSessions.clear();

    for (const record of records) {
      const existingEpoch = this.epochs.get(record.sessionId) ?? 0;
      this.epochs.set(record.sessionId, Math.max(existingEpoch, record.epoch));
      this.storedSessions.set(record.sessionId, {
        epoch: record.epoch,
        info: { ...record.info },
      });
    }
  }

  replaceDiscoveredSessions(sessions: StoredSessionInfo[]): void {
    const next = new Map<string, StoredSessionInfo>();
    for (const session of sessions) {
      next.set(session.sessionFile, { ...session });
    }
    this.discoveredSessionsByPath = next;
  }

  upsertStoredSession(sessionId: string, epoch: number, info: StoredSessionInfo): void {
    const existingEpoch = this.epochs.get(sessionId) ?? 0;
    this.epochs.set(sessionId, Math.max(existingEpoch, epoch));
    this.storedSessions.set(sessionId, {
      epoch,
      info: { ...info },
    });
  }

  updateStoredSession(
    sessionId: string,
    epoch: number,
    patch: Partial<Omit<StoredSessionInfo, "sessionId">>
  ): boolean {
    const existing = this.storedSessions.get(sessionId);
    if (!existing || existing.epoch !== epoch) {
      return false;
    }

    existing.info = {
      ...existing.info,
      ...patch,
      sessionId: existing.info.sessionId,
    };
    return true;
  }

  removeStoredSession(sessionId: string, epoch: number): boolean {
    const existing = this.storedSessions.get(sessionId);
    if (!existing || existing.epoch !== epoch) {
      return false;
    }

    this.storedSessions.delete(sessionId);
    return true;
  }

  retireSessionEpoch(sessionId: string, epoch: number): boolean {
    if (!this.isCurrentEpoch(sessionId, epoch)) {
      return false;
    }

    this.storedSessions.delete(sessionId);
    this.epochs.set(sessionId, epoch + 1);
    return true;
  }

  listStoredSessions(): StoredSessionInfo[] {
    const byPath = new Map<string, StoredSessionInfo>();

    for (const discovered of this.discoveredSessionsByPath.values()) {
      byPath.set(discovered.sessionFile, { ...discovered });
    }

    for (const record of this.storedSessions.values()) {
      byPath.set(record.info.sessionFile, { ...record.info });
    }

    return Array.from(byPath.values()).sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
  }

  clear(): void {
    this.epochs.clear();
    this.storedSessions.clear();
    this.discoveredSessionsByPath.clear();
  }
}
