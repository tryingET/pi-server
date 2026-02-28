/**
 * ResourceGovernor - Enforces all resource limits for pi-server.
 *
 * A single nexus point for:
 * - Message size limits (prevents OOM)
 * - Session limits (prevents resource exhaustion)
 * - Rate limiting (prevents abuse)
 * - Heartbeat tracking (enables zombie detection)
 * - Connection limits (prevents DoS)
 *
 * Makes testing trivial (mock the governor).
 */

import type { MetricsEmitter } from "./metrics-emitter.js";
import { MetricNames } from "./metrics-types.js";

// ============================================================================
// CONFIG
// ============================================================================

export interface ResourceGovernorConfig {
  /** Maximum concurrent sessions (default: 100) */
  maxSessions: number;
  /** Maximum message size in bytes (default: 10MB) */
  maxMessageSizeBytes: number;
  /** Maximum commands per minute per session (default: 100) */
  maxCommandsPerMinute: number;
  /** Maximum commands per minute globally across all sessions (default: 1000) */
  maxGlobalCommandsPerMinute: number;
  /** Maximum concurrent WebSocket connections (default: 1000) */
  maxConnections: number;
  /** Heartbeat interval in ms for zombie detection (default: 30000) */
  heartbeatIntervalMs: number;
  /** Time without heartbeat before session is considered zombie (default: 5 min) */
  zombieTimeoutMs: number;
  /** Maximum extension_ui_response commands per minute per session (default: 60) */
  maxExtensionUIResponsePerMinute: number;
  /** Maximum session lifetime in ms (0 = unlimited, default: 24 hours) */
  maxSessionLifetimeMs: number;
}

export const DEFAULT_CONFIG: ResourceGovernorConfig = {
  maxSessions: 100,
  maxMessageSizeBytes: 10 * 1024 * 1024, // 10MB
  maxCommandsPerMinute: 100,
  maxGlobalCommandsPerMinute: 1000,
  maxConnections: 1000,
  heartbeatIntervalMs: 30000,
  zombieTimeoutMs: 5 * 60 * 1000, // 5 minutes
  maxExtensionUIResponsePerMinute: 60, // 1 per second on average
  maxSessionLifetimeMs: 24 * 60 * 60 * 1000, // 24 hours
};

// ============================================================================
// METRICS
// ============================================================================

export interface GovernorMetrics {
  sessionCount: number;
  connectionCount: number;
  totalCommandsExecuted: number;
  commandsRejected: {
    sessionLimit: number;
    messageSize: number;
    rateLimit: number;
    globalRateLimit: number;
    connectionLimit: number;
    extensionUIResponseRateLimit: number;
  };
  zombieSessionsDetected: number;
  zombieSessionsCleaned: number;
  /** Count of double-unregister errors (session or connection unregistered twice) */
  doubleUnregisterErrors: number;
  rateLimitUsage: {
    globalCount: number;
    globalLimit: number;
  };
}

// ============================================================================
// RESULT TYPES
// ============================================================================

export interface RejectionResult {
  allowed: false;
  reason: string;
}

export interface AllowResult {
  allowed: true;
}

export type GovernorResult = AllowResult | RejectionResult;

// ============================================================================
// CONSTANTS
// ============================================================================

/** Threshold for triggering automatic timestamp cleanup */
const TIMESTAMP_CLEANUP_THRESHOLD = 10000;

/** Rate limit window in ms (1 minute) */
const RATE_WINDOW_MS = 60000;

/** Default interval for periodic timestamp cleanup (5 minutes) */
const DEFAULT_TIMESTAMP_CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

/** Session ID max length */
const SESSION_ID_MAX_LENGTH = 256;

/** CWD max length */
const CWD_MAX_LENGTH = 4096;

/** Valid session ID pattern (alphanumeric, dash, underscore, dot) */
const SESSION_ID_PATTERN = /^[a-zA-Z0-9_.-]+$/;

/** Dangerous path patterns */
const DANGEROUS_PATH_PATTERNS = [/\.\./, /^~/];

/**
 * Rate limit timestamp with generation marker.
 * The generation ensures refundCommand removes the correct entry
 * even when multiple commands have the same timestamp.
 */
interface RateLimitEntry {
  timestamp: number;
  /** Unique generation marker for this entry */
  generation: number;
}

// ============================================================================
// GOVERNOR CLASS
// ============================================================================

/**
 * ResourceGovernor enforces resource limits for the server.
 *
 * Memory management:
 * - Rate limit timestamps are cleaned up periodically via startPeriodicCleanup()
 * - Session-specific data is cleaned up when sessions are deleted
 * - Call cleanupStaleData() after deleting sessions
 */
export class ResourceGovernor {
  private sessionCount = 0;
  private connectionCount = 0;
  private commandTimestamps = new Map<string, RateLimitEntry[]>();
  private globalCommandTimestamps: RateLimitEntry[] = [];
  private extensionUIResponseTimestamps = new Map<string, RateLimitEntry[]>();
  private lastHeartbeat = new Map<string, number>();
  private sessionCreatedAt = new Map<string, number>();
  private totalCommandsExecuted = 0;
  private commandsRejected = {
    sessionLimit: 0,
    messageSize: 0,
    rateLimit: 0,
    globalRateLimit: 0,
    connectionLimit: 0,
    extensionUIResponseRateLimit: 0,
  };
  private zombieSessionsDetected = 0;
  private zombieSessionsCleaned = 0;
  private doubleUnregisterErrors = 0;

  /** Generation counter for unique rate limit entry IDs */
  private generationCounter = 0;

  /** Periodic cleanup timer for stale timestamps */
  private cleanupTimer: NodeJS.Timeout | null = null;

  constructor(
    private config: ResourceGovernorConfig = DEFAULT_CONFIG,
    private metrics?: MetricsEmitter
  ) {}

  /**
   * Set the metrics emitter for monitoring.
   * Can be called after construction to wire up metrics.
   */
  setMetrics(metrics: MetricsEmitter): void {
    this.metrics = metrics;
  }

  /**
   * Increment generation counter and emit metric.
   * Used for unique rate limit entry IDs and overflow monitoring.
   */
  private nextGeneration(): number {
    const generation = ++this.generationCounter;

    // Emit metric for threshold alerting (e.g., overflow at 1e15)
    if (this.metrics && generation % 1000 === 0) {
      this.metrics.gauge(MetricNames.RATE_LIMIT_GENERATION_COUNTER, generation);
    }

    return generation;
  }

  // ==========================================================================
  // CONFIG ACCESS
  // ==========================================================================

  getConfig(): Readonly<ResourceGovernorConfig> {
    return this.config;
  }

  // ==========================================================================
  // SESSION ID VALIDATION
  // ==========================================================================

  /**
   * Validate a session ID.
   * Returns null if valid, or an error message if invalid.
   */
  validateSessionId(sessionId: string): string | null {
    if (!sessionId || typeof sessionId !== "string") {
      return "Session ID must be a non-empty string";
    }
    if (sessionId.length > SESSION_ID_MAX_LENGTH) {
      return `Session ID too long (max ${SESSION_ID_MAX_LENGTH} characters)`;
    }
    if (!SESSION_ID_PATTERN.test(sessionId)) {
      return "Session ID must contain only alphanumeric characters, underscores, dashes, and dots";
    }
    return null;
  }

  // ==========================================================================
  // CWD VALIDATION
  // ==========================================================================

  /**
   * Validate a working directory path.
   * Returns null if valid, or an error message if invalid.
   */
  validateCwd(cwd: string): string | null {
    if (!cwd || typeof cwd !== "string") {
      return "CWD must be a non-empty string";
    }
    if (cwd.length > CWD_MAX_LENGTH) {
      return `CWD too long (max ${CWD_MAX_LENGTH} characters)`;
    }
    for (const pattern of DANGEROUS_PATH_PATTERNS) {
      if (pattern.test(cwd)) {
        return "CWD contains potentially dangerous path components";
      }
    }
    return null;
  }

  // ==========================================================================
  // SESSION LIMITS
  // ==========================================================================

  /**
   * Atomically check and reserve a session slot.
   * Returns true if slot was reserved, false if limit reached.
   */
  tryReserveSessionSlot(): boolean {
    if (this.sessionCount >= this.config.maxSessions) {
      this.commandsRejected.sessionLimit++;
      return false;
    }
    this.sessionCount++;
    return true;
  }

  /**
   * Release a reserved session slot (used if session creation fails after reservation).
   * Tracks double-unregister as error metric instead of silently masking.
   */
  releaseSessionSlot(): void {
    this.sessionCount--;
    if (this.sessionCount < 0) {
      this.doubleUnregisterErrors++;
      this.sessionCount = 0;
      console.error(
        "[ResourceGovernor] ERROR: releaseSessionSlot called with no active slots (double-unregister)"
      );
    }
  }

  /**
   * Check if a new session can be created.
   * @deprecated Use tryReserveSessionSlot for atomic operation. Will be removed in v2.0.0.
   */
  canCreateSession(): GovernorResult {
    if (this.sessionCount >= this.config.maxSessions) {
      this.commandsRejected.sessionLimit++;
      return {
        allowed: false,
        reason: `Session limit reached (${this.config.maxSessions} sessions)`,
      };
    }
    return { allowed: true };
  }

  /**
   * Register a new session.
   * @deprecated Use tryReserveSessionSlot for atomic operation. Will be removed in v2.0.0.
   */
  registerSession(sessionId: string): void {
    this.sessionCount++;
    this.recordHeartbeat(sessionId);
  }

  /**
   * Unregister a session. Call AFTER session is deleted.
   * Also cleans up rate limit timestamps for this session.
   */
  unregisterSession(sessionId: string): void {
    this.sessionCount--;
    if (this.sessionCount < 0) {
      this.doubleUnregisterErrors++;
      this.sessionCount = 0;
      console.error(
        `[ResourceGovernor] ERROR: unregisterSession('${sessionId}') called with no active slots (double-unregister)`
      );
    }
    this.lastHeartbeat.delete(sessionId);
    this.sessionCreatedAt.delete(sessionId);
    this.commandTimestamps.delete(sessionId);
  }

  /**
   * Get current session count.
   */
  getSessionCount(): number {
    return this.sessionCount;
  }

  // ==========================================================================
  // CONNECTION LIMITS
  // ==========================================================================

  /**
   * Check if a new connection can be accepted.
   */
  canAcceptConnection(): GovernorResult {
    if (this.connectionCount >= this.config.maxConnections) {
      this.commandsRejected.connectionLimit++;
      return {
        allowed: false,
        reason: `Connection limit reached (${this.config.maxConnections} connections)`,
      };
    }
    return { allowed: true };
  }

  /**
   * Register a new connection.
   */
  registerConnection(): void {
    this.connectionCount++;
  }

  /**
   * Unregister a connection.
   * Tracks double-unregister as error metric instead of silently masking.
   */
  unregisterConnection(): void {
    this.connectionCount--;
    if (this.connectionCount < 0) {
      this.doubleUnregisterErrors++;
      this.connectionCount = 0;
      console.error(
        "[ResourceGovernor] ERROR: unregisterConnection called with no active connections (double-unregister)"
      );
    }
  }

  /**
   * Get current connection count.
   */
  getConnectionCount(): number {
    return this.connectionCount;
  }

  // ==========================================================================
  // MESSAGE SIZE LIMITS
  // ==========================================================================

  /**
   * Check if a message of the given size can be accepted.
   * Rejects negative sizes, NaN, and sizes exceeding the limit.
   */
  canAcceptMessage(sizeBytes: number): GovernorResult {
    if (!Number.isFinite(sizeBytes) || sizeBytes < 0) {
      this.commandsRejected.messageSize++;
      return {
        allowed: false,
        reason: `Invalid message size: ${sizeBytes}`,
      };
    }

    if (sizeBytes > this.config.maxMessageSizeBytes) {
      this.commandsRejected.messageSize++;
      return {
        allowed: false,
        reason: `Message size ${sizeBytes} exceeds limit ${this.config.maxMessageSizeBytes}`,
      };
    }
    return { allowed: true };
  }

  // ==========================================================================
  // RATE LIMITING
  // ==========================================================================

  /**
   * Check if a command can be executed for the given session.
   * Implements sliding window rate limiting (both per-session and global).
   *
   * @returns The generation marker for refund, or rejection result
   */
  canExecuteCommand(sessionId: string): GovernorResult & { generation?: number } {
    const now = Date.now();
    const windowStart = now - RATE_WINDOW_MS;

    // Auto-cleanup if global timestamps exceed threshold
    if (this.globalCommandTimestamps.length > TIMESTAMP_CLEANUP_THRESHOLD) {
      this.globalCommandTimestamps = this.globalCommandTimestamps.filter(
        (e) => e.timestamp > windowStart
      );
    } else {
      // Normal filter
      this.globalCommandTimestamps = this.globalCommandTimestamps.filter(
        (e) => e.timestamp > windowStart
      );
    }

    // Check global rate limit first
    if (this.globalCommandTimestamps.length >= this.config.maxGlobalCommandsPerMinute) {
      this.commandsRejected.globalRateLimit++;
      return {
        allowed: false,
        reason: `Global rate limit exceeded (${this.config.maxGlobalCommandsPerMinute} commands/minute)`,
      };
    }

    // Check per-session rate limit
    let entries = this.commandTimestamps.get(sessionId);
    if (!entries) {
      entries = [];
      this.commandTimestamps.set(sessionId, entries);
    } else {
      entries = entries.filter((e) => e.timestamp > windowStart);
      this.commandTimestamps.set(sessionId, entries);
    }

    if (entries.length >= this.config.maxCommandsPerMinute) {
      this.commandsRejected.rateLimit++;
      return {
        allowed: false,
        reason: `Rate limit exceeded (${this.config.maxCommandsPerMinute} commands/minute)`,
      };
    }

    // Record this command with unique generation marker
    const generation = this.nextGeneration();
    const entry: RateLimitEntry = { timestamp: now, generation };
    entries.push(entry);
    this.globalCommandTimestamps.push(entry);
    this.totalCommandsExecuted++;

    return { allowed: true, generation };
  }

  /**
   * Refund a previously counted command (e.g. command failed before execution).
   * Uses generation marker to ensure correct entry is removed.
   */
  refundCommand(sessionId: string, generation: number): void {
    const sessionEntries = this.commandTimestamps.get(sessionId);
    if (!sessionEntries) {
      return;
    }

    // Find and remove the entry with matching generation
    const sessionIdx = sessionEntries.findIndex((e) => e.generation === generation);
    if (sessionIdx === -1) {
      return; // Already removed or never existed
    }

    sessionEntries.splice(sessionIdx, 1);
    if (sessionEntries.length === 0) {
      this.commandTimestamps.delete(sessionId);
    }

    // Remove from global timestamps using generation marker
    const globalIdx = this.globalCommandTimestamps.findIndex((e) => e.generation === generation);
    if (globalIdx !== -1) {
      this.globalCommandTimestamps.splice(globalIdx, 1);
    }

    if (this.totalCommandsExecuted > 0) {
      this.totalCommandsExecuted--;
    }
  }

  /**
   * Get current rate limit usage for observability.
   */
  getRateLimitUsage(sessionId: string): { session: number; global: number } {
    const now = Date.now();
    const windowStart = now - RATE_WINDOW_MS;

    const sessionCount =
      this.commandTimestamps.get(sessionId)?.filter((e) => e.timestamp > windowStart).length ?? 0;
    const globalCount = this.globalCommandTimestamps.filter(
      (e) => e.timestamp > windowStart
    ).length;

    return {
      session: sessionCount,
      global: globalCount,
    };
  }

  // ==========================================================================
  // EXTENSION UI RESPONSE RATE LIMITING
  // ==========================================================================

  /**
   * Check if an extension_ui_response command can be executed for the given session.
   * This is a separate, more restrictive rate limit to prevent abuse of UI responses.
   */
  canExecuteExtensionUIResponse(sessionId: string): GovernorResult {
    const now = Date.now();
    const windowStart = now - RATE_WINDOW_MS;

    let entries = this.extensionUIResponseTimestamps.get(sessionId);
    if (!entries) {
      entries = [];
      this.extensionUIResponseTimestamps.set(sessionId, entries);
    } else {
      entries = entries.filter((e) => e.timestamp > windowStart);
      this.extensionUIResponseTimestamps.set(sessionId, entries);
    }

    if (entries.length >= this.config.maxExtensionUIResponsePerMinute) {
      this.commandsRejected.extensionUIResponseRateLimit++;
      return {
        allowed: false,
        reason: `Extension UI response rate limit exceeded (${this.config.maxExtensionUIResponsePerMinute} responses/minute)`,
      };
    }

    // Record this response with generation marker
    const generation = this.nextGeneration();
    entries.push({ timestamp: now, generation });
    return { allowed: true };
  }

  // ==========================================================================
  // HEARTBEAT / ZOMBIE DETECTION
  // ==========================================================================

  /**
   * Record a heartbeat for a session.
   * Also tracks session creation time for lifetime enforcement.
   */
  recordHeartbeat(sessionId: string): void {
    const now = Date.now();
    this.lastHeartbeat.set(sessionId, now);
    // Track creation time if this is a new session
    if (!this.sessionCreatedAt.has(sessionId)) {
      this.sessionCreatedAt.set(sessionId, now);
    }
  }

  /**
   * Get list of zombie session IDs.
   *
   * @param recordDetection Whether to increment zombie detection metrics.
   */
  getZombieSessions(recordDetection = true): string[] {
    const now = Date.now();
    const zombies: string[] = [];

    for (const [sessionId, lastTime] of this.lastHeartbeat) {
      if (now - lastTime > this.config.zombieTimeoutMs) {
        zombies.push(sessionId);
      }
    }

    if (recordDetection && zombies.length > 0) {
      this.zombieSessionsDetected += zombies.length;
    }

    return zombies;
  }

  /**
   * Clean up zombie sessions. Returns IDs of cleaned sessions.
   * Call this periodically or when you want to force cleanup.
   */
  cleanupZombieSessions(): string[] {
    const zombies = this.getZombieSessions();
    for (const sessionId of zombies) {
      this.lastHeartbeat.delete(sessionId);
      this.commandTimestamps.delete(sessionId);
    }
    if (zombies.length > 0) {
      this.zombieSessionsCleaned += zombies.length;
    }
    return zombies;
  }

  /**
   * Get the last heartbeat time for a session.
   */
  getLastHeartbeat(sessionId: string): number | undefined {
    return this.lastHeartbeat.get(sessionId);
  }

  // ==========================================================================
  // METRICS
  // ==========================================================================

  /**
   * Get current metrics for observability.
   */
  getMetrics(): GovernorMetrics {
    const now = Date.now();
    const windowStart = now - RATE_WINDOW_MS;
    const globalCount = this.globalCommandTimestamps.filter(
      (e) => e.timestamp > windowStart
    ).length;

    return {
      sessionCount: this.sessionCount,
      connectionCount: this.connectionCount,
      totalCommandsExecuted: this.totalCommandsExecuted,
      commandsRejected: { ...this.commandsRejected },
      zombieSessionsDetected: this.zombieSessionsDetected,
      zombieSessionsCleaned: this.zombieSessionsCleaned,
      doubleUnregisterErrors: this.doubleUnregisterErrors,
      rateLimitUsage: {
        globalCount,
        globalLimit: this.config.maxGlobalCommandsPerMinute,
      },
    };
  }

  /**
   * Check if the server is healthy.
   */
  isHealthy(): { healthy: boolean; issues: string[] } {
    const issues: string[] = [];

    if (this.sessionCount >= this.config.maxSessions * 0.9) {
      issues.push(`Session count at ${this.sessionCount}/${this.config.maxSessions} (90%+)`);
    }
    if (this.connectionCount >= this.config.maxConnections * 0.9) {
      issues.push(
        `Connection count at ${this.connectionCount}/${this.config.maxConnections} (90%+)`
      );
    }

    const zombies = this.getZombieSessions(false);
    if (zombies.length > 0) {
      issues.push(`${zombies.length} zombie sessions detected`);
    }

    return {
      healthy: issues.length === 0,
      issues,
    };
  }

  /**
   * Reset metrics (useful for testing).
   */
  resetMetrics(): void {
    this.totalCommandsExecuted = 0;
    this.commandsRejected = {
      sessionLimit: 0,
      messageSize: 0,
      rateLimit: 0,
      globalRateLimit: 0,
      connectionLimit: 0,
      extensionUIResponseRateLimit: 0,
    };
    this.zombieSessionsDetected = 0;
    this.zombieSessionsCleaned = 0;
  }

  // ==========================================================================
  // CLEANUP
  // ==========================================================================

  /**
   * Clean up stale rate limit data.
   * Also cleans extensionUIResponseTimestamps.
   */
  cleanupStaleTimestamps(): void {
    const now = Date.now();
    const windowStart = now - RATE_WINDOW_MS;

    this.globalCommandTimestamps = this.globalCommandTimestamps.filter(
      (e) => e.timestamp > windowStart
    );

    for (const [sessionId, entries] of this.commandTimestamps) {
      const filtered = entries.filter((e) => e.timestamp > windowStart);
      if (filtered.length === 0) {
        this.commandTimestamps.delete(sessionId);
      } else {
        this.commandTimestamps.set(sessionId, filtered);
      }
    }

    // Also clean extension UI response timestamps
    for (const [sessionId, entries] of this.extensionUIResponseTimestamps) {
      const filtered = entries.filter((e) => e.timestamp > windowStart);
      if (filtered.length === 0) {
        this.extensionUIResponseTimestamps.delete(sessionId);
      } else {
        this.extensionUIResponseTimestamps.set(sessionId, filtered);
      }
    }
  }

  /**
   * Start periodic cleanup of stale timestamps.
   * Call this during server startup to prevent memory leaks from inactive sessions.
   * @param intervalMs Cleanup interval (default: 5 minutes)
   */
  startPeriodicCleanup(intervalMs = DEFAULT_TIMESTAMP_CLEANUP_INTERVAL_MS): void {
    if (this.cleanupTimer) {
      return; // Already running
    }

    this.cleanupTimer = setInterval(() => {
      this.cleanupStaleTimestamps();
    }, intervalMs);

    // Don't prevent process exit
    if (this.cleanupTimer.unref) {
      this.cleanupTimer.unref();
    }
  }

  /**
   * Stop periodic cleanup.
   */
  stopPeriodicCleanup(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  /**
   * Clean up stale data for deleted sessions.
   */
  cleanupStaleData(activeSessionIds: Set<string>): void {
    for (const sessionId of this.commandTimestamps.keys()) {
      if (!activeSessionIds.has(sessionId)) {
        this.commandTimestamps.delete(sessionId);
      }
    }

    for (const sessionId of this.lastHeartbeat.keys()) {
      if (!activeSessionIds.has(sessionId)) {
        this.lastHeartbeat.delete(sessionId);
      }
    }

    for (const sessionId of this.sessionCreatedAt.keys()) {
      if (!activeSessionIds.has(sessionId)) {
        this.sessionCreatedAt.delete(sessionId);
      }
    }

    for (const sessionId of this.extensionUIResponseTimestamps.keys()) {
      if (!activeSessionIds.has(sessionId)) {
        this.extensionUIResponseTimestamps.delete(sessionId);
      }
    }
  }

  // ==========================================================================
  // SESSION LIFETIME
  // ==========================================================================

  /**
   * Get list of expired session IDs (exceeded maxSessionLifetimeMs).
   * Returns empty array if maxSessionLifetimeMs is 0 (unlimited).
   */
  getExpiredSessions(): string[] {
    if (this.config.maxSessionLifetimeMs === 0) {
      return [];
    }

    const now = Date.now();
    const expired: string[] = [];

    for (const [sessionId, createdAt] of this.sessionCreatedAt) {
      if (now - createdAt > this.config.maxSessionLifetimeMs) {
        expired.push(sessionId);
      }
    }

    return expired;
  }

  /**
   * Get the creation time for a session.
   */
  getSessionCreatedAt(sessionId: string): number | undefined {
    return this.sessionCreatedAt.get(sessionId);
  }
}
