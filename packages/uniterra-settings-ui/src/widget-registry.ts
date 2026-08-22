/**
 * Client-side widget registry (pure; the React components it holds are
 * opaque here). Feature plugins register bespoke controls for a namespace
 * field — the provider registers the model catalog, the write-only API-key
 * virtual widget, and the models.dev params panel (issue #2, FR-2.5).
 * Registration and override resolution:
 *  - register(ns, fieldPath, widget) — exact (ns, fieldPath) key; the last
 *    registration for a key wins (feature plugin owns the latest intent).
 *  - resolve(ns, fieldPath) — exact match wins, then the longest ancestor
 *    prefix (dot-separated), then undefined (generic control fallback).
 *  - a nested plain object with no widget registered (e.g. proxy) resolves
 *    to undefined and renders as the generic object editor — the registry
 *    never invents widgets.
 */
export interface SettingsWidget {
  /** Stable identity, e.g. 'model-catalog'. */
  id: string;
  /** React component — opaque to the host half and to tests. */
  component: unknown;
}

export interface SettingsWidgetRegistry {
  register(ns: string, fieldPath: string, widget: SettingsWidget): void;
  /** Most specific registered widget: exact path, then longest ancestor prefix. */
  resolve(ns: string, fieldPath: string): SettingsWidget | undefined;
  /** Every registration for one namespace, in registration order. */
  list(ns: string): readonly { fieldPath: string; widget: SettingsWidget }[];
}

export function createSettingsWidgetRegistry(): SettingsWidgetRegistry {
  const byNamespace = new Map<string, Map<string, SettingsWidget>>();
  return {
    register(ns: string, fieldPath: string, widget: SettingsWidget): void {
      let fields = byNamespace.get(ns);
      if (fields === undefined) {
        fields = new Map();
        byNamespace.set(ns, fields);
      }
      // Last registration for a key wins; Map keeps the first position so
      // list() preserves registration order.
      fields.set(fieldPath, widget);
    },
    resolve(ns: string, fieldPath: string): SettingsWidget | undefined {
      const fields = byNamespace.get(ns);
      if (fields === undefined) return undefined;
      const exact = fields.get(fieldPath);
      if (exact !== undefined) return exact;
      // Longest dot-prefix ancestor, then its ancestor, and so on.
      let index = fieldPath.lastIndexOf('.');
      while (index !== -1) {
        const prefix = fieldPath.slice(0, index);
        const hit = fields.get(prefix);
        if (hit !== undefined) return hit;
        index = prefix.lastIndexOf('.');
      }
      return undefined;
    },
    list(ns: string): readonly { fieldPath: string; widget: SettingsWidget }[] {
      const fields = byNamespace.get(ns);
      if (fields === undefined) return [];
      const entries: { fieldPath: string; widget: SettingsWidget }[] = [];
      for (const [fieldPath, widget] of fields) entries.push({ fieldPath, widget });
      return entries;
    },
  };
}
