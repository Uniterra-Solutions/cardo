/**
 * The Extensions / Integrations settings page (issue #2). One section lists
 * every installed extension: those exposing descriptor-backed namespaces get
 * one generic schema-driven form per namespace (FR-2.3), those exposing none
 * get the FR-2.7 read-only notice plus an optional open-profile-settings-
 * document action. Everything rides the '/settings-ui' bridge — the page
 * never reads connection.api.settings, whose allowlist would hide namespaces
 * like `memory`.
 */
import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { selectNamespaces } from '../discovery.ts';
import type { DiscoverySplit, ExtensionEntry } from '../discovery.ts';
import type { SettingsWidgetRegistry } from '../widget-registry.ts';
import type { BridgeCall, WireDescriptor } from './wire.ts';
import type { LocaleKey } from './locale.ts';
import { GenericForm } from './GenericForm.tsx';

/** The inject face the apply closure owns: bridge call, copy, widget registry. */
export interface IntegrationsSectionInject {
  call: BridgeCall;
  t: (key: LocaleKey, params?: Record<string, unknown>) => string;
  widgets: SettingsWidgetRegistry;
}

/** Composed props: the inject face plus the shell's close affordance. */
export interface IntegrationsSectionProps extends IntegrationsSectionInject {
  close: () => void;
}

type ViewState =
  | { kind: 'loading' }
  | { kind: 'error' }
  | { kind: 'ready'; split: DiscoverySplit; descriptors: readonly WireDescriptor[] };

export function IntegrationsSection(props: IntegrationsSectionProps): ReactNode {
  const { call, t, widgets } = props;
  const [view, setView] = useState<ViewState>({ kind: 'loading' });

  const fetchView = useCallback(async (): Promise<ViewState> => {
    const [describeResult, inventoryResult] = await Promise.all([
      call('describe', {}),
      call('inventory', {}),
    ]);
    if (!describeResult.ok || !inventoryResult.ok) return { kind: 'error' };
    const descriptors = (describeResult.value ?? []) as readonly WireDescriptor[];
    const inventory = (inventoryResult.value ?? []) as readonly ExtensionEntry[];
    const split = selectNamespaces(inventory, descriptors);
    return { kind: 'ready', split, descriptors };
  }, [call]);

  useEffect(() => {
    let cancelled = false;
    void fetchView()
      .then((next) => {
        if (!cancelled) setView(next);
      })
      .catch(() => {
        if (!cancelled) setView({ kind: 'error' });
      });
    return (): void => {
      cancelled = true;
    };
  }, [fetchView]);

  const reload = useCallback((): void => {
    setView({ kind: 'loading' });
    void fetchView()
      .then((next) => {
        setView(next);
      })
      .catch(() => {
        setView({ kind: 'error' });
      });
  }, [fetchView]);

  if (view.kind === 'loading') {
    return <p className="settings-ui-hint">{t('loading')}</p>;
  }
  if (view.kind === 'error') {
    return (
      <div className="settings-ui-error">
        <p>{t('loadFailed')}</p>
        <button type="button" className="settings-ui-button" onClick={reload}>
          {t('retry')}
        </button>
      </div>
    );
  }
  return (
    <div className="settings-ui">
      {view.split.withSettings.map((entry) => (
        <section key={entry.extension.id} className="settings-ui-extension">
          <h2 className="settings-ui-extension-name">{entry.extension.name}</h2>
          {entry.namespaces.map((descriptor) => {
            const wire = view.descriptors.find((candidate) => candidate.ns === descriptor.ns);
            if (wire === undefined) return null;
            return (
              <GenericForm
                key={wire.ns}
                ns={wire.ns}
                descriptor={wire}
                t={t}
                widgets={widgets}
                call={call}
              />
            );
          })}
        </section>
      ))}
      {view.split.withoutSettings.map((entry) => (
        <section key={entry.id} className="settings-ui-extension">
          <h2 className="settings-ui-extension-name">{entry.name}</h2>
          <p className="settings-ui-hint">{t('noSettings')}</p>
          <OpenDocumentAction call={call} t={t} />
        </section>
      ))}
    </div>
  );
}

/** The FR-2.7 document affordance: hasDocument → openDocument, never a path leak. */
function OpenDocumentAction(props: {
  call: BridgeCall;
  t: (key: LocaleKey, params?: Record<string, unknown>) => string;
}): ReactNode {
  const { call, t } = props;
  const [state, setState] = useState<'idle' | 'opening' | 'opened' | 'failed'>('idle');
  const open = useCallback((): void => {
    setState('opening');
    void (async (): Promise<void> => {
      try {
        const has = await call('hasDocument', {});
        if (!has.ok || has.value !== true) {
          setState('failed');
          return;
        }
        const opened = await call('openDocument', {});
        setState(opened.ok ? 'opened' : 'failed');
      } catch {
        setState('failed');
      }
    })();
  }, [call]);
  return (
    <div className="settings-ui-actions">
      <button
        type="button"
        className="settings-ui-button"
        onClick={open}
        disabled={state === 'opening'}
      >
        {state === 'opening' ? t('opening') : t('openDocument')}
      </button>
      {state === 'opened' && <span className="settings-ui-hint">{t('opened')}</span>}
      {state === 'failed' && <span className="settings-ui-error">{t('openFailed')}</span>}
    </div>
  );
}
