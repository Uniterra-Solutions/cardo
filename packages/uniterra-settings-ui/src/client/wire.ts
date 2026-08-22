/**
 * Client-side wire types shared by the Integrations page components: the
 * '/settings-ui' bridge describe() descriptor and the RPC call signature the
 * apply closure injects. Types only — no runtime code, so the browser bundle
 * carries nothing from the host half.
 */
/** One namespace as served over the '/settings-ui' describe channel. */
export interface WireDescriptor {
  ns: string;
  /** Serialized schemastery schema (`schema.toJSON()` envelope). */
  schemaJson: unknown;
  /** Resolved value with secret slots blanked to '' (write-only controls). */
  value: unknown;
  revision: number;
  applies: 'live' | 'restart';
  /** Dotted paths of the blanked secret slots, e.g. 'apiKey'. */
  secrets?: readonly string[];
}

/** Result shape of one '/settings-ui' bridge call (the transport RpcResult, widened). */
export type BridgeResultLike =
  | { ok: true; value: unknown }
  | { ok: false; error: { code: string; message: string; details?: unknown } };

/** One '/settings-ui' bridge call (endpoint + payload over the RPC channel). */
export type BridgeCall = (endpoint: string, payload: unknown) => Promise<BridgeResultLike>;
