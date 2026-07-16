import { StateEffect, StateField, type Extension } from "@codemirror/state";
import type { ResolvedLanguageScopes } from "./types";

export const setResolvedLanguageScopes = StateEffect.define<ResolvedLanguageScopes | null>();

export const resolvedLanguageScopesField = StateField.define<ResolvedLanguageScopes | null>({
  create: () => null,
  update(value, transaction) {
    if (transaction.docChanged) value = null;
    for (const effect of transaction.effects) {
      if (effect.is(setResolvedLanguageScopes)) value = effect.value;
    }
    return value;
  },
});

export function languageScopeStateExtension(): Extension {
  return resolvedLanguageScopesField;
}

