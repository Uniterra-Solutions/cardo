/**
 * Browser half apply: register ONE settings.section page (id 'integrations',
 * 'Extensions / Integrations') that lists every namespace from the host
 * bridge's describe() and renders the generic schema-driven form per
 * namespace (field-tree → controls, widget registry overrides), plus the
 * FR-2.7 read-only notice for extensions with no registered namespace and the
 * optional open-profile-settings-document action. The page NEVER reads
 * connection.api.settings — every read/write crosses the '/settings-ui'
 * bridge. The widget registry is provided as a client cordis service so
 * feature plugins (the provider) register bespoke controls (FR-2.5).
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client';
// Type-only: pulls the ctx.locale Context merge into this program.
import type {} from '@deepseek-ai/dsh-client-locale/client';
// Type-only: pulls the shell's SlotMap merge (the 'settings.section' entry).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client';
import type { ConnectionHandle, RpcResult } from '@deepseek-ai/dsh-client-connection/client';
import { createSettingsWidgetRegistry } from '../widget-registry.ts';
import type { SettingsWidgetRegistry } from '../widget-registry.ts';
import { IntegrationsSection } from './IntegrationsSection.tsx';
import type { IntegrationsSectionInject } from './IntegrationsSection.tsx';
import type { LocaleKey } from './locale.ts';
import { en, zh } from './locale.ts';

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Client-side widget registry feature plugins register bespoke controls into (FR-2.5). */
    settingsUiWidgets: SettingsWidgetRegistry;
  }
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The Integrations settings page copy. */
    'settings.integrations': LocaleKey;
  }
}

/** Copy namespace owned by this plugin. */
const NS = 'settings.integrations';

/** Cordis service name exposing the widget registry to feature plugins. */
export const WIDGET_SERVICE = 'settingsUiWidgets';

/**
 * Section styles. The browser bundle is one JS file (ClientModuleRegistry
 * serves no plugin CSS), so the section injects its rules as a fiber-scoped
 * <style> element. Every color rides the shell's `--dsw-alias-*` design
 * tokens, which ui-theme redefines under `body[data-ds-dark-theme]` — one
 * set of rules renders correctly in both light and dark themes.
 */
const SECTION_CSS = `
.settings-ui { display: flex; flex-direction: column; gap: 16px; }
.settings-ui-extension {
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  padding: 12px;
}
.settings-ui-extension-name {
  margin: 0 0 8px; font-size: 14px; font-weight: 500;
  color: var(--dsw-alias-label-primary);
}
.settings-ui-ns-title {
  margin: 12px 0 8px; font-size: 12px; line-height: 18px; font-weight: 500;
  color: var(--dsw-alias-label-secondary);
}
.settings-ui-field { display: flex; flex-direction: column; gap: 4px; margin-bottom: 12px; }
.settings-ui-field-label { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); }
.settings-ui-input {
  box-sizing: border-box; padding: 6px 10px; border-radius: 8px;
  border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
  font: inherit; font-size: 13px;
}
.settings-ui-input:focus { outline: none; border-color: var(--dsw-alias-brand-primary); }
.settings-ui-textarea { font-family: monospace; }
.settings-ui-select {
  box-sizing: border-box; padding: 6px 10px; border-radius: 8px;
  border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
  font: inherit; font-size: 13px; max-width: 260px;
}
.settings-ui-fieldset { border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; padding: 8px 12px 0; margin: 0 0 12px; }
.settings-ui-button {
  padding: 6px 12px; border-radius: 6px; font: inherit; font-size: 13px;
  border: 1px solid var(--dsw-alias-border-l2);
  background: transparent; color: var(--dsw-alias-label-primary);
  cursor: pointer;
}
.settings-ui-button:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.settings-ui-button:disabled { opacity: 0.4; cursor: default; }
.settings-ui-button--primary {
  border-color: transparent;
  background: var(--dsw-alias-button-primary-fill);
  color: var(--dsw-alias-label-primary-foreground);
}
.settings-ui-button--primary:hover:not(:disabled) { background: var(--dsw-alias-button-primary-hover); }
.settings-ui-hint { margin: 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }
.settings-ui-error { margin: 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-state-error-primary); }
.settings-ui-readonly { margin: 0; font-size: 13px; color: var(--dsw-alias-label-primary); }
.settings-ui-actions { display: flex; align-items: center; gap: 8px; }
.settings-ui-virtual { margin: 4px 0 12px; }
`;

/** Required services (cordis fiber inject): the section slot, copy, and the wire face. */
export const inject = ['slots', 'locale', 'connection'];

/**
 * Register the Integrations settings section and the widget registry service.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'settings-ui: copy dictionaries');

  const widgets = createSettingsWidgetRegistry();
  ctx.provide(WIDGET_SERVICE, widgets);

  // Fiber-scoped styles: removed with the plugin, so a reload swaps them cleanly.
  if (typeof document !== 'undefined') {
    ctx.effect((): (() => void) => {
      const element = document.createElement('style');
      element.textContent = SECTION_CSS;
      document.head.append(element);
      return () => {
        element.remove();
      };
    }, 'settings-ui: section styles');
  }

  // The connection service's shape differs between the host and browser
  // type faces (HostConnectionHandle vs ConnectionHandle). This file compiles
  // under both (tsconfig.json includes src/client), and at runtime it only
  // ever sees the browser face — so the double assertion is the honest bridge.
  const connection = ctx.get('connection') as unknown as ConnectionHandle;
  const t = ctx.locale.bind(NS);

  // One plain callback over the plugin's host RPC channel: the browser names
  // the endpoint and payload, the host half owns the settings seam.
  const call = (endpoint: string, payload: unknown): Promise<RpcResult<unknown>> =>
    connection.rpc.call('/settings-ui', endpoint, payload);

  const injectFace: IntegrationsSectionInject = { call, t, widgets };

  ctx.slots.inject('settings.section', () =>
    ctx.slots.register(
      {
        name: 'settings.section',
        id: 'integrations',
        order: 20,
        label: () => t('nav'),
        inject: () => injectFace,
      },
      IntegrationsSection,
    ),
  );
}
