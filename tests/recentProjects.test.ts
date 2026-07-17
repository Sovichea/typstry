import { describe, expect, test } from "bun:test";
import { recentProjectShortcutIndex } from "../src/workspace/recentProjectsController";

describe("recent project shortcuts", () => {
  const event = (code: string, modifiers: Partial<KeyboardEvent> = {}) => ({
    code,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    ...modifiers
  }) as KeyboardEvent;

  test("maps command digits to the five visible recent-project slots", () => {
    expect(recentProjectShortcutIndex(event("Digit1", { ctrlKey: true }))).toBe(0);
    expect(recentProjectShortcutIndex(event("Digit5", { metaKey: true }))).toBe(4);
    expect(recentProjectShortcutIndex(event("Digit6", { ctrlKey: true }))).toBeNull();
    expect(recentProjectShortcutIndex(event("Digit1", { ctrlKey: true, shiftKey: true }))).toBeNull();
    expect(recentProjectShortcutIndex(event("Digit1"))).toBeNull();
  });
});
