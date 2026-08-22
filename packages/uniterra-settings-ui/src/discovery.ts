/**
 * Extension discovery split (pure; issue #2, FR-2.2 + FR-2.7). The settings
 * page lists the installed extensions; an extension that exposes at least one
 * schema-configurable settings namespace renders its namespaces generically,
 * one that exposes none gets a read-only notice (no schema-configurable
 * settings) plus an optional open-profile-settings-document action.
 *
 * Ownership rule: an extension owns the namespaces its `ownerMap` entry
 * declares; absent an entry, the identity convention (ns === extension id)
 * applies — the provider registers `llm-uniterra` under its own id, and
 * curated entries cover built-ins whose namespace differs from their id
 * (dsh-memory registers ns `memory` under id `dsh-memory`).
 */
export interface ExtensionEntry {
  /** Cordis plugin id, e.g. 'dsh-memory'. */
  id: string;
  /** Human name, e.g. the package short name. */
  name: string;
}

export interface NamespaceDescriptor {
  /** Registered settings namespace. */
  ns: string;
  /** Serialized schema (`schema.toJSON()` envelope). */
  schemaJson: unknown;
}

export interface DiscoverySplit {
  /** Extensions exposing at least one descriptor-backed namespace. */
  withSettings: { extension: ExtensionEntry; namespaces: NamespaceDescriptor[] }[];
  /** Extensions exposing none → FR-2.7 read-only notice list. */
  withoutSettings: ExtensionEntry[];
}

/**
 * Split the extension inventory by whether any descriptor belongs to it.
 * @param ownerMap - extension id → namespaces it owns; identity is the fallback.
 */
export function selectNamespaces(
  inventory: readonly ExtensionEntry[],
  descriptors: readonly NamespaceDescriptor[],
  ownerMap?: Readonly<Record<string, readonly string[]>>,
): DiscoverySplit {
  const byNs = new Map<string, NamespaceDescriptor[]>();
  for (const descriptor of descriptors) {
    const matches = byNs.get(descriptor.ns) ?? [];
    matches.push(descriptor);
    byNs.set(descriptor.ns, matches);
  }
  const withSettings: { extension: ExtensionEntry; namespaces: NamespaceDescriptor[] }[] = [];
  const withoutSettings: ExtensionEntry[] = [];
  for (const extension of inventory) {
    const owned = ownerMap?.[extension.id] ?? [extension.id];
    const namespaces: NamespaceDescriptor[] = [];
    for (const ns of owned) {
      const matches = byNs.get(ns);
      if (matches !== undefined) namespaces.push(...matches);
    }
    if (namespaces.length > 0) {
      withSettings.push({ extension, namespaces });
    } else {
      withoutSettings.push(extension);
    }
  }
  return { withSettings, withoutSettings };
}
