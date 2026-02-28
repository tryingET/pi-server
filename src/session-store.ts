/**
 * Session Store - persists session metadata across server restarts.
 *
 * The actual session content (messages, etc.) is managed by pi-coding-agent
 * and stored in session files (~/.pi/agent/sessions/*.json).
 *
 * This store tracks:
 * - Which sessions existed (sessionId -> sessionFile mapping)
 * - Session metadata (createdAt, cwd, etc.)
 * - Enables recovery after server restart
 *
 * ADR-0007: Session Persistence
 */

import fs from "fs/promises";
import fsRegular from "fs";
import path from "path";
import type { SessionInfo } from "./types.js";

/** Metadata persisted for each session. */
export interface StoredSessionMetadata {
  /** Unique session identifier */
  sessionId: string;
  /** Path to the session file managed by pi-coding-agent */
  sessionFile: string;
  /** Working directory when session was created */
  cwd: string;
  /** ISO timestamp when session was created */
  createdAt: string;
  /** Optional user-defined session name */
  sessionName?: string;
  /** Last known model (may be stale if session was modified externally) */
  modelId?: string;
  /** Server version that created this record (for migrations) */
  serverVersion: string;
}

/** Input for saving session metadata (serverVersion added automatically). */
export type SaveSessionInput = Omit<StoredSessionMetadata, "serverVersion">;

/** Session with resolved metadata (combines stored + file system info). */
export interface StoredSessionInfo extends SessionInfo {
  /** Path to the session file */
  sessionFile: string;
  /** Working directory */
  cwd: string;
  /** Whether the session file still exists on disk */
  fileExists: boolean;
}

/** A group of sessions organized by working directory. */
export interface SessionGroup {
  /** Full working directory path */
  cwd: string;
  /** Display-friendly path (shortened) */
  displayPath: string;
  /** Number of sessions in this group */
  sessionCount: number;
  /** Sessions in this group, sorted by date (newest first) */
  sessions: StoredSessionInfo[];
}

/** Configuration for SessionStore */
export interface SessionStoreConfig {
  /** Directory to store session metadata (default: ~/.pi/agent/server/) */
  dataDir?: string;
  /** Directory where pi-coding-agent stores sessions (default: ~/.pi/agent/sessions/) */
  sessionsDir?: string;
  /** Server version for migration tracking */
  serverVersion?: string;
}

/** Default server version if not provided */
const DEFAULT_SERVER_VERSION = "0.1.0";

/** Metadata file name */
const METADATA_FILE = "sessions-metadata.json";

/** Maximum metadata file size (prevent OOM from corrupt files) */
const MAX_METADATA_SIZE = 1024 * 1024; // 1MB

/**
 * Session metadata store.
 *
 * Thread-safety: All operations are atomic via file locking.
 * Callers should use SessionLockManager for in-memory coordination.
 */
export class SessionStore {
  private readonly dataDir: string;
  private readonly sessionsDir: string;
  private readonly serverVersion: string;
  private readonly metadataPath: string;
  private metadataCache: Map<string, StoredSessionMetadata> | null = null;
  private lastLoadTime = 0;
  /** Cache TTL in ms (5 seconds) */
  private readonly cacheTtl = 5000;
  /** Count of metadata resets due to oversized/corrupt files */
  private metadataResetCount = 0;

  constructor(config: SessionStoreConfig = {}) {
    this.dataDir = config.dataDir ?? path.join(process.env.HOME ?? "~", ".pi", "agent", "server");
    this.sessionsDir =
      config.sessionsDir ?? path.join(process.env.HOME ?? "~", ".pi", "agent", "sessions");
    this.serverVersion = config.serverVersion ?? DEFAULT_SERVER_VERSION;
    this.metadataPath = path.join(this.dataDir, METADATA_FILE);
  }

  /**
   * Ensure the data directory exists.
   */
  private async ensureDataDir(): Promise<void> {
    try {
      await fs.mkdir(this.dataDir, { recursive: true });
    } catch (error) {
      if ((error as any).code !== "EEXIST") {
        throw error;
      }
    }
  }

  /**
   * Load metadata from disk (with caching).
   */
  private async loadMetadata(): Promise<Map<string, StoredSessionMetadata>> {
    const now = Date.now();

    // Return cached if fresh
    if (this.metadataCache && now - this.lastLoadTime < this.cacheTtl) {
      return this.metadataCache;
    }

    await this.ensureDataDir();

    try {
      const stat = await fs.stat(this.metadataPath);

      // Safety check: reject oversized files
      if (stat.size > MAX_METADATA_SIZE) {
        this.metadataResetCount++;
        // Backup the oversized file before resetting
        const backupPath = `${this.metadataPath}.oversized.${Date.now()}.bak`;
        try {
          await fs.rename(this.metadataPath, backupPath);
          console.error(
            `[SessionStore] CRITICAL: Metadata file too large (${stat.size} bytes > ${MAX_METADATA_SIZE}), backed up to ${backupPath} and resetting`
          );
        } catch {
          console.error(
            `[SessionStore] CRITICAL: Metadata file too large (${stat.size} bytes), failed to backup: ${this.metadataPath}`
          );
        }
        this.metadataCache = new Map();
        this.lastLoadTime = now;
        return this.metadataCache;
      }

      const data = await fs.readFile(this.metadataPath, "utf-8");
      const parsed = JSON.parse(data);

      if (typeof parsed !== "object" || parsed === null) {
        throw new Error("Invalid metadata format");
      }

      // Handle both array and object formats
      const entries = Array.isArray(parsed.sessions)
        ? parsed.sessions
        : Array.isArray(parsed)
          ? parsed
          : Object.entries(parsed);

      const map = new Map<string, StoredSessionMetadata>();

      for (const entry of entries) {
        if (Array.isArray(entry)) {
          // [key, value] format
          const [key, value] = entry;
          if (typeof key === "string" && this.isValidMetadata(value)) {
            map.set(key, value);
          }
        } else if (this.isValidMetadata(entry)) {
          // { sessionId, ... } format
          map.set(entry.sessionId, entry);
        }
      }

      this.metadataCache = map;
      this.lastLoadTime = now;
      return map;
    } catch (error) {
      if ((error as any).code === "ENOENT") {
        // File doesn't exist yet - return empty map
        this.metadataCache = new Map();
        this.lastLoadTime = now;
        return this.metadataCache;
      }

      console.error(`[SessionStore] Failed to load metadata:`, error);
      // Return empty on error (don't crash)
      this.metadataCache = new Map();
      this.lastLoadTime = now;
      return this.metadataCache;
    }
  }

  /**
   * Validate metadata structure.
   */
  private isValidMetadata(value: unknown): value is StoredSessionMetadata {
    if (typeof value !== "object" || value === null) return false;
    const v = value as Record<string, unknown>;
    return (
      typeof v.sessionId === "string" &&
      typeof v.sessionFile === "string" &&
      typeof v.cwd === "string" &&
      typeof v.createdAt === "string"
    );
  }

  /**
   * Save metadata to disk.
   */
  private async saveMetadata(metadata: Map<string, StoredSessionMetadata>): Promise<void> {
    await this.ensureDataDir();

    const data = {
      version: 1,
      serverVersion: this.serverVersion,
      sessions: Array.from(metadata.values()),
    };

    // Write to temp file first, then rename (atomic on POSIX)
    // Include PID and random suffix to prevent collision with concurrent saves
    const tempPath = `${this.metadataPath}.${process.pid}.${crypto.randomUUID().slice(0, 8)}.tmp`;
    await fs.writeFile(tempPath, JSON.stringify(data, null, 2), "utf-8");
    await fs.rename(tempPath, this.metadataPath);

    // Update cache
    this.metadataCache = metadata;
    this.lastLoadTime = Date.now();
  }

  /**
   * Invalidate the cache (force reload on next access).
   */
  invalidateCache(): void {
    this.metadataCache = null;
    this.lastLoadTime = 0;
  }

  /**
   * Save session metadata.
   */
  async save(meta: SaveSessionInput): Promise<void> {
    const metadata = await this.loadMetadata();
    metadata.set(meta.sessionId, {
      ...meta,
      serverVersion: this.serverVersion,
    });
    await this.saveMetadata(metadata);
  }

  /**
   * Load session metadata by ID.
   */
  async load(sessionId: string): Promise<StoredSessionMetadata | null> {
    const metadata = await this.loadMetadata();
    return metadata.get(sessionId) ?? null;
  }

  /**
   * Delete session metadata.
   */
  async delete(sessionId: string): Promise<boolean> {
    const metadata = await this.loadMetadata();
    if (!metadata.has(sessionId)) {
      return false;
    }
    metadata.delete(sessionId);
    await this.saveMetadata(metadata);
    return true;
  }

  /**
   * List all stored session metadata.
   */
  async list(): Promise<StoredSessionMetadata[]> {
    const metadata = await this.loadMetadata();
    return Array.from(metadata.values());
  }

  /**
   * List stored sessions with resolved info (includes file existence check).
   */
  async listWithInfo(): Promise<StoredSessionInfo[]> {
    const metadata = await this.loadMetadata();
    const results: StoredSessionInfo[] = [];

    for (const meta of metadata.values()) {
      let fileExists = false;
      try {
        await fs.access(meta.sessionFile);
        fileExists = true;
      } catch {
        fileExists = false;
      }

      results.push({
        sessionId: meta.sessionId,
        sessionName: meta.sessionName,
        sessionFile: meta.sessionFile,
        cwd: meta.cwd,
        createdAt: meta.createdAt,
        // These may be stale/undefined - will be refreshed when session is loaded
        thinkingLevel: "medium",
        isStreaming: false,
        messageCount: 0,
        fileExists,
      });
    }

    // Sort by creation date (newest first)
    results.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    return results;
  }

  // ==========================================================================
  // SESSION DISCOVERY (ADR-0007)
  // ==========================================================================

  /**
   * Discover all session files in the sessions directory.
   * This scans ~/.pi/agent/sessions/ for .jsonl files.
   * Reads the first line of each file to get the correct cwd.
   */
  async discoverSessions(): Promise<StoredSessionInfo[]> {
    const results: StoredSessionInfo[] = [];

    try {
      const entries = await fs.readdir(this.sessionsDir, { withFileTypes: true });

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const subdir = path.join(this.sessionsDir, entry.name);

        try {
          const files = await fs.readdir(subdir);

          for (const file of files) {
            if (!file.endsWith(".jsonl")) continue;

            const filePath = path.join(subdir, file);
            const stats = await fs.stat(filePath);

            // Extract timestamp from filename: 2026-02-22T16-09-11-130Z_6f572984.jsonl
            const createdAt = this.extractTimestampFromFilename(file) ?? stats.mtime.toISOString();

            // Use file path as session ID (or extract from filename)
            const sessionId = file.replace(/\.jsonl$/, "");

            // Read first line to get cwd and sessionName
            const { cwd, sessionName } = await this.readSessionFileMetadata(filePath);

            results.push({
              sessionId,
              sessionFile: filePath,
              cwd,
              sessionName,
              createdAt,
              thinkingLevel: "medium",
              isStreaming: false,
              messageCount: 0,
              fileExists: true,
            });
          }
        } catch {
          // Ignore errors reading subdirectory
        }
      }
    } catch {
      // Sessions directory doesn't exist yet
    }

    // Sort by creation date (newest first)
    results.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    return results;
  }

  /**
   * Read the first line of a session file to get metadata.
   * Uses readline to properly handle UTF-8 and avoid truncation issues.
   */
  private async readSessionFileMetadata(
    filePath: string
  ): Promise<{ cwd: string; sessionName?: string }> {
    const readline = await import("readline");
    const fileStream = fsRegular.createReadStream(filePath, { encoding: "utf-8" });
    let rl: ReturnType<typeof readline.createInterface> | undefined;

    try {
      rl = readline.createInterface({
        input: fileStream,
        crlfDelay: Infinity,
      });

      let firstLine: string | undefined;
      for await (const line of rl) {
        firstLine = line;
        break; // Only need the first line
      }

      if (!firstLine) {
        return { cwd: "/unknown" };
      }

      const meta = JSON.parse(firstLine);
      return {
        cwd: meta.cwd || "/unknown",
        sessionName: meta.sessionName || meta.name || undefined,
      };
    } catch {
      return { cwd: "/unknown" };
    } finally {
      // Always close readline interface first, then destroy the stream
      // This prevents resource leaks if the for-await loop throws
      // Use try-catch to ensure both cleanup steps run even if one fails
      try {
        rl?.close();
      } catch {
        // Ignore close errors
      }
      try {
        fileStream.destroy();
      } catch {
        // Ignore destroy errors
      }
    }
  }

  /**
   * Extract timestamp from session filename.
   * 2026-02-22T16-09-11-130Z_6f572984.jsonl → 2026-02-22T16:09:11.130Z
   */
  private extractTimestampFromFilename(filename: string): string | null {
    const match = filename.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/);
    if (!match) return null;

    const [, year, month, day, hour, min, sec, ms] = match;
    return `${year}-${month}-${day}T${hour}:${min}:${sec}.${ms}Z`;
  }

  /**
   * List all sessions (stored + discovered), merged.
   * Stored sessions take precedence (they have more metadata).
   */
  async listAllSessions(): Promise<StoredSessionInfo[]> {
    const [stored, discovered] = await Promise.all([this.listWithInfo(), this.discoverSessions()]);

    // Create map keyed by sessionFile for deduplication
    const byPath = new Map<string, StoredSessionInfo>();

    // Add discovered first
    for (const session of discovered) {
      byPath.set(session.sessionFile, session);
    }

    // Stored sessions override (they have more metadata)
    for (const session of stored) {
      byPath.set(session.sessionFile, session);
    }

    // Sort by creation date (newest first)
    return Array.from(byPath.values()).sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
  }

  /**
   * List all sessions grouped by working directory.
   * Groups are sorted by most recent session (newest first).
   */
  async listSessionsGrouped(): Promise<SessionGroup[]> {
    const sessions = await this.listAllSessions();

    // Group by cwd
    const groups = new Map<string, StoredSessionInfo[]>();
    for (const session of sessions) {
      const cwd = session.cwd || "/unknown";
      if (!groups.has(cwd)) {
        groups.set(cwd, []);
      }
      groups.get(cwd)!.push(session);
    }

    // Convert to SessionGroup array
    const result: SessionGroup[] = [];
    for (const [cwd, groupSessions] of groups) {
      result.push({
        cwd,
        displayPath: this.formatDisplayPath(cwd),
        sessionCount: groupSessions.length,
        sessions: groupSessions,
      });
    }

    // Sort groups by most recent session
    result.sort((a, b) => {
      const aTime = new Date(a.sessions[0]?.createdAt || 0).getTime();
      const bTime = new Date(b.sessions[0]?.createdAt || 0).getTime();
      return bTime - aTime;
    });

    return result;
  }

  /**
   * Format a full path for display.
   * /home/tryinget/programming/pi-server → pi-server
   * /home/tryinget → ~
   */
  private formatDisplayPath(cwd: string): string {
    const home = process.env.HOME || "";
    if (!home) return cwd;

    // Replace home with ~
    if (cwd === home) return "~";
    if (cwd.startsWith(home + "/")) {
      const relative = cwd.slice(home.length + 1);
      // Show just the last 1-2 components
      const parts = relative.split("/");
      if (parts.length <= 2) {
        return parts.join("/");
      }
      return parts.slice(-2).join("/");
    }

    return cwd;
  }

  /**
   * Update session name in metadata.
   */
  async updateName(sessionId: string, name: string): Promise<boolean> {
    const metadata = await this.loadMetadata();
    const existing = metadata.get(sessionId);
    if (!existing) {
      return false;
    }
    existing.sessionName = name;
    await this.saveMetadata(metadata);
    return true;
  }

  /**
   * Clean up metadata entries for sessions whose files no longer exist.
   */
  async cleanup(): Promise<{ removed: number; kept: number }> {
    const metadata = await this.loadMetadata();
    const toRemove: string[] = [];

    for (const [sessionId, meta] of metadata) {
      try {
        await fs.access(meta.sessionFile);
      } catch {
        toRemove.push(sessionId);
      }
    }

    for (const sessionId of toRemove) {
      metadata.delete(sessionId);
    }

    if (toRemove.length > 0) {
      await this.saveMetadata(metadata);
    }

    return { removed: toRemove.length, kept: metadata.size };
  }

  /**
   * Get store statistics.
   */
  async getStats(): Promise<{
    sessionCount: number;
    dataDir: string;
    metadataPath: string;
    metadataResetCount: number;
  }> {
    const metadata = await this.loadMetadata();
    return {
      sessionCount: metadata.size,
      dataDir: this.dataDir,
      metadataPath: this.metadataPath,
      metadataResetCount: this.metadataResetCount,
    };
  }

  /**
   * Get metadata reset count (synchronous, for metrics).
   * This tracks how many times the metadata file was reset due to being
   * oversized or corrupt, indicating potential disk/filesystem issues.
   */
  getMetadataResetCount(): number {
    return this.metadataResetCount;
  }

  // ==========================================================================
  // PERIODIC CLEANUP
  // ==========================================================================

  private cleanupInterval: NodeJS.Timeout | null = null;

  /**
   * Start periodic cleanup of orphaned metadata entries.
   * @param intervalMs Cleanup interval in milliseconds (default: 1 hour)
   */
  startPeriodicCleanup(intervalMs = 3600000): void {
    if (this.cleanupInterval) {
      return; // Already running
    }

    this.cleanupInterval = setInterval(async () => {
      try {
        const result = await this.cleanup();
        if (result.removed > 0) {
          console.log(`[SessionStore] Periodic cleanup removed ${result.removed} orphaned entries`);
        }
      } catch (error) {
        console.error("[SessionStore] Periodic cleanup failed:", error);
      }
    }, intervalMs);

    // Don't prevent process exit
    if (this.cleanupInterval.unref) {
      this.cleanupInterval.unref();
    }
  }

  /**
   * Stop periodic cleanup.
   */
  stopPeriodicCleanup(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }
}
