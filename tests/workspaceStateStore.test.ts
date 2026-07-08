import { beforeEach, describe, expect, test } from "bun:test";
import { WorkspaceStateStore } from "../src/workspace/workspaceStateStore";

const values = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value)
  },
  configurable: true
});

describe("workspace state store", () => {
  beforeEach(() => values.clear());

  test("round-trips typed workspace state", () => {
    const store = new WorkspaceStateStore();
    const state = {
      activeFilePath: "/work/main.typ",
      openTabs: [],
      inputContainerWidthPct: 60,
      explorerSidebarWidthPx: 300,
      pinnedMainFilePath: null
    };
    store.save("/work", state);
    expect(store.load("/work")).toEqual(state);
  });

  test("rejects malformed persisted state", () => {
    values.set("typstry-workspace-/work", "not json");
    expect(new WorkspaceStateStore().load("/work")).toBeNull();
  });
});
