import { describe, expect, test } from "bun:test";
import { workspaceChangeKind } from "../src/workspace/workspaceWatcher";

describe("workspace watcher", () => {
  test("classifies structural and content changes", () => {
    expect(workspaceChangeKind({ create: { kind: "file" } })).toBe("create");
    expect(workspaceChangeKind({ remove: { kind: "folder" } })).toBe("remove");
    expect(workspaceChangeKind({ modify: { kind: "data", mode: "content" } })).toBe("modify");
    expect(workspaceChangeKind({ modify: { kind: "rename", mode: "both" } })).toBe("rename");
  });

  test("ignores access and unspecified events", () => {
    expect(workspaceChangeKind({ access: { kind: "open", mode: "read" } })).toBeNull();
    expect(workspaceChangeKind("other")).toBeNull();
    expect(workspaceChangeKind("any")).toBeNull();
  });
});
