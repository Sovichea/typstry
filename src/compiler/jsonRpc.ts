export type JsonRpcId = number | string;

export type JsonRpcError = {
  code?: number;
  message: string;
  data?: unknown;
};

export type JsonRpcMessage = {
  jsonrpc?: string;
  id?: JsonRpcId;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: JsonRpcError;
};

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

export function parseJsonRpcMessage(source: string): JsonRpcMessage | null {
  try {
    const value: unknown = JSON.parse(source);
    if (!isRecord(value)) return null;
    return value as JsonRpcMessage;
  } catch {
    return null;
  }
}
