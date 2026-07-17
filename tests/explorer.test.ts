import { describe, expect, test } from "bun:test";
import { isHiddenWorkspaceEntry, sortFileNodes, workspaceParentDirectories, workspacePathSetContains, type FileNode } from "../src/components/explorer";
import { explorerKeyboardAction } from "../src/components/contextMenuController";

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

  test("maps standard explorer file-operation shortcuts", () => {
    const event = (key: string, modifiers: Partial<KeyboardEvent> = {}) => ({
      key,
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      shiftKey: false,
      ...modifiers
    }) as KeyboardEvent;

    expect(explorerKeyboardAction(event("c", { ctrlKey: true }))).toBe("copy");
    expect(explorerKeyboardAction(event("V", { ctrlKey: true }))).toBe("paste");
    expect(explorerKeyboardAction(event("Delete"))).toBe("delete");
    expect(explorerKeyboardAction(event("F2"))).toBe("rename");
    expect(explorerKeyboardAction(event("c"))).toBeNull();
    expect(explorerKeyboardAction(event("Delete", { shiftKey: true }))).toBeNull();
    expect(explorerKeyboardAction(event("F2", { ctrlKey: true }))).toBeNull();
  });

  test("matches expanded Windows directories across slash styles", () => {
    const expanded = new Set(["C:/Research/chapters", "//server/share/figures", "/home/writer/book"]);
    expect(workspacePathSetContains(expanded, "C:\\Research\\chapters")).toBe(true);
    expect(workspacePathSetContains(expanded, "c:\\research\\CHAPTERS")).toBe(true);
    expect(workspacePathSetContains(expanded, "\\\\server\\share\\figures")).toBe(true);
    expect(workspacePathSetContains(expanded, "/home/writer/book")).toBe(true);
    expect(workspacePathSetContains(expanded, "/HOME/writer/book")).toBe(false);
    expect(workspacePathSetContains(expanded, "C:\\Research\\figures")).toBe(false);
  });

  test("derives reveal parents portably", () => {
    expect(workspaceParentDirectories("C:\\Research", "C:/Research/chapters/one/main.typ"))
      .toEqual(["C:/Research/chapters/one", "C:/Research/chapters"]);
    expect(workspaceParentDirectories("/home/writer/book", "/home/writer/book/chapters/main.typ"))
      .toEqual(["/home/writer/book/chapters"]);
    expect(workspaceParentDirectories("//server/share", "\\\\server\\share\\book\\main.typ"))
      .toEqual(["//server/share/book"]);
    expect(workspaceParentDirectories("/home/writer/book", "/outside/main.typ")).toEqual([]);
  });

  test("hides Typsastra's managed workspace cache directory", () => {
    expect(isHiddenWorkspaceEntry(".typsastra")).toBe(true);
    expect(isHiddenWorkspaceEntry(".typstella")).toBe(true);
    expect(isHiddenWorkspaceEntry(".typst")).toBe(false);
    expect(isHiddenWorkspaceEntry("typsastra")).toBe(false);
  });
});
