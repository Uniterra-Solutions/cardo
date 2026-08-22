/**
 * Browser half apply (issue #2, FR-2.5): register the Uniterra copy dictionary and the
 * settings widgets for the llm-uniterra namespace — the model catalog (with endpoint
 * interrogation and the models.dev params panel) and the write-only API-key secret
 * field. The bespoke settings.section is retired: the generic settings page
 * (settings-ui) renders the namespace schema, with these widgets overriding the
 * model catalog and supplying the credentials-backed key (PRD FR-2.4/2.5). Widgets
 * register through the settingsUiWidgets service when settings-ui is present; the
 * provider never depends on it — the sub-fiber (ctx.inject) waits for the service,
 * it is not in the module inject list, so the provider applies regardless.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client';
// Type-only: pulls the ctx.locale Context merge into this program.
import type {} from '@deepseek-ai/dsh-client-locale/client';
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client';
import type { SettingsWidgetRegistry } from '@uniterra-solutions/uniterra-settings-ui';
import { createApiKeyWidget } from './widgets/api-key.tsx';
import { createModelCatalogWidget } from './widgets/model-catalog.tsx';
import type { UniterraKey } from './locale.ts';
import { en, zh } from './locale.ts';
import type { ModelsDevParamsRequest, ModelsDevParamsResponse } from './params-types.ts';

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The Uniterra settings copy. */
    'settings.uniterra': UniterraKey;
  }
}

/** Copy namespace owned by this plugin. */
const NS = 'settings.uniterra';

/** Settings namespace the provider registers (see host index.ts). */
const SETTINGS_NS = 'llm-uniterra';

/**
 * Widget styles. The browser bundle is one JS file (ClientModuleRegistry serves no
 * plugin CSS), so the widgets inject their rules as a fiber-scoped <style> element.
 * Every color rides the shell's `--dsw-alias-*` design tokens, which `ui-theme`
 * redefines under `body[data-ds-dark-theme]` — one set of rules renders correctly
 * in both light and dark themes. The recipes mirror `ui-settings-models` (.input,
 * .primaryButton, .secondaryButton).
 */
const SECTION_CSS = `
.uniterra-field { display: flex; flex-direction: column; gap: 4px; margin-bottom: 12px; }
.uniterra-input {
  box-sizing: border-box; padding: 6px 10px; border-radius: 8px;
  border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
  font: inherit; font-size: 13px;
}
.uniterra-input:focus { outline: none; border-color: var(--dsw-alias-brand-primary); }
.uniterra-input::placeholder { color: var(--dsw-alias-label-dimmed); }
.uniterra-input:disabled { opacity: 0.6; cursor: default; }
.uniterra-button {
  padding: 6px 12px; border-radius: 6px; font: inherit; font-size: 13px;
  border: 1px solid var(--dsw-alias-border-l2);
  background: transparent; color: var(--dsw-alias-label-primary);
  cursor: pointer;
}
.uniterra-button:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.uniterra-button:disabled { opacity: 0.4; cursor: default; }
.uniterra-button--primary {
  border-color: transparent;
  background: var(--dsw-alias-button-primary-fill);
  color: var(--dsw-alias-label-primary-foreground);
}
.uniterra-button--primary:hover:not(:disabled) { background: var(--dsw-alias-button-primary-hover); }
.uniterra-error { color: var(--dsw-alias-state-error-primary); }
.uniterra-hint { font-size: 12px; color: var(--dsw-alias-label-tertiary); }
/* Model catalog, mirroring ui-settings-models: one bordered entry per
   model, id and display name on the row, capacities behind the row's own
   disclosure. */
.uniterra-catalog {
  display: flex; flex-direction: column; gap: 10px;
  padding-top: 12px; margin-bottom: 12px;
  border-top: 1px solid var(--dsw-alias-border-l2);
}
.uniterra-catalog-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.uniterra-catalog-title {
  font-size: 12px; line-height: 18px; font-weight: 500;
  color: var(--dsw-alias-label-secondary);
}
.uniterra-linkbutton {
  box-sizing: border-box; display: inline-flex; align-items: center;
  height: 28px; padding: 0 10px; border: none; border-radius: 14px;
  background: transparent; color: var(--dsw-alias-label-primary);
  font: inherit; font-size: 12px; cursor: pointer;
}
.uniterra-linkbutton:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.uniterra-linkbutton:disabled { opacity: 0.4; cursor: default; }
.uniterra-empty { margin: 0; color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 18px; }
.uniterra-entry {
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  padding: 6px;
}
.uniterra-modelrow {
  display: grid;
  grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr) auto auto;
  align-items: center;
  gap: 6px;
}
/* Square, label-free affordances: the row's own inputs carry the meaning, so
   the actions stay glyphs and announce themselves through aria-label. */
.uniterra-iconbutton {
  box-sizing: border-box; display: inline-flex; align-items: center; justify-content: center;
  width: 28px; height: 28px; border: none; border-radius: 6px;
  background: transparent; color: var(--dsw-alias-label-tertiary);
  cursor: pointer;
}
.uniterra-iconbutton:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-primary);
}
.uniterra-iconbutton:disabled { opacity: 0.4; cursor: default; }
.uniterra-iconbutton--danger:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover-danger);
  color: var(--dsw-alias-state-error-primary);
}
.uniterra-modeladvanced {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: 8px;
  padding: 8px 4px 2px;
}
.uniterra-modelfield { display: flex; flex-direction: column; gap: 4px; }
.uniterra-modelfield-label { color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 18px; }
.uniterra-addmodel {
  box-sizing: border-box; align-self: flex-start; display: inline-flex; align-items: center;
  gap: 4px; height: 28px; padding: 0 10px;
  border: 1px solid var(--dsw-alias-border-l2); border-radius: 14px;
  background: transparent; color: var(--dsw-alias-label-primary);
  font: inherit; font-size: 12px; cursor: pointer;
}
.uniterra-addmodel:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.uniterra-addmodel:disabled { opacity: 0.4; cursor: default; }
.uniterra-candidates { border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; padding: 12px; margin-bottom: 12px; }
.uniterra-candidates ul { list-style: none; padding: 0; margin: 8px 0; }
/* Proxy control + models.dev params panel. */
.uniterra-proxyrow {
  display: flex; flex-direction: row; align-items: center; flex-wrap: wrap;
  gap: 8px; margin-bottom: 12px;
}
.uniterra-proxyrow label { display: inline-flex; align-items: center; gap: 6px; color: var(--dsw-alias-label-primary); }
.uniterra-select {
  box-sizing: border-box; padding: 6px 10px; border-radius: 8px;
  border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
  font: inherit; font-size: 13px; max-width: 220px;
}
.uniterra-params {
  border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px;
  padding: 12px; margin-bottom: 12px;
}
.uniterra-params-summary { margin: 6px 0 10px; color: var(--dsw-alias-label-tertiary); font-size: 12px; }
.uniterra-params-row {
  display: grid; grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center; gap: 8px; padding: 4px 0;
}
/* The id rides a fixed-width text box so rows align; content wider than
   the box stays hidden until hover, when it scrolls horizontally. */
.uniterra-params-id {
  box-sizing: border-box; width: 30ch; max-width: 30ch;
  padding: 4px 8px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 6px;
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
  font: inherit; font-size: 12px; line-height: 18px;
  text-align: left; white-space: nowrap; overflow: hidden;
  scrollbar-width: thin;
}
.uniterra-params-id:hover { overflow-x: auto; }
.uniterra-params-values {
  color: var(--dsw-alias-label-tertiary); font-size: 12px;
  font-variant-numeric: tabular-nums; text-align: left;
}
.uniterra-params-unmatched { color: var(--dsw-alias-label-dimmed); font-size: 12px; padding: 4px 0; }
`;

/** Required services (cordis fiber inject): copy + the connection wire face. */
export const inject = ['locale', 'connection'];

/**
 * Register the Uniterra settings widgets.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'llm-uniterra: copy dictionaries');

  // Fiber-scoped styles: removed with the plugin, so a reload swaps them cleanly.
  if (typeof document !== 'undefined') {
    ctx.effect((): (() => void) => {
      const element = document.createElement('style');
      element.textContent = SECTION_CSS;
      document.head.append(element);
      return () => {
        element.remove();
      };
    }, 'llm-uniterra: widget styles');
  }

  // The connection service's shape differs between the host and browser type faces
  // (HostConnectionHandle vs ConnectionHandle). This file compiles under both
  // (tsconfig.json includes src/client), and at runtime it only ever sees the
  // browser face — so the double assertion is the honest bridge.
  const connection = ctx.get('connection') as unknown as ConnectionHandle;
  const t = ctx.locale.bind(NS) as (key: UniterraKey, params?: Record<string, unknown>) => string;

  // One plain callback over the plugin's host RPC channel: the browser names the
  // gateway model ids and the host downloads https://models.dev/api.json — no
  // cross-origin fetch in the browser.
  const fetchModelParams = (
    request: ModelsDevParamsRequest,
  ): Promise<
    { ok: true; value: ModelsDevParamsResponse } | { ok: false; error: { message: string } }
  > =>
    connection.rpc.call('/llm-uniterra', 'models-dev-params', request) as Promise<
      { ok: true; value: ModelsDevParamsResponse } | { ok: false; error: { message: string } }
    >;

  // Register the widgets once the settings-ui extension is present. A sub-fiber
  // (ctx.inject), deliberately NOT part of the module inject list: without
  // settings-ui the provider still applies — this fiber simply never fires.
  ctx.inject(['settingsUiWidgets'], (cctx) => {
    const registry = cctx.get('settingsUiWidgets') as SettingsWidgetRegistry;
    const wire = cctx.get('connection') as unknown as ConnectionHandle;
    registry.register(
      SETTINGS_NS,
      'models',
      createModelCatalogWidget({ t, api: wire.api, fetchModelParams }),
    );
    registry.register(
      SETTINGS_NS,
      'apiKey',
      createApiKeyWidget({ t, credentials: wire.api.credentials }),
    );
  });
}
