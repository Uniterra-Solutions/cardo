/**
 * Host-side bridge over the settings seam (thin passthrough; issue #2,
 * FR-2.2/FR-2.4/FR-2.7). The browser half talks ONLY to this channel — never
 * to `connection.api.settings`, whose allowlist would hide e.g. dsh-memory's
 * `memory` namespace. The bridge hands every describe() through with
 * redaction forced on (the host seam owns redaction), forwards
 * update/replace/mutate with the caller's expectedRevision so the seam's own
 * revision guard fires (SETTINGS_CONFLICT passes through with its code and
 * revision facts), and exposes the document affordance (hasDocument /
 * openDocument → prepareDocument) for the FR-2.7 notice action. Validation
 * lives in the seam; the bridge never re-validates.
 */
import { SettingsConflictError } from '@deepseek-ai/dsh-settings';
import type { ExtensionEntry } from './discovery.ts';

/** One schema-declared secret position inside a redacted value. */
export interface SeamSecret {
  /** Path from the section root to the removed field. */
  path: readonly string[];
  /** Whether the field held a value before redaction. */
  set: boolean;
}

/** Minimal structural view of one seam descriptor (duck-typed from ctx.settings). */
export interface SeamSettingsDescriptor {
  ns: string;
  schema: unknown;
  value: unknown;
  revision: number;
  applies: 'live' | 'restart';
  base?: unknown;
  user?: unknown;
  secrets?: readonly SeamSecret[];
}

/** One namespace as served over the '/settings-ui' channel. */
export interface SettingsWireDescriptor {
  ns: string;
  /** Serialized schemastery schema (`schema.toJSON()` envelope). */
  schemaJson: unknown;
  /**
   * Resolved value with every schema-declared secret slot blanked to '' — the
   * caller never receives the secret itself, and a write-only control still
   * has a slot to render.
   */
  value: unknown;
  revision: number;
  applies: 'live' | 'restart';
  base?: unknown;
  user?: unknown;
  /** Dotted paths of the blanked secret slots, e.g. 'apiKey' or 'proxy.key'. */
  secrets?: readonly string[];
}

/** Duck-typed view of the host's `ctx.settings` seam. */
export interface SettingsLike {
  describe(options?: { redactSecrets?: boolean }): readonly SeamSettingsDescriptor[];
  update(ns: string, patch: object, expectedRevision?: number): Promise<void>;
  replace(ns: string, section: object, expectedRevision?: number): Promise<void>;
  mutate(ns: string, ops: readonly unknown[], expectedRevision?: number): Promise<void>;
  readonly documentPath: string | undefined;
  prepareDocument(): Promise<string | undefined>;
}

export type BridgeResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: { code: string; message: string; details?: unknown } };

export interface SettingsBridge {
  handle(endpoint: string, payload: unknown, signal?: AbortSignal): Promise<BridgeResult<unknown>>;
}

/** Common write payload shape: the namespace plus the caller's read revision. */
interface WritePayload {
  ns: string;
  expectedRevision?: number;
}

interface UpdatePayload extends WritePayload {
  patch: object;
}

interface ReplacePayload extends WritePayload {
  section: object;
}

interface MutatePayload extends WritePayload {
  ops: readonly unknown[];
}

/**
 * Create the bridge over a settings seam.
 * @param settings - the host's `ctx.settings` (duck-typed).
 * @param inventory - optional host-side extension enumeration for the
 *   `inventory` endpoint (ctx.registry.forEach); absent → empty inventory.
 */
export function createSettingsBridge(
  settings: SettingsLike,
  inventory?: () => readonly ExtensionEntry[],
): SettingsBridge {
  return {
    async handle(
      endpoint: string,
      payload: unknown,
      _signal?: AbortSignal,
    ): Promise<BridgeResult<unknown>> {
      switch (endpoint) {
        case 'describe': {
          try {
            // Redaction is forced on the wire: the caller may ask for the
            // verbatim seam default, never for secrets.
            const descriptors = settings.describe({ redactSecrets: true }).map(toWire);
            return { ok: true as const, value: descriptors };
          } catch (error) {
            return settingsFailure(error);
          }
        }
        case 'update': {
          const body = payload as UpdatePayload;
          try {
            await settings.update(body.ns, body.patch, body.expectedRevision);
            return { ok: true as const, value: undefined };
          } catch (error) {
            return writeFailure(error);
          }
        }
        case 'replace': {
          const body = payload as ReplacePayload;
          try {
            await settings.replace(body.ns, body.section, body.expectedRevision);
            return { ok: true as const, value: undefined };
          } catch (error) {
            return writeFailure(error);
          }
        }
        case 'mutate': {
          const body = payload as MutatePayload;
          try {
            await settings.mutate(body.ns, body.ops, body.expectedRevision);
            return { ok: true as const, value: undefined };
          } catch (error) {
            return writeFailure(error);
          }
        }
        case 'hasDocument': {
          try {
            return { ok: true as const, value: settings.documentPath !== undefined };
          } catch (error) {
            return settingsFailure(error);
          }
        }
        case 'openDocument': {
          try {
            const path = await settings.prepareDocument();
            return { ok: true as const, value: path };
          } catch (error) {
            return settingsFailure(error);
          }
        }
        case 'inventory': {
          return { ok: true as const, value: inventory !== undefined ? inventory() : [] };
        }
        default:
          return {
            ok: false as const,
            error: {
              code: 'unknown-endpoint',
              message: `settings-ui: unknown endpoint ${endpoint}`,
              details: {},
            },
          };
      }
    },
  };
}

/** Map a seam descriptor onto the wire shape (schema → schemaJson). */
function toWire(descriptor: SeamSettingsDescriptor): SettingsWireDescriptor {
  const wire: SettingsWireDescriptor = {
    ns: descriptor.ns,
    schemaJson: toJsonSafe(descriptor.schema),
    value: blankSecrets(descriptor.value, descriptor.secrets),
    revision: descriptor.revision,
    applies: descriptor.applies,
  };
  if (descriptor.base !== undefined) wire.base = descriptor.base;
  if (descriptor.user !== undefined) wire.user = descriptor.user;
  if (descriptor.secrets !== undefined) {
    wire.secrets = descriptor.secrets.map((secret) => secret.path.join('.'));
  }
  return wire;
}

/**
 * Deep-clone making the envelope JSON-safe regardless of transport: schemastery
 * carries `meta.pattern` as a RegExp object, which any JSON serialization
 * would flatten to `{}` — the client's HTML pattern constraint (FR-2.3) would
 * silently vanish. Convert RegExp → its source string so the wire is
 * deterministic.
 */
function toJsonSafe(value: unknown): unknown {
  if (value instanceof RegExp) return value.source;
  if (Array.isArray(value)) return value.map(toJsonSafe);
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      out[key] = toJsonSafe((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/**
 * Blank every schema-declared secret slot in a detached copy of the value
 * (the seam's redacted value REMOVES the fields; the wire keeps the slots so
 * a write-only control renders an empty input). The seam's resolved value is
 * deep-frozen, so this clones before mutating.
 */
function blankSecrets(value: unknown, secrets: readonly SeamSecret[] | undefined): unknown {
  if (secrets === undefined || secrets.length === 0) return value;
  const clone = structuredClone(value);
  for (const secret of secrets) setBlank(clone, secret.path);
  return clone;
}

/** Walk one secret path and set its leaf slot to the blank string. */
function setBlank(root: unknown, path: readonly string[]): void {
  let current =
    typeof root === 'object' && root !== null && !Array.isArray(root)
      ? (root as Record<string, unknown>)
      : undefined;
  for (let index = 0; index < path.length - 1; index++) {
    if (current === undefined) return;
    const next = current[path[index] as string];
    if (typeof next !== 'object' || next === null || Array.isArray(next)) return;
    current = next as Record<string, unknown>;
  }
  const leaf = path[path.length - 1];
  if (current !== undefined && leaf !== undefined) current[leaf] = '';
}

/** A write refused by the seam's own validation or storage. */
function writeFailure(error: unknown): {
  ok: false;
  error: { code: string; message: string; details: unknown };
} {
  if (error instanceof SettingsConflictError) {
    return {
      ok: false as const,
      error: {
        code: 'SETTINGS_CONFLICT',
        message: error.message,
        details: { expected: error.expected, actual: error.actual },
      },
    };
  }
  return settingsFailure(error);
}

/** Any other seam failure: mapped to the bridge's generic error code. */
function settingsFailure(error: unknown): {
  ok: false;
  error: { code: string; message: string; details: unknown };
} {
  return {
    ok: false as const,
    error: {
      code: 'settings-error',
      message: error instanceof Error ? error.message : String(error),
      details: {},
    },
  };
}
