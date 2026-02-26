/**
 * Extension UI - tracks pending UI requests from extensions and routes responses.
 *
 * NOTE: Extension UI requests are NOT AgentSessionEvents. They come through
 * the ExtensionUIContext interface which must be provided when binding extensions.
 *
 * This module provides:
 * - Types for extension UI commands/responses
 * - ExtensionUIManager for tracking pending requests (used when we provide our own UIContext)
 *
 * Phase 3 will wire this up by providing a custom ExtensionUIContext to bindExtensions().
 */

// =============================================================================
// TYPES
// =============================================================================

export interface PendingUIRequest {
  sessionId: string;
  requestId: string;
  method: ExtensionUIMethod;
  resolve: (response: ExtensionUIResponseValue) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
  createdAt: Date;
}

export type ExtensionUIMethod =
  | "select"
  | "confirm"
  | "input"
  | "editor"
  | "interview"
  | "notify"
  | "setStatus"
  | "setWidget"
  | "setTitle";

export type ExtensionUIResponseValue =
  | { method: "select"; value: string }
  | { method: "confirm"; confirmed: boolean }
  | { method: "input"; value: string }
  | { method: "editor"; value: string }
  | { method: "interview"; responses: Record<string, any> }
  | { method: "cancelled" };

// Type guards for response types
export function isSelectResponse(
  r: ExtensionUIResponseValue
): r is { method: "select"; value: string } {
  return r.method === "select";
}

export function isConfirmResponse(
  r: ExtensionUIResponseValue
): r is { method: "confirm"; confirmed: boolean } {
  return r.method === "confirm";
}

export function isInputResponse(
  r: ExtensionUIResponseValue
): r is { method: "input"; value: string } {
  return r.method === "input";
}

export function isEditorResponse(
  r: ExtensionUIResponseValue
): r is { method: "editor"; value: string } {
  return r.method === "editor";
}

// Command from client to respond to UI request
export interface ExtensionUIResponseCommand {
  id?: string;
  sessionId: string;
  type: "extension_ui_response";
  requestId: string;
  response: ExtensionUIResponseValue;
}

// =============================================================================
// EXTENSION UI MANAGER
// =============================================================================

export class ExtensionUIManager {
  private pendingRequests = new Map<string, PendingUIRequest>();
  private defaultTimeoutMs: number;
  // Broadcast function - will be wired up in Phase 3
  private broadcast: (sessionId: string, event: any) => void;

  constructor(
    broadcast: (sessionId: string, event: any) => void,
    defaultTimeoutMs: number = 60000
  ) {
    this.broadcast = broadcast;
    this.defaultTimeoutMs = defaultTimeoutMs;
  }

  /**
   * Handle a UI request from an extension.
   * This is called by our ExtensionUIContext implementation.
   * Returns the requestId and a promise that resolves when client responds.
   */
  createPendingRequest(
    sessionId: string,
    method: ExtensionUIMethod,
    requestData: Record<string, any>
  ): { requestId: string; promise: Promise<ExtensionUIResponseValue> } {
    const requestId = this.generateRequestId(sessionId);
    const timeoutMs =
      typeof requestData.timeout === "number" &&
      Number.isFinite(requestData.timeout) &&
      requestData.timeout > 0
        ? requestData.timeout
        : this.defaultTimeoutMs;

    const promise = new Promise<ExtensionUIResponseValue>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new Error(`Extension UI request ${requestId} timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pendingRequests.set(requestId, {
        sessionId,
        requestId,
        method,
        resolve,
        reject,
        timeout,
        createdAt: new Date(),
      });
    });

    return { requestId, promise };
  }

  /**
   * Broadcast a UI request to clients.
   */
  broadcastUIRequest(
    sessionId: string,
    requestId: string,
    method: ExtensionUIMethod,
    data: Record<string, any>
  ): void {
    this.broadcast(sessionId, {
      type: "extension_ui_request",
      requestId,
      method,
      ...data,
    });
  }

  /**
   * Handle a response from a client to a pending UI request.
   * Returns true if the response was handled, false if no pending request found.
   */
  handleUIResponse(command: ExtensionUIResponseCommand): { success: boolean; error?: string } {
    const pending = this.pendingRequests.get(command.requestId);

    if (!pending) {
      return {
        success: false,
        error: `No pending UI request with id ${command.requestId}`,
      };
    }

    // Verify sessionId matches
    if (pending.sessionId !== command.sessionId) {
      return {
        success: false,
        error: `Session ID mismatch for request ${command.requestId}`,
      };
    }

    // Clear timeout and remove from pending
    clearTimeout(pending.timeout);
    this.pendingRequests.delete(command.requestId);

    // Resolve the promise
    pending.resolve(command.response);

    return { success: true };
  }

  /**
   * Get all pending requests for a session (for debugging/cleanup).
   */
  getPendingRequests(sessionId: string): PendingUIRequest[] {
    const requests: PendingUIRequest[] = [];
    for (const pending of this.pendingRequests.values()) {
      if (pending.sessionId === sessionId) {
        requests.push(pending);
      }
    }
    return requests;
  }

  /**
   * Cancel all pending requests for a session (e.g., when session is deleted).
   */
  cancelSessionRequests(sessionId: string): void {
    for (const [requestId, pending] of this.pendingRequests.entries()) {
      if (pending.sessionId === sessionId) {
        clearTimeout(pending.timeout);
        pending.reject(new Error(`Session ${sessionId} was deleted`));
        this.pendingRequests.delete(requestId);
      }
    }
  }

  /**
   * Cancel a specific pending request (e.g., on abort signal).
   */
  cancelRequest(requestId: string): void {
    const pending = this.pendingRequests.get(requestId);
    if (pending) {
      clearTimeout(pending.timeout);
      pending.reject(new Error(`Request ${requestId} was cancelled`));
      this.pendingRequests.delete(requestId);
    }
  }

  /**
   * Get count of pending requests (for monitoring).
   */
  getPendingCount(): number {
    return this.pendingRequests.size;
  }

  // ===========================================================================
  // PRIVATE
  // ===========================================================================

  private generateRequestId(sessionId: string): string {
    return `${sessionId}:${Date.now()}:${Math.random().toString(36).substring(2, 9)}`;
  }
}
