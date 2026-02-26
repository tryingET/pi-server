/**
 * Session Version Store - manages monotonic version counters per session.
 *
 * Responsibilities:
 * - Track session version numbers (for optimistic concurrency)
 * - Apply version increments to responses
 *
 * Note: Mutation classification is delegated to command-classification.ts
 * to maintain single source of truth.
 */

import type { RpcCommand, RpcResponse } from "./types.js";
import { getSessionId } from "./types.js";
import { isMutationCommand } from "./command-classification.js";

/**
 * Statistics about the session version store.
 */
export interface SessionVersionStoreStats {
  /** Number of sessions being tracked */
  sessionCount: number;
}

/**
 * Session Version Store - manages monotonic version counters.
 *
 * Extracted from PiSessionManager to isolate:
 * - Version initialization (create session)
 * - Version deletion (delete session)
 * - Version increment logic (mutation classification)
 */
export class SessionVersionStore {
  /** Monotonic per-session version counter. */
  private sessionVersions = new Map<string, number>();

  // ==========================================================================
  // VERSION ACCESS
  // ==========================================================================

  /**
   * Get the current version for a session.
   * Returns undefined if session has no version (doesn't exist).
   */
  getVersion(sessionId: string): number | undefined {
    return this.sessionVersions.get(sessionId);
  }

  /**
   * Check if a session has a version record.
   */
  hasVersion(sessionId: string): boolean {
    return this.sessionVersions.has(sessionId);
  }

  /**
   * Get statistics about the store state.
   */
  getStats(): SessionVersionStoreStats {
    return { sessionCount: this.sessionVersions.size };
  }

  // ==========================================================================
  // VERSION MUTATION
  // ==========================================================================

  /**
   * Initialize version for a new session (starts at 0).
   */
  initialize(sessionId: string): void {
    this.sessionVersions.set(sessionId, 0);
  }

  /**
   * Increment version for a session.
   * Returns the new version number.
   */
  increment(sessionId: string): number {
    const current = this.sessionVersions.get(sessionId) ?? 0;
    const next = current + 1;
    this.sessionVersions.set(sessionId, next);
    return next;
  }

  /**
   * Set version for a session explicitly.
   */
  set(sessionId: string, version: number): void {
    this.sessionVersions.set(sessionId, version);
  }

  /**
   * Remove version record for a session.
   */
  delete(sessionId: string): void {
    this.sessionVersions.delete(sessionId);
  }

  /**
   * Clear all version records.
   */
  clear(): void {
    this.sessionVersions.clear();
  }

  // ==========================================================================
  // COMMAND CLASSIFICATION
  // ==========================================================================

  /**
   * Check if a command type mutates session state.
   * Delegates to command-classification.ts for single source of truth.
   * Mutating commands advance the session version.
   */
  isMutation(commandType: string): boolean {
    return isMutationCommand(commandType);
  }

  // ==========================================================================
  // RESPONSE VERSIONING
  // ==========================================================================

  /**
   * Apply session version to a response.
   *
   * For successful responses:
   * - create_session: initialize new session at version 0
   * - delete_session: remove version record
   * - other session commands: increment if mutating
   *
   * Failed responses are returned unchanged.
   */
  applyVersion(command: RpcCommand, response: RpcResponse): RpcResponse {
    if (!response.success) return response;

    // Handle create_session specially
    if (
      command.type === "create_session" &&
      response.command === "create_session" &&
      response.success
    ) {
      const createdSessionId = response.data.sessionId;
      this.sessionVersions.set(createdSessionId, 0);
      return { ...response, sessionVersion: 0 };
    }

    // Handle delete_session specially
    if (
      command.type === "delete_session" &&
      response.command === "delete_session" &&
      response.success
    ) {
      this.sessionVersions.delete(command.sessionId);
      return response;
    }

    // Regular session commands
    const sessionId = getSessionId(command);
    if (!sessionId) return response;

    const current = this.sessionVersions.get(sessionId) ?? 0;
    const next = this.isMutation(command.type) ? current + 1 : current;
    this.sessionVersions.set(sessionId, next);

    return { ...response, sessionVersion: next };
  }
}
