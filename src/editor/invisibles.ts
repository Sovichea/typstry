import { Facet } from "@codemirror/state";

export const showInvisibleCharacters = Facet.define<boolean, boolean>({
  combine: values => values.some(Boolean)
});
