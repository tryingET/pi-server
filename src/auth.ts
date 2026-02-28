/**
 * Authentication abstraction for pi-server.
 *
 * This module provides a pluggable authentication interface that allows
 * users to implement their own auth mechanisms without modifying the server.
 *
 * Built-in implementations:
 * - AllowAllAuthProvider: No authentication (default, for development)
 * - TokenAuthProvider: Simple token-based authentication
 *
 * Custom implementations can:
 * - Integrate with OAuth providers
 * - Use mTLS client certificates
 * - Implement IP-based allowlists
 * - Add rate limiting per user
 */

import type { IncomingMessage } from "http";

// ============================================================================
// TYPES
// ============================================================================

/**
 * Authentication result returned by AuthProvider.
 */
export type AuthResult = { allowed: true; identity?: string } | { allowed: false; reason: string };

/**
 * Context information available to auth providers.
 */
export interface AuthContext {
  /** Raw HTTP request (for headers, cookies, TLS info) */
  request?: IncomingMessage;
  /** WebSocket connection info */
  websocket?: {
    /** Remote address (from socket or X-Forwarded-For) */
    remoteAddress?: string;
    /** Whether connection is over TLS */
    secure: boolean;
  };
  /** Server startup time (for distinguishing restarts) */
  serverStartTime: number;
  /** Current connection count */
  connectionCount: number;
}

/**
 * Authentication provider interface.
 *
 * Implementations determine whether a connection should be accepted.
 * This is called once per connection before any commands are processed.
 *
 * For per-command authorization, implement additional checks in your
 * command handlers or use the identity field to track permissions.
 *
 * @example
 * ```typescript
 * // Custom auth provider
 * const myAuth: AuthProvider = {
 *   authenticate: async (ctx) => {
 *     const token = ctx.request?.headers['authorization'];
 *     if (!token) return { allowed: false, reason: 'Missing token' };
 *     const user = await verifyToken(token);
 *     if (!user) return { allowed: false, reason: 'Invalid token' };
 *     return { allowed: true, identity: user.id };
 *   }
 * };
 * ```
 */
export interface AuthProvider {
  /**
   * Authenticate a new connection.
   *
   * Called once when a WebSocket connection is established or when
   * stdio receives its first command.
   *
   * @param ctx Context information for the connection
   * @returns Auth result with optional identity on success
   */
  authenticate(ctx: AuthContext): Promise<AuthResult> | AuthResult;

  /**
   * Optional: Clean up resources when server shuts down.
   */
  dispose?(): Promise<void> | void;
}

// ============================================================================
// BUILT-IN IMPLEMENTATIONS
// ============================================================================

/**
 * Auth provider that allows all connections.
 * This is the default for development and single-user deployments.
 */
export class AllowAllAuthProvider implements AuthProvider {
  authenticate(_ctx: AuthContext): AuthResult {
    return { allowed: true };
  }
}

/**
 * Configuration for TokenAuthProvider.
 */
export interface TokenAuthConfig {
  /** Valid tokens (token -> identity mapping) */
  tokens: Map<string, string>;
  /** Header to read token from (default: 'authorization') */
  headerName?: string;
  /** Token prefix (default: 'Bearer ') */
  tokenPrefix?: string;
  /** Allow connections without token (default: false) */
  allowMissingToken?: boolean;
}

/**
 * Simple token-based authentication.
 *
 * Validates tokens from HTTP headers. Useful for:
 * - API access with pre-shared tokens
 * - Development with hardcoded tokens
 * - Integration with external token generators
 *
 * @example
 * ```typescript
 * const auth = new TokenAuthProvider({
 *   tokens: new Map([
 *     ['secret-token-1', 'user-alice'],
 *     ['secret-token-2', 'user-bob'],
 *   ]),
 * });
 * ```
 */
export class TokenAuthProvider implements AuthProvider {
  private readonly tokens: Map<string, string>;
  private readonly headerName: string;
  private readonly tokenPrefix: string;
  private readonly allowMissingToken: boolean;

  constructor(config: TokenAuthConfig) {
    this.tokens = config.tokens;
    this.headerName = config.headerName ?? "authorization";
    this.tokenPrefix = config.tokenPrefix ?? "Bearer ";
    this.allowMissingToken = config.allowMissingToken ?? false;
  }

  authenticate(ctx: AuthContext): AuthResult {
    // Get token from header
    const headerValue = ctx.request?.headers[this.headerName.toLowerCase()];
    if (!headerValue) {
      if (this.allowMissingToken) {
        return { allowed: true, identity: "anonymous" };
      }
      return { allowed: false, reason: `Missing ${this.headerName} header` };
    }

    // Extract token (handle array headers)
    const headerStr = Array.isArray(headerValue) ? headerValue[0] : headerValue;
    const token = headerStr.startsWith(this.tokenPrefix)
      ? headerStr.slice(this.tokenPrefix.length)
      : headerStr;

    // Look up identity
    const identity = this.tokens.get(token);
    if (!identity) {
      return { allowed: false, reason: "Invalid token" };
    }

    return { allowed: true, identity };
  }
}

/**
 * Configuration for IPAllowlistAuthProvider.
 */
export interface IPAllowlistConfig {
  /** Allowed IP addresses or CIDR ranges */
  allowedIPs: string[];
  /** Trust X-Forwarded-For header (default: false) */
  trustForwardedFor?: boolean;
}

/**
 * IP-based allowlist authentication.
 *
 * Accepts connections only from allowed IP addresses.
 * Useful for restricting access to known clients.
 *
 * @example
 * ```typescript
 * const auth = new IPAllowlistAuthProvider({
 *   allowedIPs: ['127.0.0.1', '::1', '192.168.1.0/24'],
 * });
 * ```
 */
export class IPAllowlistAuthProvider implements AuthProvider {
  private readonly allowedIPs: Set<string>;
  private readonly allowedPrefixes: Array<{ prefix: string; bits: number }>;
  private readonly trustForwardedFor: boolean;

  constructor(config: IPAllowlistConfig) {
    this.allowedIPs = new Set<string>();
    this.allowedPrefixes = [];
    this.trustForwardedFor = config.trustForwardedFor ?? false;

    for (const ip of config.allowedIPs) {
      if (ip.includes("/")) {
        // CIDR notation
        const [prefix, bitsStr] = ip.split("/");
        this.allowedPrefixes.push({ prefix, bits: parseInt(bitsStr, 10) });
      } else {
        this.allowedIPs.add(ip);
      }
    }
  }

  authenticate(ctx: AuthContext): AuthResult {
    let remoteIP = ctx.websocket?.remoteAddress;

    // Check X-Forwarded-For if configured
    if (this.trustForwardedFor && ctx.request) {
      const forwarded = ctx.request.headers["x-forwarded-for"];
      if (forwarded) {
        // Take the first IP (original client)
        const ips = Array.isArray(forwarded) ? forwarded[0] : forwarded;
        remoteIP = ips.split(",")[0].trim();
      }
    }

    if (!remoteIP) {
      return { allowed: false, reason: "Cannot determine remote IP" };
    }

    // Check exact match
    if (this.allowedIPs.has(remoteIP)) {
      return { allowed: true, identity: `ip:${remoteIP}` };
    }

    // Check CIDR prefixes (simplified - only handles IPv4 /24 and smaller)
    for (const { prefix, bits } of this.allowedPrefixes) {
      if (this.matchesCIDR(remoteIP, prefix, bits)) {
        return { allowed: true, identity: `ip:${remoteIP}` };
      }
    }

    return { allowed: false, reason: `IP ${remoteIP} not in allowlist` };
  }

  private matchesCIDR(ip: string, prefix: string, bits: number): boolean {
    // Simplified IPv4 matching
    const ipParts = ip.split(".").map((n) => parseInt(n, 10));
    const prefixParts = prefix.split(".").map((n) => parseInt(n, 10));

    if (ipParts.length !== 4 || prefixParts.length !== 4) {
      return false;
    }

    // Compare byte by byte
    let remainingBits = bits;
    for (let i = 0; i < 4; i++) {
      const mask = remainingBits >= 8 ? 255 : (0xff << (8 - remainingBits)) & 0xff;
      if ((ipParts[i] & mask) !== (prefixParts[i] & mask)) {
        return false;
      }
      remainingBits = Math.max(0, remainingBits - 8);
    }

    return true;
  }
}

/**
 * Compose multiple auth providers (all must pass).
 *
 * @example
 * ```typescript
 * const auth = new CompositeAuthProvider([
 *   new IPAllowlistAuthProvider({ allowedIPs: ['10.0.0.0/8'] }),
 *   new TokenAuthProvider({ tokens: myTokens }),
 * ]);
 * ```
 */
export class CompositeAuthProvider implements AuthProvider {
  constructor(private readonly providers: AuthProvider[]) {}

  async authenticate(ctx: AuthContext): Promise<AuthResult> {
    let identity: string | undefined;

    for (const provider of this.providers) {
      const result = await provider.authenticate(ctx);
      if (!result.allowed) {
        return result;
      }
      // Use the most specific identity
      if (result.identity && !result.identity.startsWith("ip:")) {
        identity = result.identity;
      } else if (!identity) {
        identity = result.identity;
      }
    }

    return { allowed: true, identity };
  }

  async dispose(): Promise<void> {
    await Promise.all(
      this.providers.map((p) => (p.dispose ? Promise.resolve(p.dispose()) : Promise.resolve()))
    );
  }
}
