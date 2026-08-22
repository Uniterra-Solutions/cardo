/**
 * Generic schema-driven settings form (issue #2, FR-2.3/FR-2.5). One
 * namespace's wire descriptor renders through toFieldTree; each field maps to
 * a control, a registered widget overrides the generic control for its
 * fieldPath (the widget registry is consulted at every node, exact path then
 * longest ancestor prefix), and writes cross the '/settings-ui' bridge with
 * the caller's read revision so the seam's own guard fires on staleness.
 * Arrays and free-form dicts (empty-child records) edit as JSON; everything
 * else gets a native control. The form never reads connection.api.settings.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ComponentType, ReactNode } from 'react';
import { collectFieldPaths, toFieldTree } from '../field-tree.ts';
import type { FieldNode } from '../field-tree.ts';
import type { SettingsWidget, SettingsWidgetRegistry } from '../widget-registry.ts';
import type { BridgeCall, WireDescriptor } from './wire.ts';
import type { LocaleKey } from './locale.ts';

/** The widget contract the generic form hands registered widgets (FR-2.5). */
export interface SettingsWidgetProps {
  ns: string;
  fieldPath: string;
  /** The field's current draft value. */
  value: unknown;
  /** Replace the field's draft value. */
  onChange: (value: unknown) => void;
  t: (key: LocaleKey, params?: Record<string, unknown>) => string;
  call: BridgeCall;
}

export interface GenericFormProps {
  /** Registered settings namespace. */
  ns: string;
  descriptor: WireDescriptor;
  t: (key: LocaleKey, params?: Record<string, unknown>) => string;
  widgets: SettingsWidgetRegistry;
  call: BridgeCall;
}

/** One node's editable slot inside the full namespace draft. */
interface FieldControlProps {
  node: FieldNode;
  ns: string;
  /** The full namespace draft; nodes address it by absolute fieldPath. */
  root: unknown;
  onChangeAt: (fieldPath: string, value: unknown) => void;
  t: (key: LocaleKey, params?: Record<string, unknown>) => string;
  widgets: SettingsWidgetRegistry;
  call: BridgeCall;
}

export function GenericForm(props: GenericFormProps): ReactNode {
  const { ns, descriptor, t, widgets, call } = props;
  const [draft, setDraft] = useState<unknown>(descriptor.value);
  const [revision, setRevision] = useState<number>(descriptor.revision);
  const [saving, setSaving] = useState<boolean>(false);
  const [saved, setSaved] = useState<boolean>(false);
  const [saveError, setSaveError] = useState<string | undefined>(undefined);

  // Re-sync the draft when the descriptor moves (external refresh).
  useEffect(() => {
    setDraft(descriptor.value);
    setRevision(descriptor.revision);
    setSaveError(undefined);
  }, [descriptor]);

  const tree = useMemo(() => toFieldTree(descriptor.schemaJson, descriptor.value), [descriptor]);

  // Registered widgets whose fieldPath is NOT a schema field render as
  // namespace-level panels (FR-2.5): the write-only API-key virtual widget,
  // for example, is not a schema field — it persists through the credentials
  // seam instead (PRD FR-2.4).
  const virtualWidgets = useMemo(() => {
    const nodePaths = collectFieldPaths(tree);
    return widgets.list(ns).filter((entry) => !nodePaths.has(entry.fieldPath));
  }, [tree, widgets, ns]);

  /** Re-read the namespace through the bridge (fresh value + revision). */
  const refresh = useCallback(async (): Promise<void> => {
    const result = await call('describe', {});
    if (!result.ok) return;
    const list = (result.value ?? []) as readonly WireDescriptor[];
    const next = list.find((entry) => entry.ns === ns);
    if (next !== undefined) {
      setDraft(next.value);
      setRevision(next.revision);
    }
  }, [call, ns]);

  const save = useCallback((): void => {
    setSaving(true);
    setSaveError(undefined);
    setSaved(false);
    void (async (): Promise<void> => {
      try {
        const result = await call('update', {
          ns,
          patch: draft,
          expectedRevision: revision,
        });
        if (result.ok) {
          setSaved(true);
          await refresh();
        } else if (result.error.code === 'SETTINGS_CONFLICT') {
          setSaveError(t('conflict'));
          await refresh();
        } else {
          setSaveError(t('saveFailed', { message: result.error.message }));
        }
      } catch {
        setSaveError(t('saveFailed', { message: '' }));
      } finally {
        setSaving(false);
      }
    })();
  }, [call, ns, draft, revision, refresh, t]);

  const onChangeAt = useCallback((fieldPath: string, value: unknown): void => {
    setDraft((current: unknown) => setAt(current, fieldPath, value));
  }, []);

  return (
    <div className="settings-ui-namespace">
      <h3 className="settings-ui-ns-title">{ns}</h3>
      {tree.map((node) => (
        <FieldControl
          key={node.fieldPath}
          node={node}
          ns={ns}
          root={draft}
          onChangeAt={onChangeAt}
          t={t}
          widgets={widgets}
          call={call}
        />
      ))}
      {virtualWidgets.map((entry) => (
        <div key={entry.fieldPath} className="settings-ui-virtual">
          <WidgetSlot
            widget={entry.widget}
            ns={ns}
            fieldPath={entry.fieldPath}
            value={getAt(draft, entry.fieldPath)}
            onChange={(next) => {
              onChangeAt(entry.fieldPath, next);
            }}
            t={t}
            call={call}
          />
        </div>
      ))}
      <div className="settings-ui-actions">
        <button
          type="button"
          className="settings-ui-button settings-ui-button--primary"
          onClick={save}
          disabled={saving}
        >
          {saving ? t('saving') : t('save')}
        </button>
        {saved && <span className="settings-ui-hint">{t('saved')}</span>}
        {saveError !== undefined && <span className="settings-ui-error">{saveError}</span>}
      </div>
    </div>
  );
}

/** One field: the registered widget when present, else the schema control. */
function FieldControl(props: FieldControlProps): ReactNode {
  const { node, ns, root, onChangeAt, t, widgets, call } = props;
  const widget = widgets.resolve(ns, node.fieldPath);
  if (widget !== undefined) {
    return (
      <WidgetSlot
        widget={widget}
        ns={ns}
        fieldPath={node.fieldPath}
        value={getAt(root, node.fieldPath)}
        onChange={(next) => {
          onChangeAt(node.fieldPath, next);
        }}
        t={t}
        call={call}
      />
    );
  }
  const label = node.description ?? node.label;
  const requiredMark = node.required === true ? ` ${t('required')}` : '';
  switch (node.type) {
    case 'text':
      return (
        <label className="settings-ui-field">
          <span className="settings-ui-field-label">
            {label}
            {requiredMark}
          </span>
          <input
            className="settings-ui-input"
            type={node.secret === true ? 'password' : 'text'}
            value={textOf(getAt(root, node.fieldPath))}
            pattern={node.pattern}
            placeholder={node.secret === true ? t('secretPlaceholder') : undefined}
            onChange={(event) => {
              onChangeAt(node.fieldPath, event.target.value);
            }}
          />
        </label>
      );
    case 'number':
      return (
        <label className="settings-ui-field">
          <span className="settings-ui-field-label">
            {label}
            {requiredMark}
          </span>
          <input
            className="settings-ui-input"
            type="number"
            value={numberTextOf(getAt(root, node.fieldPath))}
            min={node.min}
            max={node.max}
            step={node.step}
            onChange={(event) => {
              const next = event.target.valueAsNumber;
              onChangeAt(node.fieldPath, Number.isNaN(next) ? undefined : next);
            }}
          />
        </label>
      );
    case 'boolean':
      return (
        <label className="settings-ui-field">
          <span className="settings-ui-field-label">
            {label}
            {requiredMark}
          </span>
          <input
            type="checkbox"
            checked={getAt(root, node.fieldPath) === true}
            onChange={(event) => {
              onChangeAt(node.fieldPath, event.target.checked);
            }}
          />
        </label>
      );
    case 'select': {
      const choices = node.choices ?? [];
      const discriminator = node.discriminator;
      if (discriminator === undefined) {
        return (
          <label className="settings-ui-field">
            <span className="settings-ui-field-label">
              {label}
              {requiredMark}
            </span>
            <select
              className="settings-ui-select"
              value={textOf(getAt(root, node.fieldPath))}
              onChange={(event) => {
                onChangeAt(node.fieldPath, event.target.value);
              }}
            >
              {choices.map((choice) => (
                <option key={choice} value={choice}>
                  {choice}
                </option>
              ))}
            </select>
          </label>
        );
      }
      const current = variantOf(getAt(root, node.fieldPath), discriminator);
      const activeSubtree = node.children?.find((child) => child.label === current);
      return (
        <div className="settings-ui-field">
          <span className="settings-ui-field-label">
            {label}
            {requiredMark}
          </span>
          <select
            className="settings-ui-select"
            value={current}
            onChange={(event) => {
              onChangeAt(node.fieldPath, { [discriminator]: event.target.value });
            }}
          >
            {choices.map((choice) => (
              <option key={choice} value={choice}>
                {choice}
              </option>
            ))}
          </select>
          {activeSubtree?.children?.map((child) => (
            <FieldControl
              key={child.fieldPath}
              node={child}
              ns={ns}
              root={root}
              onChangeAt={onChangeAt}
              t={t}
              widgets={widgets}
              call={call}
            />
          ))}
        </div>
      );
    }
    case 'object': {
      const children = node.children ?? [];
      return (
        <fieldset className="settings-ui-fieldset">
          <legend className="settings-ui-field-label">
            {label}
            {requiredMark}
          </legend>
          {children.map((child) => (
            <FieldControl
              key={child.fieldPath}
              node={child}
              ns={ns}
              root={root}
              onChangeAt={onChangeAt}
              t={t}
              widgets={widgets}
              call={call}
            />
          ))}
        </fieldset>
      );
    }
    case 'array':
    case 'dict': {
      const hint = node.type === 'array' ? t('arrayHint') : t('dictHint');
      return (
        <label className="settings-ui-field">
          <span className="settings-ui-field-label">
            {label}
            {requiredMark}
            {' · '}
            {hint}
          </span>
          <textarea
            className="settings-ui-input settings-ui-textarea"
            rows={4}
            value={jsonTextOf(getAt(root, node.fieldPath), node.type)}
            onChange={(event) => {
              // Invalid JSON keeps the previous draft; the seam validates the
              // stored document on save regardless.
              try {
                onChangeAt(node.fieldPath, JSON.parse(event.target.value) as unknown);
              } catch {
                // leave the draft untouched
              }
            }}
          />
        </label>
      );
    }
    case 'readonly':
      return (
        <div className="settings-ui-field">
          <span className="settings-ui-field-label">
            {label}
            {' · '}
            {t('readonly')}
          </span>
          <p className="settings-ui-readonly">{readonlyTextOf(getAt(root, node.fieldPath))}</p>
        </div>
      );
  }
}

/** Render one registered widget with the generic form's face (FR-2.5). */
function WidgetSlot(props: {
  widget: SettingsWidget;
  ns: string;
  fieldPath: string;
  value: unknown;
  onChange: (value: unknown) => void;
  t: (key: LocaleKey, params?: Record<string, unknown>) => string;
  call: BridgeCall;
}): ReactNode {
  const { widget, ns, fieldPath, value, onChange, t, call } = props;
  const Component = widget.component as ComponentType<SettingsWidgetProps>;
  return (
    <Component ns={ns} fieldPath={fieldPath} value={value} onChange={onChange} t={t} call={call} />
  );
}

/** Read one dot-path segment chain from a draft root. */
function getAt(root: unknown, path: string): unknown {
  let current: unknown = root;
  for (const segment of path.split('.')) {
    if (typeof current !== 'object' || current === null || Array.isArray(current)) {
      return undefined;
    }
    if (!(segment in current)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/** Produce a new draft with one dot-path set (intermediate objects created). */
function setAt(root: unknown, path: string, value: unknown): unknown {
  const segments = path.split('.');
  const first = segments[0] as string;
  const source = asRecord(root);
  if (segments.length === 1) return { ...source, [first]: value };
  return { ...source, [first]: setAt(source[first], segments.slice(1).join('.'), value) };
}

/** A plain-object view of a value, for path traversal. */
function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** The active variant of a discriminated union value. */
function variantOf(value: unknown, discriminator: string): string {
  if (typeof value !== 'object' || value === null) return '';
  const current = (value as Record<string, unknown>)[discriminator];
  return typeof current === 'string' ? current : '';
}

/** A string control's editable text. */
function textOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** A number control's editable text. */
function numberTextOf(value: unknown): string {
  return typeof value === 'number' ? String(value) : '';
}

/** JSON text for array/dict editors. */
function jsonTextOf(value: unknown, type: 'array' | 'dict'): string {
  if (value === undefined) return type === 'array' ? '[]' : '{}';
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return type === 'array' ? '[]' : '{}';
  }
}

/** Display text for a readonly node. */
function readonlyTextOf(value: unknown): string {
  if (value === undefined) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    if (value === null) return 'null';
    switch (typeof value) {
      case 'bigint':
      case 'symbol':
        return value.toString();
      case 'number':
      case 'boolean':
        return String(value);
      case 'string':
        return value;
      case 'undefined':
        return '';
      case 'object':
      case 'function':
        return '<unserializable>';
    }
  }
}
