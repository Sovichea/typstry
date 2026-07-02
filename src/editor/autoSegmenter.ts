import { Annotation, type Extension, type Text } from "@codemirror/state";
import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { invoke } from "@tauri-apps/api/core";
import type { AnalyzeResponse } from "./spellcheck";

const autoSegmenterAnnotation = Annotation.define<boolean>();

export interface ScopeEvent {
  offset: number;
  type: 'bracket' | 'directive';
  value: string;
}

export function parseScopeEvents(docText: string): ScopeEvent[] {
  const regex = /(\[|\]|\{|\}|\(|\))|(#set\s+(text|par)\s*\([^)]*\bhyphenate\s*:\s*(true|false)\b[^)]*\))|(\/\/\s*@(disable|enable)-zws)/g;
  const matches = [...docText.matchAll(regex)];
  
  return matches.map(match => {
    const offset = match.index!;
    if (match[1]) {
      return { offset, type: 'bracket', value: match[1] };
    } else if (match[2]) {
      const val = match[4]; // true or false
      return { offset, type: 'directive', value: `hyphenate:${val}` };
    } else {
      const val = match[6]; // disable or enable
      return { offset, type: 'directive', value: `zws:${val}` };
    }
  });
}

export interface ScopeState {
  hyphenate: boolean;
  disabled: boolean;
}

const matchingBrackets: Record<string, string> = {
  '[': ']',
  '{': '}',
  '(': ')'
};

export function resolveScopeState(events: ScopeEvent[], offset: number): ScopeState {
  const stack: string[] = [];
  let hyphenate: boolean | null = null;
  let disabled: boolean | null = null;
  
  let startIdx = events.length - 1;
  while (startIdx >= 0 && events[startIdx].offset > offset) {
    startIdx--;
  }
  
  for (let i = startIdx; i >= 0; i--) {
    const event = events[i];
    
    if (event.type === 'bracket') {
      const char = event.value;
      if (char === ']' || char === '}' || char === ')') {
        stack.push(char);
      } else if (char === '[' || char === '{' || char === '(') {
        const expected = matchingBrackets[char];
        const idx = stack.lastIndexOf(expected);
        if (idx !== -1) {
          stack.splice(idx);
        }
      }
      continue;
    }
    
    if (stack.length > 0) {
      continue;
    }
    
    if (event.type === 'directive') {
      if (event.value.startsWith('hyphenate:')) {
        if (hyphenate === null) {
          hyphenate = event.value === 'hyphenate:true';
        }
      } else if (event.value.startsWith('zws:')) {
        if (disabled === null) {
          disabled = event.value === 'zws:disable';
        }
      }
    }
    
    if (hyphenate !== null && disabled !== null) {
      break;
    }
  }
  
  return {
    hyphenate: hyphenate ?? false,
    disabled: disabled ?? false
  };
}

// Helper to expand range to include surrounding Khmer characters
function expandKhmerRange(doc: Text, from: number, to: number): { from: number; to: number } {
  const isKhmer = (char: string) => /[\u1780-\u17ff]/.test(char);
  let newFrom = from;
  while (newFrom > 0 && isKhmer(doc.sliceString(newFrom - 1, newFrom))) {
    newFrom--;
  }
  while (newFrom > 0 && !isKhmer(doc.sliceString(newFrom - 1, newFrom)) && doc.sliceString(newFrom - 1, newFrom) !== "\n") {
    newFrom--;
  }
  while (newFrom > 0 && isKhmer(doc.sliceString(newFrom - 1, newFrom))) {
    newFrom--;
  }
  
  let newTo = to;
  const docLength = doc.length;
  while (newTo < docLength && isKhmer(doc.sliceString(newTo, newTo + 1))) {
    newTo++;
  }
  while (newTo < docLength && !isKhmer(doc.sliceString(newTo, newTo + 1)) && doc.sliceString(newTo, newTo + 1) !== "\n") {
    newTo++;
  }
  while (newTo < docLength && isKhmer(doc.sliceString(newTo, newTo + 1))) {
    newTo++;
  }
  return { from: newFrom, to: newTo };
}

// Coalesce overlapping ranges
function coalesceRanges(ranges: { from: number; to: number }[]): { from: number; to: number }[] {
  if (ranges.length === 0) return [];
  ranges.sort((a, b) => a.from - b.from);
  const result = [ranges[0]];
  for (let i = 1; i < ranges.length; i++) {
    const last = result[result.length - 1];
    const curr = ranges[i];
    if (curr.from <= last.to) {
      last.to = Math.max(last.to, curr.to);
    } else {
      result.push(curr);
    }
  }
  return result;
}

export class AutoSegmenterClass {
  public pendingRanges: { from: number; to: number }[] = [];
  public timer: any = null;
  public activeRequest: { doc: Text; ranges: { from: number; to: number }[] } | null = null;
  public view: EditorView;

  constructor(view: EditorView) {
    this.view = view;
  }

  update(update: ViewUpdate) {
    // If changes were made by ourselves, do not trigger a new segmentation run
    if (update.transactions.some(tr => tr.annotation(autoSegmenterAnnotation))) {
      return;
    }

    if (update.docChanged) {
      let changed = false;
      // Map existing pending ranges from previous states to the new state first
      this.pendingRanges = this.pendingRanges.map(r => ({
        from: update.changes.mapPos(r.from, -1),
        to: update.changes.mapPos(r.to, 1)
      }));

      // Check if hyphenation rules or disable-zws directive changed in the document
      const prevText = update.startState.doc.toString();
      const nextText = update.state.doc.toString();
      
      const prevEvents = parseScopeEvents(prevText);
      const nextEvents = parseScopeEvents(nextText);
      const valuesChanged = prevEvents.length !== nextEvents.length ||
        prevEvents.some((ev, i) => ev.value !== nextEvents[i].value);

      if (valuesChanged) {
        this.pendingRanges.push({ from: 0, to: update.state.doc.length });
        changed = true;
      }

      update.changes.iterChanges((_fromA, _toA, fromB, toB) => {
        // We only care about edits inside or touching Khmer ranges
        const text = update.state.doc.sliceString(fromB, toB);
        const hasKhmer = /[\u1780-\u17ff]/.test(text) || 
                         /[\u1780-\u17ff]/.test(update.startState.doc.sliceString(_fromA, _toA));
        if (hasKhmer) {
          this.pendingRanges.push({ from: fromB, to: toB });
          changed = true;
        }
      });

      if (changed) {
        this.pendingRanges = this.pendingRanges.map(r => expandKhmerRange(update.state.doc, r.from, r.to));
        this.pendingRanges = coalesceRanges(this.pendingRanges);
        this.schedule();
      }
    }
  }

  schedule() {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.runSegmentation();
    }, 300); // 300ms debounce
  }

  async runSegmentation() {
    if (this.activeRequest !== null || this.pendingRanges.length === 0) return;

    let rangesToAnalyze = [...this.pendingRanges];
    this.pendingRanges = [];

    // Find and remove all ZWS and SHY inside the pending ranges first to clean them up
    const cleanChanges: { from: number; to: number; insert: string }[] = [];
    for (const range of rangesToAnalyze) {
      const text = this.view.state.doc.sliceString(range.from, range.to);
      let idx = 0;
      while (true) {
        const nextZws = text.indexOf("\u200b", idx);
        const nextShy = text.indexOf("\u00ad", idx);
        if (nextZws === -1 && nextShy === -1) break;

        if (nextZws !== -1 && (nextShy === -1 || nextZws < nextShy)) {
          cleanChanges.push({
            from: range.from + nextZws,
            to: range.from + nextZws + 1,
            insert: ""
          });
          idx = nextZws + 1;
        } else {
          cleanChanges.push({
            from: range.from + nextShy,
            to: range.from + nextShy + 1,
            insert: ""
          });
          idx = nextShy + 1;
        }
      }
    }

    if (cleanChanges.length > 0) {
      // Sort in descending order to prevent shifting during deletion
      cleanChanges.sort((a, b) => b.from - a.from);
      this.view.dispatch({
        changes: cleanChanges,
        annotations: autoSegmenterAnnotation.of(true)
      });

      // Map analyzed ranges to the new clean document positions
      const mapPos = (pos: number) => {
        return pos - cleanChanges.filter(ch => ch.from < pos).length;
      };
      rangesToAnalyze = rangesToAnalyze.map(r => ({
        from: mapPos(r.from),
        to: mapPos(r.to)
      }));
    }

    const doc = this.view.state.doc;
    const docText = doc.toString();
    const events = parseScopeEvents(docText);

    // Filter out ranges that are entirely disabled from being sent to the backend
    const activeRanges = rangesToAnalyze.filter(range => {
      const startScope = resolveScopeState(events, range.from);
      if (startScope.disabled) {
        const hasEnableInside = events.some(ev => ev.offset >= range.from && ev.offset < range.to && ev.value === "zws:enable");
        if (!hasEnableInside) {
          return false;
        }
      }
      return true;
    });

    if (activeRanges.length === 0) {
      return;
    }

    this.activeRequest = { doc, ranges: activeRanges };

    const chunks = activeRanges.map(range => ({
      text: doc.sliceString(range.from, range.to),
      startUtf16: range.from
    }));

    try {
      const response = await invoke<AnalyzeResponse>("analyze_language_ranges", {
        request: { chunks }
      });

      if (this.view.state.doc === doc) {
        this.applySegmentation(response, activeRanges);
      }
    } catch (error) {
      console.warn("[AutoSegmenter] Failed to segment language ranges:", error);
    } finally {
      this.activeRequest = null;
      if (this.pendingRanges.length > 0) {
        this.schedule();
      }
    }
  }

  applySegmentation(response: AnalyzeResponse, analyzedRanges: { from: number; to: number }[]) {
    const state = this.view.state;
    const cursor = state.selection.main.head;
    const changes: { from: number; to: number; insert: string }[] = [];

    const docText = state.doc.toString();
    const events = parseScopeEvents(docText);

    // 1. Apply replacements/updates inside the tokens themselves
    for (const token of response.tokens) {
      // ONLY touch Khmer tokens!
      if (!/[\u1780-\u17ff]/.test(token.normalizedText)) {
        continue;
      }

      const scope = resolveScopeState(events, token.sourceFromUtf16);
      if (scope.disabled) {
        continue;
      }

      // Skip changes right under the active cursor to avoid messing up typing
      if (cursor >= token.sourceFromUtf16 && cursor <= token.sourceToUtf16) {
        continue;
      }

      const currentText = state.doc.sliceString(token.sourceFromUtf16, token.sourceToUtf16);
      let targetText = token.normalizedText;
      if (scope.hyphenate && token.hyphenated) {
        targetText = token.hyphenated;
      }

      if (currentText !== targetText) {
        changes.push({
          from: token.sourceFromUtf16,
          to: token.sourceToUtf16,
          insert: targetText
        });
      }
    }

    // 2. Insert ZWS/SHY between adjacent tokens
    for (let i = 0; i < response.tokens.length - 1; i++) {
      const tokenA = response.tokens[i];
      const tokenB = response.tokens[i + 1];

      // ONLY insert between adjacent Khmer tokens!
      if (!/[\u1780-\u17ff]/.test(tokenA.normalizedText) || !/[\u1780-\u17ff]/.test(tokenB.normalizedText)) {
        continue;
      }

      // Ensure both tokens belong to analyzed ranges
      const inAnalyzed = analyzedRanges.some(r => tokenA.sourceToUtf16 >= r.from && tokenB.sourceFromUtf16 <= r.to);
      if (!inAnalyzed) continue;

      const endA = tokenA.sourceToUtf16;
      const startB = tokenB.sourceFromUtf16;

      const scope = resolveScopeState(events, endA);
      if (scope.disabled) {
        continue;
      }

      // Skip gap changes touching the cursor
      if (cursor === endA || cursor === startB) {
        continue;
      }

      if (startB === endA) {
        changes.push({
          from: endA,
          to: endA,
          insert: "\u200b"
        });
      } else if (startB === endA + 1) {
        const char = state.doc.sliceString(endA, startB);
        if (char === "\u00ad") {
          // Replace word-boundary SHY with ZWS
          changes.push({
            from: endA,
            to: startB,
            insert: "\u200b"
          });
        }
      }
    }

    if (changes.length > 0) {
      // Sort changes in descending order to prevent offset shift issues during dispatch
      changes.sort((a, b) => b.from - a.from);
      
      this.view.dispatch({
        changes,
        annotations: autoSegmenterAnnotation.of(true),
        userEvent: "input.segmentation"
      });
    }
  }
}

export const autoSegmenterPlugin = ViewPlugin.fromClass(AutoSegmenterClass);

export function createAutoSegmenter(): Extension {
  return autoSegmenterPlugin;
}
