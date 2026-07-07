export type EditingDirection = "backward" | "forward";

export type EditingRange = {
  from: number;
  to: number;
};

export interface ScriptEditingPolicy {
  readonly id: string;
  readonly scripts: readonly string[];
  readonly editorExtensions?: readonly Extension[];

  ownsCodePoint(codePoint: number): boolean;
  shouldMergeBoundary(text: string, boundary: number): boolean;
  backwardDeletionRange(text: string, offset: number): EditingRange | null;
  forwardDeletionRange(text: string, offset: number, nextBoundary: number): EditingRange | null;
  temporaryBoundary?(state: EditorState): number | null;
}
import type { EditorState, Extension } from "@codemirror/state";
