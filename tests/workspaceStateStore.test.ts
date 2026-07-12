import { beforeEach, describe, expect, test } from "bun:test";
import { WorkspaceStateStore, workspaceRestoreCandidates } from "../src/workspace/workspaceStateStore";

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
      pinnedMainFilePath: null,
      recommendedToolchain: { tinymistVersion: "0.13.10", typstVersion: "0.13.1" },
      selectedToolchain: { tinymistVersion: "0.13.12", typstVersion: "0.13.1" }
    };
    store.save("/work", state);
    expect(store.load("/work")).toEqual(state);
  });

  test("rejects malformed persisted state", () => {
    values.set("typstella-workspace-/work", "not json");
    expect(new WorkspaceStateStore().load("/work")).toBeNull();
  });

  test("restores an active or pinned main file when the saved tab list is empty", () => {
    expect(workspaceRestoreCandidates({
      activeFilePath: "/work/main.typ",
      pinnedMainFilePath: "/work/main.typ",
      openTabs: [],
      inputContainerWidthPct: 50,
      explorerSidebarWidthPx: 250,
      recommendedToolchain: null,
      selectedToolchain: null
    })).toEqual(["/work/main.typ"]);
  });
});
