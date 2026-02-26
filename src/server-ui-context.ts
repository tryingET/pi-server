/**
 * Server UI Context - implements ExtensionUIContext for remote clients.
 *
 * Extension UI requests (select, confirm, input, etc.) are:
 * 1. Broadcast to all subscribed clients via extension_ui_request event
 * 2. Tracked as pending requests in ExtensionUIManager
 * 3. Resolved when a client sends extension_ui_response command
 *
 * This enables skills, prompt templates, and custom tools that need user input
 * to work over the WebSocket/stdio transport.
 */

import type { ExtensionUIContext, TerminalInputHandler } from "@mariozechner/pi-coding-agent";
import type { ExtensionUIManager } from "./extension-ui.js";
import {
  isSelectResponse,
  isConfirmResponse,
  isInputResponse,
  isEditorResponse,
} from "./extension-ui.js";

/**
 * Create an ExtensionUIContext that routes UI requests to remote clients.
 *
 * @param sessionId The session ID for request routing
 * @param extensionUI The manager that tracks pending requests
 * @param broadcast Function to broadcast events to subscribers
 */
export function createServerUIContext(
  sessionId: string,
  extensionUI: ExtensionUIManager,
  broadcast: (sessionId: string, event: any) => void
): ExtensionUIContext {
  return {
    async select(
      title: string,
      options: string[],
      opts?: { signal?: AbortSignal; timeout?: number }
    ): Promise<string | undefined> {
      const { requestId, promise } = extensionUI.createPendingRequest(sessionId, "select", {
        title,
        options,
        timeout: opts?.timeout,
      });

      extensionUI.broadcastUIRequest(sessionId, requestId, "select", {
        title,
        options,
        timeout: opts?.timeout,
      });

      try {
        const response = await raceWithAbortAndSignal(promise, opts?.signal, () =>
          extensionUI.cancelRequest(requestId)
        );
        if (response.method === "cancelled") return undefined;
        if (isSelectResponse(response)) return response.value;
        return undefined;
      } catch {
        // Timeout or abort - return undefined (no selection)
        return undefined;
      }
    },

    async confirm(
      title: string,
      message: string,
      opts?: { signal?: AbortSignal; timeout?: number }
    ): Promise<boolean> {
      const { requestId, promise } = extensionUI.createPendingRequest(sessionId, "confirm", {
        title,
        message,
        timeout: opts?.timeout,
      });

      extensionUI.broadcastUIRequest(sessionId, requestId, "confirm", {
        title,
        message,
        timeout: opts?.timeout,
      });

      try {
        const response = await raceWithAbortAndSignal(promise, opts?.signal, () =>
          extensionUI.cancelRequest(requestId)
        );
        if (response.method === "cancelled") return false;
        if (isConfirmResponse(response)) return response.confirmed;
        return false;
      } catch {
        // Timeout or abort - return false (not confirmed)
        return false;
      }
    },

    async input(
      title: string,
      placeholder?: string,
      opts?: { signal?: AbortSignal; timeout?: number }
    ): Promise<string | undefined> {
      const { requestId, promise } = extensionUI.createPendingRequest(sessionId, "input", {
        title,
        placeholder,
        timeout: opts?.timeout,
      });

      extensionUI.broadcastUIRequest(sessionId, requestId, "input", {
        title,
        placeholder,
        timeout: opts?.timeout,
      });

      try {
        const response = await raceWithAbortAndSignal(promise, opts?.signal, () =>
          extensionUI.cancelRequest(requestId)
        );
        if (response.method === "cancelled") return undefined;
        if (isInputResponse(response)) return response.value;
        return undefined;
      } catch {
        // Timeout or abort - return undefined
        return undefined;
      }
    },

    async editor(title: string, prefill?: string): Promise<string | undefined> {
      const { requestId, promise } = extensionUI.createPendingRequest(sessionId, "editor", {
        title,
        prefill,
      });

      extensionUI.broadcastUIRequest(sessionId, requestId, "editor", {
        title,
        prefill,
      });

      try {
        const response = await raceWithAbortAndSignal(
          promise,
          undefined, // editor doesn't typically use abort signal
          () => extensionUI.cancelRequest(requestId)
        );
        if (response.method === "cancelled") return undefined;
        if (isEditorResponse(response)) return response.value;
        return undefined;
      } catch {
        // Timeout - return undefined
        return undefined;
      }
    },

    notify(message: string, type?: "info" | "warning" | "error"): void {
      // Broadcast notification to all subscribers
      broadcast(sessionId, {
        type: "extension_ui_request",
        requestId: `notify-${Date.now()}`, // Ephemeral, no response expected
        method: "notify",
        message,
        notifyType: type ?? "info",
      });
    },

    onTerminalInput(_handler: TerminalInputHandler): () => void {
      // Terminal input not available in server mode
      // Return a no-op unsubscribe function
      return () => {};
    },

    setStatus(key: string, text: string | undefined): void {
      // Broadcast status update to subscribers
      broadcast(sessionId, {
        type: "extension_ui_request",
        requestId: `status-${key}-${Date.now()}`,
        method: "setStatus",
        key,
        text,
      });
    },

    setWorkingMessage(message?: string): void {
      // Broadcast working message update
      broadcast(sessionId, {
        type: "extension_ui_request",
        requestId: `working-${Date.now()}`,
        method: "setWorkingMessage",
        message,
      });
    },

    setWidget(
      key: string,
      content: any,
      options?: { placement?: "aboveEditor" | "belowEditor" }
    ): void {
      // Only support string[] content (not component factories)
      // Component factories can't be serialized for remote clients
      if (Array.isArray(content) || content === undefined) {
        broadcast(sessionId, {
          type: "extension_ui_request",
          requestId: `widget-${key}-${Date.now()}`,
          method: "setWidget",
          key,
          content,
          placement: options?.placement,
        });
      }
      // If content is a function (component factory), ignore it silently
      // Remote clients can't render server-side components
    },

    setFooter(_factory: any): void {
      // Custom footer not supported in server mode
      // This would require Component serialization
    },

    setHeader(_factory: any): void {
      // Custom header not supported in server mode
    },

    setTitle(title: string): void {
      // Broadcast title update
      broadcast(sessionId, {
        type: "extension_ui_request",
        requestId: `title-${Date.now()}`,
        method: "setTitle",
        title,
      });
    },

    async custom<T>(_factory: any, _options?: any): Promise<T> {
      // Custom components not supported in server mode
      // Would require serializing component factories
      throw new Error("Custom components are not supported in server mode");
    },

    pasteToEditor(_text: string): void {
      // Editor paste not available in server mode
    },

    setEditorText(_text: string): void {
      // Editor text setting not available in server mode
    },

    getEditorText(): string {
      // Editor not available in server mode
      return "";
    },

    setEditorComponent(_factory: any): void {
      // Custom editor not supported in server mode
    },

    // Theme methods - return stubs since themes are TUI-specific
    get theme(): any {
      return {
        // Minimal theme stub for extensions that check theme properties
        colors: {},
        styles: {},
      };
    },

    getAllThemes(): { name: string; path: string | undefined }[] {
      // Themes not available in server mode
      return [];
    },

    getTheme(_name: string): any {
      return undefined;
    },

    setTheme(_theme: string | any): { success: boolean; error?: string } {
      return { success: false, error: "Themes not supported in server mode" };
    },

    getToolsExpanded(): boolean {
      return false;
    },

    setToolsExpanded(_expanded: boolean): void {
      // Tool expansion state not tracked in server mode
    },
  };
}

/**
 * Race a promise against abort signal and optional timeout.
 * Calls onCancel if aborted or timed out.
 */
async function raceWithAbortAndSignal<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
  onCancel: () => void
): Promise<T> {
  if (!signal) {
    return promise;
  }

  return new Promise<T>((resolve, reject) => {
    const abortHandler = () => {
      onCancel();
      reject(new Error("Aborted"));
    };

    signal.addEventListener("abort", abortHandler);

    promise
      .then((result) => {
        signal.removeEventListener("abort", abortHandler);
        resolve(result);
      })
      .catch((error) => {
        signal.removeEventListener("abort", abortHandler);
        reject(error);
      });
  });
}
