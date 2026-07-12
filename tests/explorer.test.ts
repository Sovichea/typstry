import { describe, expect, test } from "bun:test";
import { isHiddenWorkspaceEntry, sortFileNodes, type FileNode } from "../src/components/explorer";

describe("workspace explorer", () => {
  test("sorts folders before files without mutating the source list", () => {
    const nodes: FileNode[] = [
      { name: "z.typ", path: "/z.typ", isDirectory: false },
      { name: "assets", path: "/assets", isDirectory: true },
      { name: "a.typ", path: "/a.typ", isDirectory: false }
    ];

    expect(sortFileNodes(nodes).map(node => node.name)).toEqual(["assets", "a.typ", "z.typ"]);
    expect(nodes.map(node => node.name)).toEqual(["z.typ", "assets", "a.typ"]);
  });

  test("hides Typstella's managed workspace cache directory", () => {
    expect(isHiddenWorkspaceEntry(".typstella")).toBe(true);
    expect(isHiddenWorkspaceEntry(".typst")).toBe(false);
    expect(isHiddenWorkspaceEntry("typstella")).toBe(false);
  });
});
