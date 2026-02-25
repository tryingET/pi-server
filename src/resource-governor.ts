/**
 * ResourceGovernor - Enforces all resource limits for pi-server.
 *
 * A single nexus point for:
 * - Message size limits (prevents OOM)
 * - Session limits (prevents resource exhaustion)
 * - Rate limiting (prevents abuse)
 * - Heartbeat tracking (enables zombie detection)
 *
 * Makes testing trivial (mock the governor).
 */

export interface ResourceGovernorConfig {
  /** Maximum concurrent sessions (default: 100) */
  maxSessions: number;
  /** Maximum message size in bytes (default: 10MB) */
  maxMessageSizeBytes: number;
  /** Maximum commands per minute per session (default: 100) */
  maxCommandsPerMinute: number;
  /** Maximum commands per minute globally across all sessions (default: 1000) */
  maxGlobalCommandsPerMinute: number;
  /** Heartbeat interval in ms for zombie detection (default: 30000) */
  heartbeatIntervalMs: number;
  /** Time without heartbeat before session is considered zombie (default: 5 min) */
  zombieTimeoutMs: number;
}

export const DEFAULT_CONFIG: ResourceGovernorConfig = {
  maxSessions: 100,
  maxMessageSizeBytes: 10 * 1024 * 1024, // 10MB
  maxCommandsPerMinute: 100,
  maxGlobalCommandsPerMinute: 1000,
  heartbeatIntervalMs: 30000,
  zombieTimeoutMs: 5 * 60 * 1000, // 5 minutes
};

export interface GovernorMetrics {
  sessionCount: number;
  totalCommandsExecuted: number;
  commandsRejected: {
    sessionLimit: number;
    messageSize: number;
    rateLimit: number;
    globalRateLimit: number;
  };
  zombieSessionsDetected: number;
  rateLimitUsage: {
    globalCount: number;
    globalLimit: number;
  };
}

export interface RejectionResult {
  allowed: false;
  reason: string;
}

export interface AllowResult {
  allowed: true;
}

export type GovernorResult = AllowResult | RejectionResult;

/**
 * ResourceGovernor enforces resource limits for the server.
 * 
 * Memory management:
 * - Rate limit timestamps are cleaned up when they exceed a threshold
 * - Session-specific data is cleaned up when sessions are deleted
 * - Call cleanupStaleData() after deleting sessions
 */

/** Threshold for triggering automatic timestamp cleanup */
const TIMESTAMP_CLEANUP_THRESHOLD = 10000;

export class ResourceGovernor {
  private sessionCount = 0;
  private commandTimestamps = new Map<string, number[]>();
  private globalCommandTimestamps: number[] = [];
  private lastHeartbeat = new Map<string, number>();
  private totalCommandsExecuted = 0;
  private commandsRejected = {
    sessionLimit: 0,
    messageSize: 0,
    rateLimit: 0,
    globalRateLimit: 0,
  };
  private zombieSessionsDetected = 0;

  constructor(private config: ResourceGovernorConfig = DEFAULT_CONFIG) {}

  // ==========================================================================
  // CONFIG ACCESS
  // ==========================================================================

  getConfig(): Readonly<ResourceGovernorConfig> {
    return this.config;
  }

  // ==========================================================================
  // SESSION LIMITS
  // ==========================================================================

  /**
   * Atomically check and reserve a session slot.
   * Returns true if slot was reserved, false if limit reached.
   * Use this instead of canCreateSession + registerSession to avoid races.
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
   */
  releaseSessionSlot(): void {
    this.sessionCount = Math.max(0, this.sessionCount - 1);
  }

  /**
   * Check if a new session can be created.
   * WARNING: Not atomic - use tryReserveSessionSlot for race-free operation.
   * @deprecated Use tryReserveSessionSlot instead
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
   * Register a new session. Call AFTER session is created.
   * WARNING: Not atomic - use tryReserveSessionSlot for race-free operation.
   * @deprecated Use tryReserveSessionSlot instead
   */
  registerSession(sessionId: string): void {
    this.sessionCount++;
    this.recordHeartbeat(sessionId);
  }

  /**
   * Unregister a session. Call AFTER session is deleted.
   */
  unregisterSession(sessionId: string): void {
    this.sessionCount = Math.max(0, this.sessionCount - 1);
    this.lastHeartbeat.delete(sessionId);
    this.commandTimestamps.delete(sessionId);
  }

  /**
   * Get current session count.
   */
  getSessionCount(): number {
    return this.sessionCount;
  }

  // ==========================================================================
  // MESSAGE SIZE LIMITS
  // ==========================================================================

  /**
   * Check if a message of the given size can be accepted.
   * Rejects negative sizes, NaN, and sizes exceeding the limit.
   */
  canAcceptMessage(sizeBytes: number): GovernorResult {
    // Check for invalid sizes (negative, NaN, Infinity)
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

  /** Rate limit window in ms (1 minute) */
  private static readonly RATE_WINDOW_MS = 60000;

  /**
   * Check if a command can be executed for the given session.
   * Implements sliding window rate limiting (both per-session and global).
   * 
   * IMPORTANT: Call this AFTER validation passes, not before.
   * Invalid commands should not count against the rate limit.
   */
  canExecuteCommand(sessionId: string): GovernorResult {
    const now = Date.now();
    const windowStart = now - ResourceGovernor.RATE_WINDOW_MS;

    // Auto-cleanup if global timestamps exceed threshold (prevents unbounded memory)
    if (this.globalCommandTimestamps.length > TIMESTAMP_CLEANUP_THRESHOLD) {
      this.globalCommandTimestamps = this.globalCommandTimestamps.filter((t) => t > windowStart);
    }

    // Check global rate limit first
    this.globalCommandTimestamps = this.globalCommandTimestamps.filter((t) => t > windowStart);
    if (this.globalCommandTimestamps.length >= this.config.maxGlobalCommandsPerMinute) {
      this.commandsRejected.globalRateLimit++;
      return {
        allowed: false,
        reason: `Global rate limit exceeded (${this.config.maxGlobalCommandsPerMinute} commands/minute)`,
      };
    }

    // Check per-session rate limit
    let timestamps = this.commandTimestamps.get(sessionId);
    if (!timestamps) {
      timestamps = [];
      this.commandTimestamps.set(sessionId, timestamps);
    } else {
      // Filter to commands within the window
      timestamps = timestamps.filter((t) => t > windowStart);
      this.commandTimestamps.set(sessionId, timestamps);
    }

    if (timestamps.length >= this.config.maxCommandsPerMinute) {
      this.commandsRejected.rateLimit++;
      return {
        allowed: false,
        reason: `Rate limit exceeded (${this.config.maxCommandsPerMinute} commands/minute)`,
      };
    }

    // Record this command in both buckets
    timestamps.push(now);
    this.globalCommandTimestamps.push(now);
    this.totalCommandsExecuted++;

    return { allowed: true };
  }

  /**
   * Get current rate limit usage for observability.
   */
  getRateLimitUsage(sessionId: string): { session: number; global: number } {
    const now = Date.now();
    const windowStart = now - ResourceGovernor.RATE_WINDOW_MS;
    
    const sessionTimestamps = this.commandTimestamps.get(sessionId)?.filter((t) => t > windowStart) ?? [];
    const globalCount = this.globalCommandTimestamps.filter((t) => t > windowStart).length;
    
    return {
      session: sessionTimestamps.length,
      global: globalCount,
    };
  }

  // ==========================================================================
  // HEARTBEAT / ZOMBIE DETECTION
  // ==========================================================================

  /**
   * Record a heartbeat for a session (activity indicator).
   * Call when the session is active.
   */
  recordHeartbeat(sessionId: string): void {
    this.lastHeartbeat.set(sessionId, Date.now());
  }

  /**
   * Get list of session IDs that have not sent a heartbeat recently.
   * These are potential "zombie" sessions.
   */
  getZombieSessions(): string[] {
    const now = Date.now();
    const zombies: string[] = [];

    for (const [sessionId, lastTime] of this.lastHeartbeat) {
      if (now - lastTime > this.config.zombieTimeoutMs) {
        zombies.push(sessionId);
      }
    }

    if (zombies.length > 0) {
      this.zombieSessionsDetected += zombies.length;
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
    const windowStart = now - ResourceGovernor.RATE_WINDOW_MS;
    const globalCount = this.globalCommandTimestamps.filter((t) => t > windowStart).length;
    
    return {
      sessionCount: this.sessionCount,
      totalCommandsExecuted: this.totalCommandsExecuted,
      commandsRejected: { ...this.commandsRejected },
      zombieSessionsDetected: this.zombieSessionsDetected,
      rateLimitUsage: {
        globalCount,
        globalLimit: this.config.maxGlobalCommandsPerMinute,
      },
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
    };
    this.zombieSessionsDetected = 0;
  }

  // ==========================================================================
  // CLEANUP
  // ==========================================================================

  /**
   * Clean up stale rate limit data.
   * Call periodically to prevent memory leaks from old timestamps.
   */
  cleanupStaleTimestamps(): void {
    const now = Date.now();
    const windowStart = now - ResourceGovernor.RATE_WINDOW_MS;

    // Clean global timestamps
    this.globalCommandTimestamps = this.globalCommandTimestamps.filter((t) => t > windowStart);

    // Clean per-session timestamps
    for (const [sessionId, timestamps] of this.commandTimestamps) {
      const filtered = timestamps.filter((t) => t > windowStart);
      if (filtered.length === 0) {
        this.commandTimestamps.delete(sessionId);
      } else {
        this.commandTimestamps.set(sessionId, filtered);
      }
    }
  }

  /**
   * Clean up stale data for deleted sessions.
   * Call when a session is deleted.
   */
  cleanupStaleData(activeSessionIds: Set<string>): void {
    // Clean up command timestamps for sessions that no longer exist
    for (const sessionId of this.commandTimestamps.keys()) {
      if (!activeSessionIds.has(sessionId)) {
        this.commandTimestamps.delete(sessionId);
      }
    }

    // Clean up heartbeat data for sessions that no longer exist
    for (const sessionId of this.lastHeartbeat.keys()) {
      if (!activeSessionIds.has(sessionId)) {
        this.lastHeartbeat.delete(sessionId);
      }
    }
  }
}
