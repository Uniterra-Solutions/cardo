/**
 * Universal settings UI extension — host half (issue #2). Ships the pure
 * modules the generic renderer builds on (field-tree mapper, widget registry,
 * discovery split, settings bridge) and the host plugin entry that wires the
 * bridge onto the profile's `ctx.settings` over its OWN RPC channel. The
 * browser half NEVER reads `connection.api.settings` — its allowlist would
 * hide namespaces like `memory`; every read/write crosses this bridge
 * instead. The channel also serves the extension inventory (cordis runtime
 * names) so the browser can split it against the descriptors for the FR-2.7
 * read-only notice.
 * @module @uniterra-solutions/uniterra-settings-ui
 */
import type { Context } from '@deepseek-ai/cordis';
import type {
  ConnectionRpcHandler,
  HostConnectionHandle,
} from '@deepseek-ai/dsh-client-connection';
import { createSettingsBridge } from './bridge.ts';
import type { BridgeResult } from './bridge.ts';
import type { ExtensionEntry } from './discovery.ts';

export {
  toFieldTree,
  collectFieldPaths,
  type FieldNode,
  type FieldNodeType,
} from './field-tree.ts';
export {
  createSettingsWidgetRegistry,
  type SettingsWidget,
  type SettingsWidgetRegistry,
} from './widget-registry.ts';
export {
  selectNamespaces,
  type DiscoverySplit,
  type ExtensionEntry,
  type NamespaceDescriptor,
} from './discovery.ts';
export {
  createSettingsBridge,
  type BridgeResult,
  type SeamSecret,
  type SeamSettingsDescriptor,
  type SettingsBridge,
  type SettingsLike,
  type SettingsWireDescriptor,
} from './bridge.ts';

/** Stable Cordis plugin name. */
export const name = 'settings-ui';

/** Plugin rows applied after the connection + settings services are ready. */
export const inject = ['connection'];

/**
 * Register the '/settings-ui' host RPC channel bridging host ctx.settings
 * (describe/update/replace/mutate + document affordance) and the extension
 * inventory. The bridge is created per call so a settings service mounted
 * after this plugin is still observed.
 */
export function apply(ctx: Context): void {
  ctx.inject(['connection'], (cctx) => {
    const connection = cctx.get('connection') as HostConnectionHandle;
    cctx.effect(
      () =>
        connection.rpc.handle(
          '/settings-ui',
          ((
            endpoint: string,
            payload: unknown,
            signal: AbortSignal,
          ): Promise<BridgeResult<unknown>> =>
            createSettingsBridge(ctx.settings, () => inventoryOf(ctx)).handle(
              endpoint,
              payload,
              signal,
            )) as ConnectionRpcHandler,
          { authority: 'loopback' },
        ),
      'settings-ui: settings bridge RPC channel',
    );
  });
}

/** Enumerate the installed extensions from the cordis plugin registry. */
function inventoryOf(ctx: Context): ExtensionEntry[] {
  const entries: ExtensionEntry[] = [];
  const seen = new Set<string>();
  ctx.registry.forEach((runtime) => {
    const id = runtime.name;
    if (id === undefined || seen.has(id)) return;
    seen.add(id);
    entries.push({ id, name: id });
  });
  return entries;
}
