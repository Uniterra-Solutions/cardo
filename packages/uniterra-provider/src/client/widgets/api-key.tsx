/**
 * The write-only API-key virtual widget (issue #2, FR-2.4/FR-2.5). The
 * provider Config deliberately has NO apiKey schema field: the key persists
 * through the dsh credentials service (`api.credentials`, ref `uniterra`)
 * and the host half resolves it per request. This widget is registered at the
 * namespace level (fieldPath `apiKey` is not a schema field path), so the
 * generic form renders it as a namespace panel — and it NEVER calls
 * onChange: the draft has no apiKey slot to write (PRD FR-2.4 line 25).
 *
 * The input follows the official credential pattern: a read-only credential
 * (launch environment) locks the input and the placeholder states the fact.
 */
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import type { IApiClient } from '@deepseek-ai/dsh-client-connection/client';
import type { SettingsWidget } from '@uniterra-solutions/uniterra-settings-ui';
import type { UniterraKey } from '../locale.ts';

/** Credential reference the host half resolves per request (see host index.ts). */
const KEY_REF = 'uniterra';

/** The widget contract (structural mirror of settings-ui SettingsWidgetProps). */
interface ApiKeyWidgetProps {
  ns: string;
  fieldPath: string;
  value: unknown;
  onChange: (value: unknown) => void;
  t: (key: UniterraKey, params?: Record<string, unknown>) => string;
  call: unknown;
}

/** The widget faces the apply closure owns (provider copy + credentials wire). */
export interface ApiKeyFaces {
  t: (key: UniterraKey, params?: Record<string, unknown>) => string;
  credentials: Pick<IApiClient['credentials'], 'describe' | 'set'>;
}

/** Register the write-only API-key virtual widget for the llm-uniterra namespace. */
export function createApiKeyWidget(faces: ApiKeyFaces): SettingsWidget {
  return { id: 'api-key', component: ApiKeyWidget };

  function ApiKeyWidget(_props: ApiKeyWidgetProps): ReactNode {
    const { t, credentials } = faces;
    const [configured, setConfigured] = useState<boolean | undefined>(undefined);
    /** Whether the credential seam reports the key reference read-only (launch environment). */
    const [locked, setLocked] = useState(false);
    const [draft, setDraft] = useState('');
    const [busy, setBusy] = useState(false);
    const [notice, setNotice] = useState<string | undefined>(undefined);
    const [errorText, setErrorText] = useState<string | undefined>(undefined);

    useEffect(() => {
      const controller = new AbortController();
      void (async (): Promise<void> => {
        try {
          const response = await credentials.describe({ refs: [KEY_REF] }, controller.signal);
          if (controller.signal.aborted) return;
          const result = response.result;
          if (result.ok) {
            const view = result.value.credentials[KEY_REF];
            setConfigured(view?.configured);
            setLocked(view?.writable === false);
          } else {
            setErrorText(result.error.message);
          }
        } catch (error) {
          if (!controller.signal.aborted)
            setErrorText(error instanceof Error ? error.message : String(error));
        }
      })();
      return (): void => {
        controller.abort();
      };
    }, [credentials]);

    const save = async (): Promise<void> => {
      const value = draft.trim();
      if (value.length === 0) return;
      setBusy(true);
      setNotice(undefined);
      setErrorText(undefined);
      try {
        const response = await credentials.set({ ref: KEY_REF, value });
        const result = response.result;
        if (result.ok) {
          setDraft('');
          setNotice(t('saved'));
          setConfigured(true);
        } else {
          setErrorText(result.error.message);
        }
      } catch (error) {
        setErrorText(error instanceof Error ? error.message : String(error));
      } finally {
        setBusy(false);
      }
    };

    const placeholder = locked
      ? t('keyEnvLocked')
      : configured === true
        ? t('keyStored')
        : configured === false
          ? t('keyMissing')
          : t('keyPlaceholder');

    return (
      <div className="uniterra-field">
        <label htmlFor="uniterra-api-key">{t('keyInput')}</label>
        <input
          id="uniterra-api-key"
          type="password"
          autoComplete="off"
          className="uniterra-input"
          disabled={locked}
          placeholder={placeholder}
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value);
          }}
        />
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button
            type="button"
            className="uniterra-button uniterra-button--primary"
            disabled={busy || locked || draft.trim().length === 0}
            onClick={() => {
              void save();
            }}
          >
            {busy ? t('applying') : t('apply')}
          </button>
          {notice === undefined ? null : (
            <span className="uniterra-hint" role="status">
              {notice}
            </span>
          )}
        </div>
        {errorText === undefined ? null : <p className="uniterra-error">{errorText}</p>}
      </div>
    );
  }
}
