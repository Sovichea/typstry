import { describe, expect, test } from "bun:test";
import { asRecord, parseJsonRpcMessage } from "../src/compiler/jsonRpc";

describe("JSON-RPC boundary", () => {
  test("parses object messages and rejects malformed payloads", () => {
    expect(parseJsonRpcMessage('{"jsonrpc":"2.0","id":1,"result":true}')).toMatchObject({ id: 1, result: true });
    expect(parseJsonRpcMessage("not json")).toBeNull();
    expect(parseJsonRpcMessage("[]")).toBeNull();
  });

  test("narrows record values", () => {
    expect(asRecord({ method: "initialize" })?.method).toBe("initialize");
    expect(asRecord(null)).toBeUndefined();
  });
});
