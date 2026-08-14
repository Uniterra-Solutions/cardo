/**
 * Cardo desktop runtime — built-in extension registry for the pi-gui shell.
 *
 * The desktop app (vendor/pi-gui) imports `builtinExtensionFactories` and
 * passes them through the pi `ExtensionRunner` `extensionFactories` seam, so
 * cardo's workspace extensions ship inside the packaged app instead of being
 * installed externally. `builtinExtensionMetadata` mirrors the same order and
 * feeds the inline-extension display names. Add new extensions here as they
 * join the monorepo.
 */

import generalFactory from '@cardo/general';
import jovaltusFactory from '@cardo/jovaltus';
import type { ExtensionFactory } from '@earendil-works/pi-coding-agent';

export const builtinExtensionFactories: ExtensionFactory[] = [generalFactory, jovaltusFactory];

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
  {
    displayName: 'Jovaltus',
    description: 'Jovaltus pipeline: plan/execute/simplify/review',
  },
];
