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
}

export const DEFAULT_CONFIG: ResourceGovernorConfig = {
  maxSessions: 100,
  maxMessageSizeBytes: 10 * 1024 * 1024, // 10MB
  maxCommandsPerMinute: 100,
  maxGlobalCommandsPerMinute: 1000,
  maxConnections: 1000,
  heartbeatIntervalMs: 30000,
  zombieTimeoutMs: 5 * 60 * 1000, // 5 minutes
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
  };
  zombieSessionsDetected: number;
  zombieSessionsCleaned: number;
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

/** Session ID max length */
const SESSION_ID_MAX_LENGTH = 256;

/** Valid session ID pattern (alphanumeric, dash, underscore, dot) */
const SESSION_ID_PATTERN = /^[a-zA-Z0-9_.-]+$/;

/** Dangerous path patterns */
const DANGEROUS_PATH_PATTERNS = [/\.\./, /^\//, /^~/, /^\//];

// ============================================================================
// GOVERNOR CLASS
// ============================================================================

/**
 * ResourceGovernor enforces resource limits for the server.
 * 
 * Memory management:
 * - Rate limit timestamps are cleaned up when they exceed a threshold
 * - Session-specific data is cleaned up when sessions are deleted
 * - Call cleanupStaleData() after deleting sessions
 */
export class ResourceGovernor {
  private sessionCount = 0;
  private connectionCount = 0;
  private commandTimestamps = new Map<string, number[]>();
  private globalCommandTimestamps: number[] = [];
  private lastHeartbeat = new Map<string, number>();
  private totalCommandsExecuted = 0;
  private commandsRejected = {
    sessionLimit: 0,
    messageSize: 0,
    rateLimit: 0,
    globalRateLimit: 0,
    connectionLimit: 0,
  };
  private zombieSessionsDetected = 0;
  private zombieSessionsCleaned = 0;

  constructor(private config: ResourceGovernorConfig = DEFAULT_CONFIG) {}

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
   * Asserts that count doesn't go negative in development.
   */
  releaseSessionSlot(): void {
    this.sessionCount--;
    if (this.sessionCount < 0) {
      console.error("[ResourceGovernor] WARNING: sessionCount went negative, resetting to 0");
      this.sessionCount = 0;
    }
  }

  /**
   * Check if a new session can be created.
   * @deprecated Use tryReserveSessionSlot for atomic operation
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
   * @deprecated Use tryReserveSessionSlot for atomic operation
   */
  registerSession(sessionId: string): void {
    this.sessionCount++;
    this.recordHeartbeat(sessionId);
  }

  /**
   * Unregister a session. Call AFTER session is deleted.
   */
  unregisterSession(sessionId: string): void {
    this.sessionCount--;
    if (this.sessionCount < 0) {
      console.error("[ResourceGovernor] WARNING: sessionCount went negative, resetting to 0");
      this.sessionCount = 0;
    }
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
   */
  unregisterConnection(): void {
    this.connectionCount--;
    if (this.connectionCount < 0) {
      console.error("[ResourceGovernor] WARNING: connectionCount went negative, resetting to 0");
      this.connectionCount = 0;
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
   */
  canExecuteCommand(sessionId: string): GovernorResult {
    const now = Date.now();
    const windowStart = now - RATE_WINDOW_MS;

    // Auto-cleanup if global timestamps exceed threshold
    if (this.globalCommandTimestamps.length > TIMESTAMP_CLEANUP_THRESHOLD) {
      this.globalCommandTimestamps = this.globalCommandTimestamps.filter((t) => t > windowStart);
    } else {
      // Normal filter
      this.globalCommandTimestamps = this.globalCommandTimestamps.filter((t) => t > windowStart);
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
    let timestamps = this.commandTimestamps.get(sessionId);
    if (!timestamps) {
      timestamps = [];
      this.commandTimestamps.set(sessionId, timestamps);
    } else {
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

    // Record this command
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
    const windowStart = now - RATE_WINDOW_MS;
    
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
   * Record a heartbeat for a session.
   */
  recordHeartbeat(sessionId: string): void {
    this.lastHeartbeat.set(sessionId, Date.now());
  }

  /**
   * Get list of zombie session IDs.
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
    const globalCount = this.globalCommandTimestamps.filter((t) => t > windowStart).length;
    
    return {
      sessionCount: this.sessionCount,
      connectionCount: this.connectionCount,
      totalCommandsExecuted: this.totalCommandsExecuted,
      commandsRejected: { ...this.commandsRejected },
      zombieSessionsDetected: this.zombieSessionsDetected,
      zombieSessionsCleaned: this.zombieSessionsCleaned,
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
      issues.push(`Connection count at ${this.connectionCount}/${this.config.maxConnections} (90%+)`);
    }
    
    const zombies = this.getZombieSessions();
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
    };
    this.zombieSessionsDetected = 0;
    this.zombieSessionsCleaned = 0;
  }

  // ==========================================================================
  // CLEANUP
  // ==========================================================================

  /**
   * Clean up stale rate limit data.
   */
  cleanupStaleTimestamps(): void {
    const now = Date.now();
    const windowStart = now - RATE_WINDOW_MS;

    this.globalCommandTimestamps = this.globalCommandTimestamps.filter((t) => t > windowStart);

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
  }
}
