/**
 * Cardo: jovaltus declares the `ctx.ui.askQuestions` wizard surface on pi's
 * ExtensionUIContext via module augmentation (pi-coding-agent ships in
 * node_modules and cannot be edited). The desktop host implements it under
 * the same augmentation (vendor/pi-gui/packages/pi-sdk-driver/src/
 * extension-ui-augment.d.ts).
 *
 * NOTE: the side-effect import is REQUIRED — a .d.ts with no top-level
 * import/export is a global ambient module declaration that SHADOWS the real
 * on-disk package (all its exports disappear).
 */
import '@earendil-works/pi-coding-agent';

declare module '@earendil-works/pi-coding-agent' {
  interface ExtensionUIContext {
    /**
     * Ask a list of clarification questions ONE at a time in a wizard:
     * suggested options per question plus a free-text "Other" path, with
     * Next/Submit paging and a total count. Returns one answer per question
     * (the chosen option or the typed text), or undefined when the user
     * cancels.
     */
    askQuestions?(
      title: string,
      questions: readonly { readonly question: string; readonly options: readonly string[] }[],
      opts?: ExtensionUIDialogOptions,
    ): Promise<readonly string[] | undefined>;
  }
}
