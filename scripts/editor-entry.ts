// Entry point for `deno task build:editor`.
// It produces ui/vendor/editor.js so the container needs no network access.
import { basicSetup, EditorView } from "codemirror";
import { javascript } from "@codemirror/lang-javascript";
import { oneDark } from "@codemirror/theme-one-dark";
import { keymap } from "@codemirror/view";
import { indentWithTab } from "@codemirror/commands";
import { Compartment, EditorState } from "@codemirror/state";

// deno-lint-ignore no-explicit-any
(globalThis as any).CM = {
  EditorView,
  EditorState,
  basicSetup,
  javascript,
  oneDark,
  keymap,
  indentWithTab,
  Compartment,
};
