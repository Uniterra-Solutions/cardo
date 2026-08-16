/**
 * Cardo desktop runtime — built-in extension registry for the pi-gui shell.
 *
 * The desktop app (vendor/pi-gui) imports `builtinExtensionFactories` and
 * passes them through the pi `ExtensionRunner` `extensionFactories` seam, so
 * cardo's workspace extensions ship inside the packaged app instead of being
 * installed externally. `builtinExtensionMetadata` mirrors the same order and
 * feeds the inline-extension display names. Add new extensions here as they
 * join the monorepo.
 *
 * NOTE (dsh migration 2026-08): the Jovaltus/cardo-planmode pipeline no
 * longer ships as a pi extension — it is a bundled skill
 * (`packages/skills/src/skills/cardo-planmode`) whose workflow scripts run
 * through the harness's native `workflow` tool. Only the working-rules
 * extension remains.
 */

import generalFactory from '@cardo/cardo-systemprompt';
import type { ExtensionFactory } from '@earendil-works/pi-coding-agent';

export const builtinExtensionFactories: ExtensionFactory[] = [generalFactory];

export interface BuiltinExtensionMetadata {
  readonly displayName: string;
  readonly description?: string;
}

/** Display metadata for each built-in factory, same order as the factories. */
export const builtinExtensionMetadata: BuiltinExtensionMetadata[] = [
  {
    displayName: 'General',
    description: 'App-wide working rules injected into the system prompt',
  },
];
