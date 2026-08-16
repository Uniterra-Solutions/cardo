// Cardo: the desktop host extends pi's `ExtensionUIContext` with a structured
// multi-question clarification wizard (Jovaltus plan pipeline). pi-coding-agent
// ships in node_modules and cannot be edited, so the extra method is declared
// via module augmentation here (the host side). The jovaltus extension declares
// the SAME augmentation in packages/jovaltus to call `ctx.ui.askQuestions`.
//
// NOTE: imported for side effects from session-supervisor.ts (and via it from
// every driver consumer) — a standalone .d.ts would not be part of the
// desktop's program (paths-alias pulls only .ts sources).
import type { ExtensionUIDialogOptions } from "@earendil-works/pi-coding-agent";
import '@earendil-works/pi-coding-agent';

declare module "@earendil-works/pi-coding-agent" {
  interface ExtensionUIContext {
    /**
     * Ask the user a list of clarification questions ONE at a time in a
     * wizard: suggested options per question plus a free-text "Other" path,
     * with Next/Submit paging and a total count. Returns one answer per
     * question (the chosen option or the typed text), or undefined when the
     * user cancels.
     */
    askQuestions?(
      title: string,
      questions: readonly { readonly question: string; readonly options: readonly string[] }[],
      opts?: ExtensionUIDialogOptions,
    ): Promise<readonly string[] | undefined>;
  }
}
