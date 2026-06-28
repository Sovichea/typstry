import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { parseJsonRpcMessage, type JsonRpcMessage } from "./jsonRpc";

export class TauriLspTransport {
  public start(): Promise<void> {
    return invoke("start_tinymist_lsp");
  }

  public send(message: JsonRpcMessage): Promise<void> {
    return invoke("send_lsp_message", { message: JSON.stringify(message) });
  }

  public listenMessages(handler: (message: JsonRpcMessage) => void): Promise<UnlistenFn> {
    return listen<string>("lsp-rx", event => {
      const message = parseJsonRpcMessage(event.payload);
      if (message) handler(message);
      else console.error("Failed to parse LSP payload");
    });
  }

  public listenStatus(handler: (status: string) => void): Promise<UnlistenFn> {
    return listen<string>("lsp-status", event => handler(event.payload));
  }
}
