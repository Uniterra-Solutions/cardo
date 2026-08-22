/**
 * The model catalog widget (issue #2, FR-2.5): renders the `models` field of
 * the llm-uniterra namespace as the bespoke editor previously shipped in
 * UniterraSection.tsx — one bordered entry per model with id and display
 * name on the row, the two token capacities behind the row's own disclosure,
 * K/M-suffixed capacity entry, endpoint interrogation (fetch/adopt), and the
 * models.dev parameter panel (FR-2.5: "model catalog capacity/interrogation"
 * and "models.dev params" in one widget, matching the previous UX).
 *
 * The widget edits the namespace draft through SettingsWidgetProps.onChange
 * (`models` is a schema field), so the generic form's Save persists it with
 * the rest of the configuration. Two behaviors differ from the old section
 * because the form owns saving:
 *  - the draft only ever receives a VALID catalog (non-empty unique ids,
 *    capacity text that parses); invalid input stays in the widget's buffers
 *    and surfaces as the same localized problem message, so a stale valid
 *    snapshot is what the form persists;
 *  - endpoint interrogation and the models.dev lookup run against the host's
 *    stored configuration (no draft baseURL/apiKey/proxyUrl overrides — the
 *    host adapter falls back to the stored config + credentials).
 *
 * Styles come from the fiber-scoped `uniterra-*` stylesheet the apply
 * closure injects; it rides the shell's `--dsw-alias-*` tokens.
 */
import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { DiscoveredModelView, IApiClient } from '@deepseek-ai/dsh-client-connection/client';
import type { SettingsWidget } from '@uniterra-solutions/uniterra-settings-ui';
import type { UniterraKey } from '../locale.ts';
import type { ModelsDevParamsRequest, ModelsDevParamsResponse } from '../params-types.ts';

/** The widget contract (structural mirror of settings-ui SettingsWidgetProps). */
interface CatalogWidgetProps {
  ns: string;
  fieldPath: string;
  value: unknown;
  onChange: (value: unknown) => void;
  t: (key: UniterraKey, params?: Record<string, unknown>) => string;
  call: unknown;
}

/** Settings namespace the provider registers (see host index.ts). */
const NS = 'llm-uniterra';

/** One catalog entry, structurally open like the official editors. */
type ModelDraft = Record<string, unknown>;

/** A row's text field, or the empty string when unset or not a string. */
function textOf(model: ModelDraft, key: string): string {
  const value = model[key];
  return typeof value === 'string' ? value : '';
}

/** A row's numeric field, or `undefined` when unset or not a number. */
function numberOf(model: ModelDraft, key: string): number | undefined {
  const value = model[key];
  return typeof value === 'number' ? value : undefined;
}

/** The two token counts edited as K/M-suffixed text behind a row's disclosure. */
type CapacityField = 'contextWindow' | 'maxTokens';

/** Accepted capacity spellings: a decimal count with an optional K/M suffix. */
const CAPACITY_PATTERN = /^(\d+(?:\.\d+)?)([km])?$/i;

/** Decimal suffix scales — `1M` is 1000K, matching how model capacities are quoted. */
const CAPACITY_SCALE = { k: 1_000, m: 1_000_000 } as const;

/**
 * Read a typed capacity, so a user can write `256K` or `1M` instead of
 * counting zeroes. The stored value stays a plain token count.
 * @param text - raw field text.
 * @returns the count; `undefined` when blank (drop), `NaN` when unreadable.
 */
function parseCapacity(text: string): number | undefined {
  const trimmed = text.trim();
  if (trimmed.length === 0) return undefined;
  const match = CAPACITY_PATTERN.exec(trimmed);
  if (match === null) return Number.NaN;
  const suffix = match[2]?.toLowerCase();
  const scale = suffix === 'k' || suffix === 'm' ? CAPACITY_SCALE[suffix] : 1;
  const scaled = Number(match[1]) * scale;
  const rounded = Math.round(scaled);
  return Math.abs(scaled - rounded) < 1e-6 ? rounded : scaled;
}

/**
 * Spell a stored count back in the shortest form that survives a round trip
 * through {@link parseCapacity}.
 */
function formatCapacity(value: number): string {
  if (!Number.isInteger(value) || value <= 0) return String(value);
  if (value % CAPACITY_SCALE.m === 0) return `${String(value / CAPACITY_SCALE.m)}M`;
  if (value % CAPACITY_SCALE.k === 0) return `${String(value / CAPACITY_SCALE.k)}K`;
  return String(value);
}

/** What an empty capacity field is worth, shown as its placeholder. */
const CAPACITY_HINT: Readonly<Record<CapacityField, string>> = {
  contextWindow: '128K',
  maxTokens: '8K',
};

/**
 * The default effort for a row with no preset chosen — mirrors the adapter's
 * `defaultEffortOf`: prefer the officially recommended `high` rung when the
 * model declares it, else the highest declared rung.
 */
const EFFORT_RUNG: Readonly<Record<string, number>> = {
  max: 7,
  xhigh: 6,
  high: 5,
  medium: 4,
  low: 3,
  minimal: 2,
  none: 1,
  default: 0,
};

function highestOf(efforts: readonly unknown[]): string {
  const ids = efforts.filter((effort): effort is string => typeof effort === 'string');
  if (ids.includes('high')) return 'high';
  return [...ids].sort((a, b) => (EFFORT_RUNG[b] ?? -1) - (EFFORT_RUNG[a] ?? -1))[0] ?? '';
}

/** Buffer key for one capacity field; the row half moves when rows do. */
function bufferKey(index: number, field: CapacityField): string {
  return `${String(index)}:${field}`;
}

/** Convert a stored section value into editable rows without dropping fields. */
function toDrafts(source: unknown): ModelDraft[] {
  if (!Array.isArray(source)) return [];
  return source.map((entry) =>
    typeof entry === 'object' && entry !== null && !Array.isArray(entry)
      ? (entry as ModelDraft)
      : {},
  );
}

/**
 * Replace one row, dropping optional fields the edit emptied (an empty string
 * or `undefined` clears the field entirely).
 */
function patchModel(
  model: ModelDraft,
  next: Record<string, string | number | undefined>,
): ModelDraft {
  const cleared = new Set(
    Object.entries(next)
      .filter(([, value]) => value === undefined || value === '')
      .map(([key]) => key),
  );
  return Object.fromEntries(
    Object.entries({ ...model, ...next }).filter(([key]) => !cleared.has(key)),
  );
}

/** Disclosure chevron; rotates to point down while its row is open. */
function IconChevron({ open }: { open: boolean }): ReactNode {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden
      style={{ transform: open ? 'rotate(90deg)' : undefined, transition: 'transform 120ms ease' }}
    >
      <path
        d="M6 3.5L10.5 8L6 12.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Removal glyph for one model row. */
function IconTrash(): ReactNode {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M2.5 4h11M6.5 4V2.5h3V4M4 4l.7 9a1 1 0 001 .9h4.6a1 1 0 001-.9L12 4M6.5 6.8v4.4M9.5 6.8v4.4"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** The widget faces the apply closure owns (provider copy + wire). */
export interface ModelCatalogFaces {
  t: (key: UniterraKey, params?: Record<string, unknown>) => string;
  api: Pick<IApiClient, 'llm'>;
  /** Host-side models.dev catalog lookup (browser sends ids only). */
  fetchModelParams: (
    request: ModelsDevParamsRequest,
  ) => Promise<
    { ok: true; value: ModelsDevParamsResponse } | { ok: false; error: { message: string } }
  >;
}

/** Register the model catalog override for the llm-uniterra namespace. */
export function createModelCatalogWidget(faces: ModelCatalogFaces): SettingsWidget {
  return { id: 'model-catalog', component: ModelCatalogWidget };

  function ModelCatalogWidget(props: CatalogWidgetProps): ReactNode {
    const { value, onChange } = props;
    const { t, api, fetchModelParams } = faces;

    const [models, setModels] = useState<ModelDraft[]>(() => toDrafts(value));
    // Rows carry an id and a name; capacities stay folded behind the row's own
    // disclosure rather than crowding every row with four inputs.
    const [expanded, setExpanded] = useState<ReadonlySet<number>>(new Set());
    // Capacities are edited as text, so a field's keystrokes are held here
    // rather than re-derived from the parsed count on every change — that
    // would rewrite `1000` to `1K` mid-word.
    const [editing, setEditing] = useState<ReadonlyMap<string, string>>(new Map());
    const [busy, setBusy] = useState(false);
    const [notice, setNotice] = useState<string | undefined>(undefined);
    const [errorText, setErrorText] = useState<string | undefined>(undefined);
    /** The first problem that keeps the current draft from persisting. */
    const [problemText, setProblemText] = useState<string | undefined>(undefined);
    const [candidates, setCandidates] = useState<readonly DiscoveredModelView[] | undefined>(
      undefined,
    );
    const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
    /** models.dev lookup result the params panel resolves against. */
    const [params, setParams] = useState<ModelsDevParamsResponse | undefined>(undefined);
    /** Chosen match index per model id, for ids with several providers. */
    const [paramChoices, setParamChoices] = useState<ReadonlyMap<string, number>>(new Map());
    const [paramsBusy, setParamsBusy] = useState(false);
    /** The result panel, scrolled into view when a lookup lands. */
    const paramsRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
      setModels(toDrafts(value));
    }, [value]);

    useEffect(() => {
      // Feedback that the lookup finished: the panel may render below the fold
      // behind a long model list, so bring it to the user.
      paramsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }, [params]);

    /**
     * Refuse to persist a catalog the host would not accept: an empty or
     * duplicate id, or capacity text that does not parse. Mirrors the old
     * section's save-time check; the widget applies it per change so the form's
     * draft only ever carries a valid catalog.
     */
    const problemOf = (
      next: readonly ModelDraft[],
      buffers: ReadonlyMap<string, string>,
    ): string | undefined => {
      const seen = new Set<string>();
      for (const [index, model] of next.entries()) {
        const id = textOf(model, 'id').trim();
        if (id.length === 0) return `${t('modelIdRequired')} (${t('models')} ${String(index + 1)})`;
        if (seen.has(id)) return `${t('modelIdDuplicate')} (${id})`;
        seen.add(id);
        for (const field of ['contextWindow', 'maxTokens'] as const) {
          const buffer = buffers.get(bufferKey(index, field));
          if (buffer !== undefined && Number.isNaN(parseCapacity(buffer) ?? 0)) {
            return `${t('capacityInvalid')} (${id} · ${t(field)})`;
          }
        }
      }
      return undefined;
    };

    /** Update the display and — only when valid — the form draft, in one pass. */
    const commit = (next: readonly ModelDraft[], buffers: ReadonlyMap<string, string>): void => {
      setModels([...next]);
      const problem = problemOf(next, buffers);
      setProblemText(problem);
      if (problem === undefined) onChange([...next]);
    };

    /** Replace one row's fields (id, name, protocol, preset). */
    const patch = (index: number, next: Record<string, string | number | undefined>): void => {
      commit(
        models.map((model, at) => (at === index ? patchModel(model, next) : model)),
        editing,
      );
    };

    const toggleExpanded = (index: number): void => {
      setExpanded((current) => {
        const next = new Set(current);
        if (!next.delete(index)) next.add(index);
        return next;
      });
    };

    /** What a capacity field shows: the buffer while typing, else the stored count. */
    const capacityText = (model: ModelDraft, index: number, field: CapacityField): string =>
      editing.get(bufferKey(index, field)) ??
      (numberOf(model, field) === undefined
        ? ''
        : formatCapacity(numberOf(model, field) as number));

    const editCapacity = (index: number, field: CapacityField, text: string): void => {
      const buffers = new Map(editing).set(bufferKey(index, field), text);
      setEditing(buffers);
      commit(
        models.map((model, at) =>
          at === index ? patchModel(model, { [field]: parseCapacity(text) }) : model,
        ),
        buffers,
      );
    };

    /** Drop one row's entries and shift the rows after it down, in one pass. */
    const reindexOnRemove = (
      current: ReadonlyMap<string, string>,
      index: number,
    ): Map<string, string> => {
      const next = new Map<string, string>();
      for (const [key, value] of current) {
        const at = Number(key.slice(0, key.indexOf(':')));
        if (at === index) continue;
        next.set(at > index ? key.replace(/^\d+/, String(at - 1)) : key, value);
      }
      return next;
    };

    const removeModel = (index: number): void => {
      commit(
        models.filter((_model, at) => at !== index),
        reindexOnRemove(editing, index),
      );
      // Both stores are keyed by position, so every row after this one shifts
      // down and would otherwise inherit its neighbour's state.
      setExpanded((current) => {
        const next = new Set<number>();
        for (const at of current) {
          if (at < index) next.add(at);
          else if (at > index) next.add(at - 1);
        }
        return next;
      });
    };

    const fetchModels = async (): Promise<void> => {
      setBusy(true);
      setErrorText(undefined);
      setCandidates(undefined);
      try {
        // No baseURL/apiKey overrides: the host falls back to the stored
        // configuration and credentials (see host adapter.discoverModels).
        const response = await api.llm.discoverModels({
          settingsNs: NS,
          provider: 'uniterra',
        });
        if (!response.result.ok) {
          setErrorText(response.result.error.message);
          return;
        }
        const found = response.result.value.models;
        found.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
        if (found.length === 0) {
          setErrorText(t('fetchEmpty'));
          return;
        }
        // Everything already configured starts unchecked, so adopting a
        // selection never silently rewrites a capacity the user corrected.
        const known = new Set(models.map((model) => textOf(model, 'id')));
        setCandidates(found);
        setPicked(new Set(found.filter((model) => !known.has(model.id)).map((model) => model.id)));
      } catch (error) {
        setErrorText(error instanceof Error ? error.message : String(error));
      } finally {
        setBusy(false);
      }
    };

    const toggle = (id: string): void => {
      setPicked((current) => {
        const next = new Set(current);
        if (!next.delete(id)) next.add(id);
        return next;
      });
    };

    const adopt = (): void => {
      if (candidates === undefined) return;
      const existing = new Map(models.map((model) => [textOf(model, 'id'), model]));
      for (const candidate of candidates) {
        if (!picked.has(candidate.id)) continue;
        // A row the user already tuned wins over the gateway's own numbers.
        if (existing.has(candidate.id)) continue;
        existing.set(candidate.id, {
          id: candidate.id,
          ...(candidate.name === undefined ? {} : { name: candidate.name }),
          ...(candidate.contextWindow === undefined
            ? {}
            : { contextWindow: candidate.contextWindow }),
          ...(candidate.maxTokens === undefined ? {} : { maxTokens: candidate.maxTokens }),
        });
      }
      // The form keeps id order after an adoption: new and old rows merge into
      // one alphabetized list instead of new rows appending at the end.
      commit(
        [...existing.values()].sort((a, b) => {
          const ai = textOf(a, 'id').trim();
          const bi = textOf(b, 'id').trim();
          if (ai.length === 0) return bi.length === 0 ? 0 : 1;
          if (bi.length === 0) return -1;
          return ai < bi ? -1 : ai > bi ? 1 : 0;
        }),
        editing,
      );
      setCandidates(undefined);
      setPicked(new Set());
    };

    /** Ask the host (via the RPC face) what models.dev knows about the rows. */
    const updateParams = async (): Promise<void> => {
      const ids = models.map((model) => textOf(model, 'id').trim()).filter((id) => id.length > 0);
      if (ids.length === 0) {
        setErrorText(t('paramsNoModels'));
        return;
      }
      setParamsBusy(true);
      setErrorText(undefined);
      setParams(undefined);
      try {
        // No proxyUrl override: the host uses the stored proxy configuration
        // (see host adapter.fetchModelsDevParams).
        const response = await fetchModelParams({ modelIds: ids });
        if (!response.ok) {
          setErrorText(response.error.message);
          return;
        }
        setParams(response.value);
        setParamChoices(new Map());
        // Completion feedback next to the action: matched/unmatched counts.
        const matched = response.value.models.filter((entry) => entry.matches.length > 0).length;
        setNotice(
          t('paramsSummary')
            .replace('{matched}', String(matched))
            .replace('{unmatched}', String(response.value.models.length - matched)),
        );
      } catch (error) {
        setErrorText(error instanceof Error ? error.message : String(error));
      } finally {
        setParamsBusy(false);
      }
    };

    /** The match a panel row currently shows: the user's choice, else the first. */
    const chosenMatch = (entry: {
      id: string;
      matches: ModelsDevParamsResponse['models'][number]['matches'];
    }): ModelsDevParamsResponse['models'][number]['matches'][number] =>
      entry.matches[paramChoices.get(entry.id) ?? 0] ??
      (entry.matches[0] as ModelsDevParamsResponse['models'][number]['matches'][number]);

    /**
     * Apply the panel's chosen matches to the rows: overwrite mode replaces
     * the capacities the catalog provides; blank mode only fills empty fields.
     */
    const applyParams = (overwrite: boolean): void => {
      if (params === undefined) return;
      const byId = new Map(params.models.map((entry) => [entry.id, entry]));
      let touched = 0;
      const next = models.map((model) => {
        const id = textOf(model, 'id').trim();
        const entry = byId.get(id);
        const match =
          entry === undefined || entry.matches.length === 0 ? undefined : chosenMatch(entry);
        if (match === undefined) return model;
        const nextContext = match.contextWindow;
        const nextMax = match.maxTokens;
        const nextEfforts = match.reasoningEfforts;
        const currentContext = numberOf(model, 'contextWindow');
        const currentMax = numberOf(model, 'maxTokens');
        const hasEfforts = Array.isArray(model.reasoningEfforts);
        const takeContext =
          nextContext !== undefined && (overwrite || currentContext === undefined);
        const takeMax = nextMax !== undefined && (overwrite || currentMax === undefined);
        const takeEfforts =
          nextEfforts !== undefined && nextEfforts.length > 0 && (overwrite || !hasEfforts);
        if (!takeContext && !takeMax && !takeEfforts) return model;
        touched += 1;
        return {
          ...model,
          ...(takeContext ? { contextWindow: nextContext } : {}),
          ...(takeMax ? { maxTokens: nextMax } : {}),
          ...(takeEfforts ? { reasoningEfforts: nextEfforts } : {}),
        };
      });
      commit(next, editing);
      setParams(undefined);
      setParamChoices(new Map());
      setNotice(`${t('paramsApplied')} (${String(touched)})`);
    };

    return (
      <section className="uniterra-catalog" aria-label={t('models')}>
        <div className="uniterra-catalog-head">
          <span className="uniterra-catalog-title">{t('models')}</span>
          <div className="uniterra-catalog-actions" style={{ display: 'flex', gap: 4 }}>
            <button
              type="button"
              className="uniterra-linkbutton"
              disabled={busy}
              onClick={() => {
                void fetchModels();
              }}
            >
              {busy ? t('fetching') : t('fetchModels')}
            </button>
            <button
              type="button"
              className="uniterra-linkbutton"
              disabled={paramsBusy}
              onClick={() => {
                void updateParams();
              }}
            >
              {paramsBusy ? t('paramsFetching') : t('updateParams')}
            </button>
            <button
              type="button"
              className="uniterra-linkbutton"
              disabled={busy || models.length === 0}
              onClick={() => {
                commit([], new Map());
                setExpanded(new Set());
                setParams(undefined);
                setParamChoices(new Map());
              }}
            >
              {t('clearModels')}
            </button>
          </div>
        </div>
        {notice === undefined ? null : <p role="status">{notice}</p>}
        {errorText === undefined ? null : <p className="uniterra-error">{errorText}</p>}
        {problemText === undefined ? null : <p className="uniterra-error">{problemText}</p>}
        {models.length === 0 ? <p className="uniterra-empty">{t('modelsEmpty')}</p> : null}
        {models.map((model, index) => (
          <div key={index} className="uniterra-entry">
            <div className="uniterra-modelrow">
              <input
                className="uniterra-input"
                type="text"
                value={textOf(model, 'id')}
                placeholder={t('modelId')}
                aria-label={`${t('modelId')} ${String(index + 1)}`}
                onChange={(event) => {
                  patch(index, { id: event.target.value });
                }}
              />
              <input
                className="uniterra-input"
                type="text"
                value={textOf(model, 'name')}
                placeholder={t('modelName')}
                aria-label={`${t('modelName')} ${String(index + 1)}`}
                onChange={(event) => {
                  patch(index, {
                    name: event.target.value === '' ? undefined : event.target.value,
                  });
                }}
              />
              <button
                type="button"
                className="uniterra-iconbutton"
                aria-label={`${t('modelAdvanced')} ${String(index + 1)}`}
                aria-expanded={expanded.has(index)}
                title={t('modelAdvanced')}
                onClick={() => {
                  toggleExpanded(index);
                }}
              >
                <IconChevron open={expanded.has(index)} />
              </button>
              <button
                type="button"
                className="uniterra-iconbutton uniterra-iconbutton--danger"
                aria-label={`${t('removeModel')} ${String(index + 1)}`}
                title={t('removeModel')}
                onClick={() => {
                  removeModel(index);
                }}
              >
                <IconTrash />
              </button>
            </div>
            {expanded.has(index) ? (
              <div className="uniterra-modeladvanced">
                <label className="uniterra-modelfield">
                  <span className="uniterra-modelfield-label">{t('contextWindow')}</span>
                  <input
                    className="uniterra-input"
                    type="text"
                    inputMode="numeric"
                    value={capacityText(model, index, 'contextWindow')}
                    placeholder={CAPACITY_HINT.contextWindow}
                    aria-label={`${t('contextWindow')} ${String(index + 1)}`}
                    onChange={(event) => {
                      editCapacity(index, 'contextWindow', event.target.value);
                    }}
                  />
                </label>
                <label className="uniterra-modelfield">
                  <span className="uniterra-modelfield-label">{t('maxTokens')}</span>
                  <input
                    className="uniterra-input"
                    type="text"
                    inputMode="numeric"
                    value={capacityText(model, index, 'maxTokens')}
                    placeholder={CAPACITY_HINT.maxTokens}
                    aria-label={`${t('maxTokens')} ${String(index + 1)}`}
                    onChange={(event) => {
                      editCapacity(index, 'maxTokens', event.target.value);
                    }}
                  />
                </label>
                <label className="uniterra-modelfield">
                  <span className="uniterra-modelfield-label">{t('modelApi')}</span>
                  <select
                    className="uniterra-select"
                    aria-label={`${t('modelApi')} ${String(index + 1)}`}
                    value={
                      model.api === 'chat-completions' || model.api === 'responses' ? model.api : ''
                    }
                    onChange={(event) => {
                      const value = event.target.value;
                      patch(index, {
                        api:
                          value === ''
                            ? undefined
                            : value === 'responses'
                              ? 'responses'
                              : 'chat-completions',
                      });
                    }}
                  >
                    <option value="">{t('modelApiUseDefault')}</option>
                    <option value="chat-completions">{t('apiChatCompletions')}</option>
                    <option value="responses">{t('apiResponses')}</option>
                  </select>
                </label>
                {Array.isArray(model.reasoningEfforts) &&
                model.reasoningEfforts.every(
                  (effort): effort is string => typeof effort === 'string',
                ) &&
                model.reasoningEfforts.length > 0 ? (
                  <label className="uniterra-modelfield">
                    <span className="uniterra-modelfield-label">{t('modelReasoning')}</span>
                    <select
                      className="uniterra-select"
                      aria-label={`${t('defaultEffort')} ${String(index + 1)}`}
                      value={
                        typeof model.defaultReasoningEffort === 'string' &&
                        model.reasoningEfforts.includes(model.defaultReasoningEffort)
                          ? model.defaultReasoningEffort
                          : highestOf(model.reasoningEfforts)
                      }
                      onChange={(event) => {
                        patch(index, { defaultReasoningEffort: event.target.value });
                      }}
                    >
                      {model.reasoningEfforts.map((effort) => (
                        <option key={effort} value={effort}>
                          {effort}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : null}
              </div>
            ) : null}
          </div>
        ))}
        <button
          type="button"
          className="uniterra-addmodel"
          disabled={busy}
          onClick={() => {
            commit([...models, { id: '' }], editing);
          }}
        >
          {t('addModel')}
        </button>

        {candidates === undefined ? null : (
          <div className="uniterra-candidates">
            <strong>{t('fetchTitle')}</strong>
            <ul>
              {candidates.map((model) => (
                <li key={model.id}>
                  <label>
                    <input
                      type="checkbox"
                      checked={picked.has(model.id)}
                      onChange={() => {
                        toggle(model.id);
                      }}
                    />{' '}
                    {model.id}
                    {model.name === undefined || model.name === model.id ? '' : ` (${model.name})`}
                  </label>
                </li>
              ))}
            </ul>
            <button
              type="button"
              className="uniterra-button uniterra-button--primary"
              disabled={picked.size === 0}
              onClick={adopt}
            >
              {t('fetchAdopt')}
            </button>{' '}
            <button
              type="button"
              className="uniterra-button"
              onClick={() => {
                setCandidates(undefined);
                setPicked(new Set());
              }}
            >
              {t('fetchCancel')}
            </button>
          </div>
        )}

        {params === undefined ? null : (
          <div className="uniterra-params" ref={paramsRef}>
            <strong>{t('paramsTitle')}</strong>
            <p className="uniterra-params-summary">
              {t('paramsSummary')
                .replace(
                  '{matched}',
                  String(params.models.filter((entry) => entry.matches.length > 0).length),
                )
                .replace(
                  '{unmatched}',
                  String(params.models.filter((entry) => entry.matches.length === 0).length),
                )}
            </p>
            {params.models.map((entry) => {
              if (entry.matches.length === 0) {
                return (
                  <div key={entry.id} className="uniterra-params-row">
                    <span className="uniterra-params-id">{entry.id}</span>
                    <span className="uniterra-params-unmatched">{t('paramsUnmatched')}</span>
                    <span />
                  </div>
                );
              }
              if (entry.matches.length === 1) {
                const match = entry.matches[0];
                if (match === undefined) return null;
                return (
                  <div key={entry.id} className="uniterra-params-row">
                    <span className="uniterra-params-id">{entry.id}</span>
                    <span className="uniterra-params-values">
                      {`${match.official === true ? `${t('officialMark')} · ` : ''}${match.provider} · ${t('contextWindow')} ${String(match.contextWindow ?? '—')} / ${t('maxTokens')} ${String(match.maxTokens ?? '—')}${match.reasoningEfforts !== undefined && match.reasoningEfforts.length > 0 ? ` · ${t('modelReasoning')}: ${match.reasoningEfforts.join('/')}` : ''}`}
                    </span>
                    <span />
                  </div>
                );
              }
              const chosen = paramChoices.get(entry.id) ?? 0;
              const match = entry.matches[chosen] ?? entry.matches[0];
              if (match === undefined) return null;
              return (
                <div key={entry.id} className="uniterra-params-row">
                  <span className="uniterra-params-id">{entry.id}</span>
                  <select
                    className="uniterra-select"
                    aria-label={`${t('paramsProvider')} ${entry.id}`}
                    value={String(chosen)}
                    onChange={(event) => {
                      setParamChoices((current) =>
                        new Map(current).set(entry.id, Number(event.target.value)),
                      );
                    }}
                  >
                    {entry.matches.map((candidate, at) => (
                      <option key={candidate.provider} value={String(at)}>
                        {`${candidate.official === true ? `${t('officialMark')} · ` : ''}${candidate.provider}: ${t('contextWindow')} ${String(candidate.contextWindow ?? '—')} / ${t('maxTokens')} ${String(candidate.maxTokens ?? '—')}${candidate.reasoningEfforts !== undefined && candidate.reasoningEfforts.length > 0 ? ` · ${t('modelReasoning')}: ${candidate.reasoningEfforts.join('/')}` : ''}`}
                      </option>
                    ))}
                  </select>
                  <span className="uniterra-params-values">{match.provider}</span>
                </div>
              );
            })}
            <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
              <button
                type="button"
                className="uniterra-button uniterra-button--primary"
                onClick={() => {
                  applyParams(true);
                }}
              >
                {t('paramsOverwrite')}
              </button>
              <button
                type="button"
                className="uniterra-button"
                onClick={() => {
                  applyParams(false);
                }}
              >
                {t('paramsFillBlank')}
              </button>
              <button
                type="button"
                className="uniterra-button"
                onClick={() => {
                  setParams(undefined);
                  setParamChoices(new Map());
                }}
              >
                {t('fetchCancel')}
              </button>
            </div>
          </div>
        )}

        <p className="uniterra-hint">{t('modelHint')}</p>
      </section>
    );
  }
}
