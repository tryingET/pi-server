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
import { getDefaultAllowedSessionDirectories } from "./validation.js";

/** Metadata persisted for each session. */
export interface StoredSessionMetadata {
  /** Unique session identifier */
  sessionId: string;
  /** Monotonic lifecycle epoch for ABA-safe async mutations */
  epoch: number;
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
export type SaveSessionInput = Omit<StoredSessionMetadata, "serverVersion" | "epoch"> & {
  epoch?: number;
};

/** Session with resolved metadata (combines stored + file system info). */
export interface StoredSessionInfo extends SessionInfo {
  /** Path to the session file (use this for load_session command) */
  sessionFile: string;
  /** Alias for sessionFile (for consistency with load_session's sessionPath parameter) */
  sessionPath: string;
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

/** Fallback server version if package.json cannot be read */
const UNKNOWN_SERVER_VERSION = "0.0.0-unknown";

/** Default server version if not provided */
function readPackageVersion(): string {
  try {
    const packageJsonPath = new URL("../package.json", import.meta.url);
    const raw = fsRegular.readFileSync(packageJsonPath, "utf-8");
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === "string" && parsed.version.length > 0
      ? parsed.version
      : UNKNOWN_SERVER_VERSION;
  } catch {
    return UNKNOWN_SERVER_VERSION;
  }
}

const DEFAULT_SERVER_VERSION = readPackageVersion();

/** Metadata file name */
const METADATA_FILE = "sessions-metadata.json";

/** Maximum metadata file size (prevent OOM from corrupt files) */
const MAX_METADATA_SIZE = 1024 * 1024; // 1MB

/** Cross-process metadata lock acquisition timeout. */
const METADATA_LOCK_TIMEOUT_MS = 5000;
/** Wait between metadata lock retries. */
const METADATA_LOCK_RETRY_MS = 25;
/** Stale metadata lock timeout (e.g. crashed writer). */
const METADATA_LOCK_STALE_MS = 30000;
/** Bound recursive discovery of session roots. */
const MAX_DISCOVERY_DEPTH = 4;
const MAX_DISCOVERY_NODES = 10000;
/** Chunk size for reverse scanning session files for latest session_info entries. */
const SESSION_METADATA_REVERSE_SCAN_CHUNK_BYTES = 16 * 1024;

/**
 * Tracks lock paths currently held by this process.
 *
 * Root cause note: another SessionStore instance can observe a freshly created
 * lock file before its JSON payload is fully readable. Freshness must therefore
 * be derived from the lock file's mtime first, and same-process ownership must
 * come from live runtime state rather than partially written lock contents.
 */
const ACTIVE_METADATA_LOCKS = new Set<string>();

/**
 * Session metadata store.
 *
 * Process-safety: metadata mutations are serialized through a single in-process
 * writer chain and a cross-process lock file so concurrent save/delete/update
 * operations cannot lose updates across SessionStore instances.
 * Callers should still use SessionLockManager for per-session in-memory coordination.
 */
export class SessionStore {
  private readonly dataDir: string;
  private readonly sessionsDir: string;
  private readonly serverVersion: string;
  private readonly metadataPath: string;
  private readonly metadataLockPath: string;
  private metadataCache: Map<string, StoredSessionMetadata> | null = null;
  private lastLoadTime = 0;
  private cachedMetadataMtimeMs: number | null = null;
  private cachedMetadataCtimeMs: number | null = null;
  private cachedMetadataSize: number | null = null;
  private cachedMetadataMissing = true;
  /** Cache TTL in ms (5 seconds) */
  private readonly cacheTtl = 5000;
  /** Count of metadata resets due to oversized/corrupt files */
  private metadataResetCount = 0;
  /** Cached session-file metadata keyed by file path + stat snapshot. */
  private sessionFileMetadataCache = new Map<
    string,
    {
      mtimeMs: number;
      size: number;
      metadata: { cwd: string; sessionName?: string };
    }
  >();
  /** Serializes metadata mutations to prevent lost updates under concurrency. */
  private mutationChain: Promise<void> = Promise.resolve();

  constructor(config: SessionStoreConfig = {}) {
    this.dataDir = config.dataDir ?? path.join(process.env.HOME ?? "~", ".pi", "agent", "server");
    this.sessionsDir =
      config.sessionsDir ?? path.join(process.env.HOME ?? "~", ".pi", "agent", "sessions");
    this.serverVersion = config.serverVersion ?? DEFAULT_SERVER_VERSION;
    this.metadataPath = path.join(this.dataDir, METADATA_FILE);
    this.metadataLockPath = `${this.metadataPath}.lock`;
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

    // Return cached if fresh AND the metadata file snapshot still matches.
    if (this.metadataCache && now - this.lastLoadTime < this.cacheTtl) {
      try {
        const stat = await fs.stat(this.metadataPath);
        if (
          !this.cachedMetadataMissing &&
          this.cachedMetadataMtimeMs === stat.mtimeMs &&
          this.cachedMetadataCtimeMs === stat.ctimeMs &&
          this.cachedMetadataSize === stat.size
        ) {
          return this.metadataCache;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT" && this.cachedMetadataMissing) {
          return this.metadataCache;
        }
      }
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
        this.cachedMetadataMtimeMs = null;
        this.cachedMetadataCtimeMs = null;
        this.cachedMetadataSize = null;
        this.cachedMetadataMissing = true;
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
            map.set(key, this.normalizeStoredMetadata(value));
          }
        } else if (this.isValidMetadata(entry)) {
          // { sessionId, ... } format
          map.set(entry.sessionId, this.normalizeStoredMetadata(entry));
        }
      }

      this.metadataCache = map;
      this.lastLoadTime = now;
      this.cachedMetadataMtimeMs = stat.mtimeMs;
      this.cachedMetadataCtimeMs = stat.ctimeMs;
      this.cachedMetadataSize = stat.size;
      this.cachedMetadataMissing = false;
      return map;
    } catch (error) {
      if ((error as any).code === "ENOENT") {
        // File doesn't exist yet - return empty map
        this.metadataCache = new Map();
        this.lastLoadTime = now;
        this.cachedMetadataMtimeMs = null;
        this.cachedMetadataCtimeMs = null;
        this.cachedMetadataSize = null;
        this.cachedMetadataMissing = true;
        return this.metadataCache;
      }

      console.error(`[SessionStore] Failed to load metadata:`, error);
      // Return empty on error (don't crash)
      this.metadataCache = new Map();
      this.lastLoadTime = now;
      this.cachedMetadataMtimeMs = null;
      this.cachedMetadataCtimeMs = null;
      this.cachedMetadataSize = null;
      this.cachedMetadataMissing = false;
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
      typeof v.createdAt === "string" &&
      (v.epoch === undefined ||
        (typeof v.epoch === "number" && Number.isInteger(v.epoch) && v.epoch > 0))
    );
  }

  private normalizeStoredMetadata(value: StoredSessionMetadata): StoredSessionMetadata {
    return {
      ...value,
      epoch:
        typeof value.epoch === "number" && Number.isInteger(value.epoch) && value.epoch > 0
          ? value.epoch
          : 1,
    };
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

    // Update cache with an isolated copy so failed future mutations cannot leak
    // unpersisted state back into readers through shared object references.
    this.metadataCache = this.cloneMetadataMap(metadata);
    this.lastLoadTime = Date.now();

    try {
      const stat = await fs.stat(this.metadataPath);
      this.cachedMetadataMtimeMs = stat.mtimeMs;
      this.cachedMetadataCtimeMs = stat.ctimeMs;
      this.cachedMetadataSize = stat.size;
      this.cachedMetadataMissing = false;
    } catch {
      this.cachedMetadataMtimeMs = null;
      this.cachedMetadataCtimeMs = null;
      this.cachedMetadataSize = null;
      this.cachedMetadataMissing = false;
    }
  }

  private cloneMetadataMap(
    metadata: Map<string, StoredSessionMetadata>
  ): Map<string, StoredSessionMetadata> {
    return new Map(
      Array.from(metadata.entries(), ([sessionId, value]) => [sessionId, { ...value }])
    );
  }

  private readMetadataLockInfo(): { pid?: number; acquiredAt?: number } {
    try {
      const raw = fsRegular.readFileSync(this.metadataLockPath, "utf-8").trim();
      if (!raw) {
        return {};
      }

      const parsed = JSON.parse(raw) as { pid?: unknown; acquiredAt?: unknown };
      return {
        pid:
          typeof parsed.pid === "number" && Number.isInteger(parsed.pid) && parsed.pid > 0
            ? parsed.pid
            : undefined,
        acquiredAt:
          typeof parsed.acquiredAt === "number" && Number.isFinite(parsed.acquiredAt)
            ? parsed.acquiredAt
            : undefined,
      };
    } catch {
      return {};
    }
  }

  private isPidAlive(pid: number): boolean {
    if (!Number.isInteger(pid) || pid <= 0) {
      return false;
    }

    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      return err?.code === "EPERM";
    }
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async withMetadataFileLock<T>(operation: () => Promise<T>): Promise<T> {
    await this.ensureDataDir();

    const deadline = Date.now() + METADATA_LOCK_TIMEOUT_MS;
    let lockHeld = false;

    while (!lockHeld) {
      try {
        await fs.writeFile(
          this.metadataLockPath,
          JSON.stringify({ pid: process.pid, acquiredAt: Date.now() }),
          {
            encoding: "utf-8",
            flag: "wx",
          }
        );
        ACTIVE_METADATA_LOCKS.add(this.metadataLockPath);
        lockHeld = true;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EEXIST") {
          throw error;
        }

        try {
          const stat = await fs.stat(this.metadataLockPath);
          const { pid, acquiredAt } = this.readMetadataLockInfo();
          const fileAgeMs = Date.now() - stat.mtimeMs;
          const recordedAgeMs =
            acquiredAt !== undefined ? Math.max(0, Date.now() - acquiredAt) : fileAgeMs;
          const effectiveAgeMs = Math.min(fileAgeMs, recordedAgeMs);
          const ownerAlive =
            ACTIVE_METADATA_LOCKS.has(this.metadataLockPath) ||
            (pid !== undefined && pid !== process.pid && this.isPidAlive(pid));

          // Fresh lock files can exist briefly before their JSON payload is readable.
          // Treat freshness as authoritative and only reap when the file itself is stale.
          if (effectiveAgeMs > METADATA_LOCK_STALE_MS && !ownerAlive) {
            await fs.rm(this.metadataLockPath, { force: true });
            continue;
          }
        } catch {
          // If the lock file vanished or is unreadable, retry normally.
        }

        if (Date.now() >= deadline) {
          throw new Error(
            `Timed out acquiring session metadata lock after ${METADATA_LOCK_TIMEOUT_MS}ms`
          );
        }

        await this.sleep(METADATA_LOCK_RETRY_MS);
      }
    }

    try {
      return await operation();
    } finally {
      ACTIVE_METADATA_LOCKS.delete(this.metadataLockPath);
      await fs.rm(this.metadataLockPath, { force: true });
    }
  }

  /**
   * Serialize metadata mutations through a single writer chain.
   */
  private async runMetadataMutation<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.mutationChain;

    let releaseCurrent: (() => void) | undefined;
    this.mutationChain = new Promise<void>((resolve) => {
      releaseCurrent = resolve;
    });

    await previous.catch(() => {
      // Preserve queue progress even if a previous mutation failed.
    });

    try {
      return await this.withMetadataFileLock(async () => {
        this.invalidateCache();
        return operation();
      });
    } finally {
      releaseCurrent?.();
    }
  }

  /**
   * Invalidate the cache (force reload on next access).
   */
  invalidateCache(): void {
    this.metadataCache = null;
    this.lastLoadTime = 0;
    this.cachedMetadataMtimeMs = null;
    this.cachedMetadataCtimeMs = null;
    this.cachedMetadataSize = null;
    this.cachedMetadataMissing = true;
  }

  /**
   * Save session metadata.
   */
  async save(meta: SaveSessionInput): Promise<void> {
    await this.runMetadataMutation(async () => {
      const currentMetadata = await this.loadMetadata();
      const nextMetadata = this.cloneMetadataMap(currentMetadata);
      nextMetadata.set(meta.sessionId, {
        ...meta,
        epoch:
          typeof meta.epoch === "number" && Number.isInteger(meta.epoch) && meta.epoch > 0
            ? meta.epoch
            : 1,
        serverVersion: this.serverVersion,
      });
      await this.saveMetadata(nextMetadata);
    });
  }

  /**
   * Load session metadata by ID.
   *
   * Session-file-derived fields are treated as canonical when the file is still
   * accessible, but read paths remain fail-open and never persist healing writes.
   */
  async load(sessionId: string): Promise<StoredSessionMetadata | null> {
    const metadata = await this.loadMetadata();
    const existing = metadata.get(sessionId) ?? null;
    if (!existing) {
      return null;
    }

    return this.resolveStoredMetadataEntryFromSessionFile(existing);
  }

  /**
   * Delete session metadata.
   */
  async delete(sessionId: string, options: { expectedEpoch?: number } = {}): Promise<boolean> {
    return this.runMetadataMutation(async () => {
      const currentMetadata = await this.loadMetadata();
      const existing = currentMetadata.get(sessionId);
      if (!existing) {
        return false;
      }
      if (typeof options.expectedEpoch === "number" && existing.epoch !== options.expectedEpoch) {
        return false;
      }
      const nextMetadata = this.cloneMetadataMap(currentMetadata);
      nextMetadata.delete(sessionId);
      await this.saveMetadata(nextMetadata);
      return true;
    });
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

      const resolvedMeta = fileExists
        ? await this.resolveStoredMetadataEntryFromSessionFile(meta)
        : meta;

      results.push({
        sessionId: resolvedMeta.sessionId,
        sessionName: resolvedMeta.sessionName,
        sessionFile: resolvedMeta.sessionFile,
        sessionPath: resolvedMeta.sessionFile, // Alias for consistency with load_session
        cwd: resolvedMeta.cwd,
        createdAt: resolvedMeta.createdAt,
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

  private getDiscoveryRoots(): string[] {
    return Array.from(
      new Set([this.sessionsDir, ...getDefaultAllowedSessionDirectories(process.cwd())])
    );
  }

  private async collectSessionFiles(rootDir: string): Promise<string[]> {
    const files: string[] = [];
    const stack: Array<{ dir: string; depth: number }> = [{ dir: rootDir, depth: 0 }];
    let visited = 0;

    while (stack.length > 0) {
      if (visited >= MAX_DISCOVERY_NODES) {
        break;
      }

      const item = stack.pop();
      if (!item) {
        break;
      }
      visited++;

      let entries: fsRegular.Dirent[];
      try {
        entries = await fs.readdir(item.dir, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const entry of entries) {
        const fullPath = path.join(item.dir, entry.name);
        if (entry.isDirectory()) {
          if (item.depth < MAX_DISCOVERY_DEPTH) {
            stack.push({ dir: fullPath, depth: item.depth + 1 });
          }
          continue;
        }

        if (entry.isFile() && (entry.name.endsWith(".jsonl") || entry.name.endsWith(".json"))) {
          files.push(fullPath);
        }
      }
    }

    return files;
  }

  /**
   * Discover all accessible session files for this server instance.
   * Scans the global session root and project-local .pi/sessions roots derived
   * from the current working directory ancestry.
   */
  async discoverSessions(): Promise<StoredSessionInfo[]> {
    const results: StoredSessionInfo[] = [];

    for (const rootDir of this.getDiscoveryRoots()) {
      const sessionFiles = await this.collectSessionFiles(rootDir);

      for (const filePath of sessionFiles) {
        const file = path.basename(filePath);
        try {
          const stats = await fs.stat(filePath);

          // Extract timestamp from filename: 2026-02-22T16-09-11-130Z_6f572984.jsonl
          const createdAt = this.extractTimestampFromFilename(file) ?? stats.mtime.toISOString();

          // Use file path as session ID (or extract from filename)
          const sessionId = file.replace(/\.(jsonl|json)$/, "");

          // Read first line to get cwd and sessionName
          const { cwd, sessionName } = await this.readSessionFileMetadata(filePath);

          results.push({
            sessionId,
            sessionFile: filePath,
            sessionPath: filePath, // Alias for consistency with load_session
            cwd,
            sessionName,
            createdAt,
            thinkingLevel: "medium",
            isStreaming: false,
            messageCount: 0,
            fileExists: true,
          });
        } catch {
          // Ignore unreadable/malformed session files during discovery.
        }
      }
    }

    // Sort by creation date (newest first)
    results.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    return results;
  }

  /**
   * Read session metadata from disk.
   *
   * - `cwd` comes from the header line near the top of the file.
   * - `sessionName` comes from the latest persisted `session_info` entry when present,
   *   falling back to header metadata for older file formats.
   */
  async readSessionFileMetadata(filePath: string): Promise<{ cwd: string; sessionName?: string }> {
    let stat: Awaited<ReturnType<typeof fs.stat>>;
    try {
      stat = await fs.stat(filePath);
    } catch {
      return { cwd: "/unknown" };
    }

    const cached = this.sessionFileMetadataCache.get(filePath);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      return cached.metadata;
    }

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
        break; // Header only
      }

      const header = this.parseSessionHeaderMetadata(firstLine);
      const latestSessionName = await this.readLatestSessionNameFromSessionFile(filePath);
      const metadata = {
        cwd: header.cwd,
        sessionName: latestSessionName ?? header.sessionName,
      };

      this.sessionFileMetadataCache.set(filePath, {
        mtimeMs: stat.mtimeMs,
        size: stat.size,
        metadata,
      });

      return metadata;
    } catch {
      const metadata = { cwd: "/unknown" };
      this.sessionFileMetadataCache.set(filePath, {
        mtimeMs: stat.mtimeMs,
        size: stat.size,
        metadata,
      });
      return metadata;
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

  private parseSessionHeaderMetadata(firstLine: string | undefined): {
    cwd: string;
    sessionName?: string;
  } {
    if (!firstLine) {
      return { cwd: "/unknown" };
    }

    try {
      const meta = JSON.parse(firstLine) as {
        cwd?: unknown;
        sessionName?: unknown;
        name?: unknown;
      };
      return {
        cwd: typeof meta.cwd === "string" && meta.cwd.length > 0 ? meta.cwd : "/unknown",
        sessionName: this.normalizePersistedSessionName(meta.sessionName ?? meta.name),
      };
    } catch {
      return { cwd: "/unknown" };
    }
  }

  private normalizePersistedSessionName(value: unknown): string | undefined {
    if (typeof value !== "string") {
      return undefined;
    }

    const normalized = value.trim();
    return normalized.length > 0 ? normalized : undefined;
  }

  private extractSessionNameFromSessionLine(line: string): string | undefined {
    const trimmed = line.trim();
    if (!trimmed) {
      return undefined;
    }

    try {
      const parsed = JSON.parse(trimmed) as {
        type?: unknown;
        sessionName?: unknown;
        name?: unknown;
      };

      if (parsed.type === "session_info") {
        return this.normalizePersistedSessionName(parsed.name);
      }

      return this.normalizePersistedSessionName(parsed.sessionName ?? parsed.name);
    } catch {
      return undefined;
    }
  }

  private async readLatestSessionNameFromSessionFile(
    filePath: string
  ): Promise<string | undefined> {
    let handle: fs.FileHandle | null = null;

    try {
      handle = await fs.open(filePath, "r");
      const stats = await handle.stat();
      let position = stats.size;
      let leftover = Buffer.alloc(0);

      while (position > 0) {
        const readSize = Math.min(SESSION_METADATA_REVERSE_SCAN_CHUNK_BYTES, position);
        position -= readSize;

        const buffer = Buffer.alloc(readSize);
        const { bytesRead } = await handle.read(buffer, 0, readSize, position);
        if (bytesRead <= 0) {
          break;
        }

        const chunk = Buffer.concat([buffer.subarray(0, bytesRead), leftover]);
        let segmentEnd = chunk.length;

        for (let i = chunk.length - 1; i >= 0; i--) {
          if (chunk[i] !== 0x0a) {
            continue;
          }

          const lineBuffer = chunk.subarray(i + 1, segmentEnd);
          segmentEnd = i;
          if (lineBuffer.length === 0) {
            continue;
          }

          const sessionName = this.extractSessionNameFromSessionLine(lineBuffer.toString("utf-8"));
          if (sessionName !== undefined) {
            return sessionName;
          }
        }

        leftover = chunk.subarray(0, segmentEnd);
      }

      const trailingLine = leftover.toString("utf-8").trim();
      return trailingLine ? this.extractSessionNameFromSessionLine(trailingLine) : undefined;
    } catch {
      return undefined;
    } finally {
      await handle?.close();
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

  private async resolveStoredMetadataEntryFromSessionFile(
    meta: StoredSessionMetadata
  ): Promise<StoredSessionMetadata> {
    try {
      await fs.access(meta.sessionFile);
    } catch {
      return meta;
    }

    const fileMetadata = await this.readSessionFileMetadata(meta.sessionFile);
    return {
      ...meta,
      cwd: fileMetadata.cwd !== "/unknown" ? fileMetadata.cwd : meta.cwd,
      sessionName: fileMetadata.sessionName ?? meta.sessionName,
    };
  }

  /**
   * List all sessions (stored + discovered), merged.
   *
   * Session-file metadata is canonical for fields that can drift at runtime
   * (notably `sessionName`). Stored metadata remains authoritative for the
   * stable server-side mapping from runtime sessionId -> session file.
   * Read paths fail open and do not persist healing writes.
   */
  async listAllSessions(): Promise<StoredSessionInfo[]> {
    const [stored, discovered] = await Promise.all([this.listWithInfo(), this.discoverSessions()]);

    // Create map keyed by sessionFile for deduplication
    const byPath = new Map<string, StoredSessionInfo>();

    // Add discovered first
    for (const session of discovered) {
      byPath.set(session.sessionFile, session);
    }

    // Stored entries preserve runtime sessionId mapping, but session-file derived
    // metadata wins for fields that may change after the metadata row was written.
    for (const session of stored) {
      const discoveredSession = byPath.get(session.sessionFile);
      if (!discoveredSession) {
        byPath.set(session.sessionFile, session);
        continue;
      }

      byPath.set(session.sessionFile, {
        ...discoveredSession,
        ...session,
        cwd: discoveredSession.cwd !== "/unknown" ? discoveredSession.cwd : session.cwd,
        sessionName: discoveredSession.sessionName ?? session.sessionName,
      });
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
   * Update or clear the persisted session name in metadata.
   */
  async updateName(
    sessionId: string,
    name?: string,
    options: { expectedEpoch?: number } = {}
  ): Promise<boolean> {
    return this.runMetadataMutation(async () => {
      const currentMetadata = await this.loadMetadata();
      const existing = currentMetadata.get(sessionId);
      if (!existing) {
        return false;
      }
      if (typeof options.expectedEpoch === "number" && existing.epoch !== options.expectedEpoch) {
        return false;
      }
      const nextMetadata = this.cloneMetadataMap(currentMetadata);
      nextMetadata.set(sessionId, {
        ...existing,
        sessionName: typeof name === "string" ? name : undefined,
      });
      await this.saveMetadata(nextMetadata);
      return true;
    });
  }

  /**
   * Clean up metadata entries for sessions whose files no longer exist.
   */
  async cleanup(): Promise<{ removed: number; kept: number }> {
    return this.runMetadataMutation(async () => {
      const currentMetadata = await this.loadMetadata();
      const toRemove: string[] = [];

      for (const [sessionId, meta] of currentMetadata) {
        try {
          await fs.access(meta.sessionFile);
        } catch {
          toRemove.push(sessionId);
        }
      }

      if (toRemove.length === 0) {
        return { removed: 0, kept: currentMetadata.size };
      }

      const nextMetadata = this.cloneMetadataMap(currentMetadata);
      for (const sessionId of toRemove) {
        nextMetadata.delete(sessionId);
      }

      await this.saveMetadata(nextMetadata);

      return { removed: toRemove.length, kept: nextMetadata.size };
    });
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

  /**
   * Get a stable snapshot key for metadata visibility invalidation.
   * SessionControlPlane uses this to detect cross-process/session-store drift.
   */
  async getMetadataSnapshotKey(): Promise<string> {
    try {
      const stat = await fs.stat(this.metadataPath);
      return `present:${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return "missing";
      }
      throw error;
    }
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
          console.error(
            `[SessionStore] Periodic cleanup removed ${result.removed} orphaned entries`
          );
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
