/**
 * Schema → field-tree mapper (pure; no cordis, no React). Turns one
 * namespace's serialized schemastery schema — the `schema.toJSON()` ref
 * envelope carried by `settings.describe` — into the render tree the generic
 * form walks. Encoding rules (issue #2, FR-2.3):
 *  - string → text (pattern constraint carried; role 'secret' → write-only)
 *  - number → number (min/max/step carried)
 *  - boolean → boolean
 *  - union of consts → select (choices = const values)
 *  - union of objects with a const discriminator → variant select
 *  - object with fields → object (children = fields)
 *  - object with NO fields (empty-child record, e.g. providerHints.defaults)
 *    → dict (free-form key-value map editor)
 *  - array → array (children = [inner node])
 *  - dict (z.dict) → dict (children = [value node])
 *  - const alone → readonly (a fixed value)
 *  - anything unknown/unrepresentable → readonly — the form NEVER crashes on
 *    a schema it has not seen; it degrades to a read-only text control.
 */
export type FieldNodeType =
  'text' | 'number' | 'boolean' | 'select' | 'object' | 'array' | 'dict' | 'readonly';

/** One mapped control in the generic settings form. */
export interface FieldNode {
  /** Dot-path from the namespace root, e.g. `proxy.url`. */
  fieldPath: string;
  /** Field key (last path segment); the control label when no description is given. */
  label: string;
  type: FieldNodeType;
  /** Schema-declared presence constraint. */
  required?: boolean;
  /** Schema default; an untouched draft resolves through it. */
  default?: unknown;
  /** User-facing description from `meta.description`. */
  description?: string;
  /** `select` choices: union-of-const values, or variant discriminator values. */
  choices?: string[];
  /** `text` constraint from `meta.pattern` (regex source). */
  pattern?: string;
  /** `number` constraints. */
  min?: number;
  max?: number;
  step?: number;
  /** Schema-declared secret (`meta.role === 'secret'`): rendered write-only. */
  secret?: boolean;
  /** Container children: object fields, array inner, dict value schema. */
  children?: FieldNode[];
  /** Variant select: which child key carries the const discriminator. */
  discriminator?: string;
  /** Current resolved value (readonly nodes carry it for display). */
  value?: unknown;
}

/** One node of a serialized schemastery ref table (structural view of the envelope). */
interface SchemaRef {
  type?: unknown;
  meta?: Record<string, unknown>;
  dict?: Record<string, unknown>;
  list?: readonly unknown[];
  inner?: unknown;
  value?: unknown;
}

/**
 * Map one namespace's serialized schemastery schema to a render tree.
 * @param schemaJson - the `schema.toJSON()` envelope (`{ uid, refs, ... }`).
 * @param value - the namespace's current resolved value (for readonly display).
 * @returns the root field nodes, never throwing.
 */
export function toFieldTree(schemaJson: unknown, value: unknown): FieldNode[] {
  try {
    return rootFields(schemaJson, value);
  } catch {
    // The renderer never crashes on a schema it has not seen.
    return [];
  }
}

/**
 * Every fieldPath a render tree addresses (absolute dot paths, including
 * container children such as array items and dict values). The generic form
 * uses it to tell schema fields from namespace-level virtual widgets
 * (FR-2.5): a registered widget whose path is absent here renders as a
 * namespace-level panel instead of overriding a field control.
 */
export function collectFieldPaths(tree: readonly FieldNode[]): ReadonlySet<string> {
  const paths = new Set<string>();
  const walk = (nodes: readonly FieldNode[]): void => {
    for (const node of nodes) {
      paths.add(node.fieldPath);
      if (node.children !== undefined) walk(node.children);
    }
  };
  walk(tree);
  return paths;
}

/** The root schema's fields; a non-object or unresolvable root yields none. */
function rootFields(schemaJson: unknown, value: unknown): FieldNode[] {
  const root = refOf(schemaJson, uidOf(schemaJson));
  if (root === undefined) return [];
  const dict = objectRecord(root.dict);
  const nodes: FieldNode[] = [];
  for (const key of Object.keys(dict)) {
    const child = mapRef(schemaJson, refOf(schemaJson, dict[key]), key, key, segmentOf(value, key));
    if (child !== undefined) nodes.push(child);
  }
  return nodes;
}

/** The envelope's root uid, when the input looks like a toJSON envelope. */
function uidOf(schemaJson: unknown): unknown {
  return typeof schemaJson === 'object' && schemaJson !== null
    ? (schemaJson as { uid?: unknown }).uid
    : undefined;
}

/** Resolve one uid through the envelope's ref table. */
function refOf(schemaJson: unknown, uid: unknown): SchemaRef | undefined {
  if (typeof schemaJson !== 'object' || schemaJson === null) return undefined;
  const refs = (schemaJson as { refs?: unknown }).refs;
  if (typeof refs !== 'object' || refs === null) return undefined;
  const entry = (refs as Record<string, unknown>)[String(uid)];
  return typeof entry === 'object' && entry !== null ? entry : undefined;
}

/** A plain-object view of a possibly-absent schema field. */
function objectRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** The value segment at one object key, when the value is a plain object. */
function segmentOf(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  return key in value ? (value as Record<string, unknown>)[key] : undefined;
}

/** One field, mapped from its ref (or a readonly fallback for unresolvable refs). */
function mapRef(
  schemaJson: unknown,
  ref: SchemaRef | undefined,
  fieldPath: string,
  label: string,
  value: unknown,
): FieldNode | undefined {
  if (ref === undefined) return readonlyNode(fieldPath, label, value);
  const type = typeof ref.type === 'string' ? ref.type : '';
  switch (type) {
    case 'string':
      return stringNode(ref, fieldPath, label);
    case 'number':
      return numberNode(ref, fieldPath, label);
    case 'boolean':
      return booleanNode(ref, fieldPath, label);
    case 'const':
      return { fieldPath, label, type: 'readonly', value: ref.value };
    case 'union':
      return unionNode(schemaJson, ref, fieldPath, label, value);
    case 'object':
      return objectNode(schemaJson, ref, fieldPath, label, value);
    case 'array':
      return arrayNode(schemaJson, ref, fieldPath, label);
    case 'dict':
      return dictNode(schemaJson, ref, fieldPath, label);
    default:
      return readonlyNode(fieldPath, label, value);
  }
}

/** The schema node's meta table (absent → empty). */
function metaOf(ref: SchemaRef): Record<string, unknown> {
  return objectRecord(ref.meta);
}

/** Carry the common meta facts (required / default / description) onto a node. */
function withCommon(node: FieldNode, meta: Record<string, unknown>): FieldNode {
  if (meta.required === true) node.required = true;
  if (meta.default !== undefined) node.default = meta.default;
  const description = meta.description;
  if (typeof description === 'string') node.description = description;
  return node;
}

function stringNode(ref: SchemaRef, fieldPath: string, label: string): FieldNode {
  const meta = metaOf(ref);
  const node: FieldNode = { fieldPath, label, type: 'text' };
  const pattern = meta.pattern;
  if (typeof pattern === 'string' && pattern.length > 0) {
    node.pattern = pattern;
  } else if (typeof pattern === 'object' && pattern !== null) {
    const source = (pattern as { source?: unknown }).source;
    if (typeof source === 'string') node.pattern = source;
  }
  if (meta.role === 'secret') node.secret = true;
  return withCommon(node, meta);
}

function numberNode(ref: SchemaRef, fieldPath: string, label: string): FieldNode {
  const meta = metaOf(ref);
  const node: FieldNode = { fieldPath, label, type: 'number' };
  if (typeof meta.min === 'number') node.min = meta.min;
  if (typeof meta.max === 'number') node.max = meta.max;
  if (typeof meta.step === 'number') node.step = meta.step;
  return withCommon(node, meta);
}

function booleanNode(ref: SchemaRef, fieldPath: string, label: string): FieldNode {
  return withCommon({ fieldPath, label, type: 'boolean' }, metaOf(ref));
}

function unionNode(
  schemaJson: unknown,
  ref: SchemaRef,
  fieldPath: string,
  label: string,
  value: unknown,
): FieldNode {
  const meta = metaOf(ref);
  const members = (Array.isArray(ref.list) ? ref.list : []).map((uid) => refOf(schemaJson, uid));
  const constChoices = constChoicesOf(members);
  if (constChoices !== undefined) {
    return withCommon({ fieldPath, label, type: 'select', choices: constChoices }, meta);
  }
  const variant = variantNode(schemaJson, members, fieldPath, label, meta);
  if (variant !== undefined) return variant;
  return readonlyNode(fieldPath, label, value);
}

/** Union-of-consts choices, when every member is a const; else undefined. */
function constChoicesOf(members: readonly (SchemaRef | undefined)[]): string[] | undefined {
  if (members.length === 0) return undefined;
  const choices: string[] = [];
  for (const member of members) {
    if (member === undefined || member.type !== 'const') return undefined;
    if (typeof member.value === 'string') choices.push(member.value);
  }
  return choices.length > 0 ? choices : undefined;
}

/** Union-of-objects variant select, when a const discriminator is shared; else undefined. */
function variantNode(
  schemaJson: unknown,
  members: readonly (SchemaRef | undefined)[],
  fieldPath: string,
  label: string,
  meta: Record<string, unknown>,
): FieldNode | undefined {
  if (members.length === 0) return undefined;
  for (const member of members) {
    if (member === undefined || member.type !== 'object') return undefined;
  }
  const discriminator = discriminatorOf(schemaJson, members);
  if (discriminator === undefined) return undefined;
  const choices: string[] = [];
  for (const member of members) {
    const choice = constValueOf(schemaJson, member, discriminator);
    if (choice === undefined) return undefined;
    choices.push(choice);
  }
  const children: FieldNode[] = [];
  members.forEach((member, index) => {
    const choice = choices[index];
    if (choice === undefined || member === undefined) return;
    children.push(
      objectNode(schemaJson, member, `${fieldPath}.${choice}`, choice, undefined, discriminator),
    );
  });
  return withCommon({ fieldPath, label, type: 'select', discriminator, choices, children }, meta);
}

/** The first object key whose value is a const in every variant; else undefined. */
function discriminatorOf(
  schemaJson: unknown,
  members: readonly (SchemaRef | undefined)[],
): string | undefined {
  const first = members[0];
  if (first === undefined) return undefined;
  const dict = objectRecord(first.dict);
  for (const key of Object.keys(dict)) {
    let common = true;
    for (const member of members) {
      if (constValueOf(schemaJson, member, key) === undefined) {
        common = false;
        break;
      }
    }
    if (common) return key;
  }
  return undefined;
}

/** One variant's const value for the discriminator key; else undefined. */
function constValueOf(
  schemaJson: unknown,
  member: SchemaRef | undefined,
  key: string,
): string | undefined {
  if (member === undefined) return undefined;
  const ref = refOf(schemaJson, objectRecord(member.dict)[key]);
  if (ref === undefined || ref.type !== 'const') return undefined;
  return typeof ref.value === 'string' ? ref.value : undefined;
}

function objectNode(
  schemaJson: unknown,
  ref: SchemaRef,
  fieldPath: string,
  label: string,
  value: unknown,
  excludeKey?: string,
): FieldNode {
  const meta = metaOf(ref);
  const dict = objectRecord(ref.dict);
  // An empty-child record object (NO declared fields at all) → free-form
  // key-value map editor. A variant subtree whose only field is the excluded
  // discriminator still renders as an object with no children.
  if (Object.keys(dict).length === 0) {
    return withCommon({ fieldPath, label, type: 'dict' }, meta);
  }
  const keys = Object.keys(dict).filter((key) => key !== excludeKey);
  const children: FieldNode[] = [];
  for (const key of keys) {
    const child = mapRef(
      schemaJson,
      refOf(schemaJson, dict[key]),
      `${fieldPath}.${key}`,
      key,
      segmentOf(value, key),
    );
    if (child !== undefined) children.push(child);
  }
  return withCommon({ fieldPath, label, type: 'object', children }, meta);
}

function arrayNode(
  schemaJson: unknown,
  ref: SchemaRef,
  fieldPath: string,
  label: string,
): FieldNode {
  const node: FieldNode = { fieldPath, label, type: 'array' };
  const inner = refOf(schemaJson, ref.inner);
  if (inner !== undefined) {
    const child = mapRef(schemaJson, inner, `${fieldPath}.*`, '*', undefined);
    if (child !== undefined) node.children = [child];
  }
  return withCommon(node, metaOf(ref));
}

function dictNode(
  schemaJson: unknown,
  ref: SchemaRef,
  fieldPath: string,
  label: string,
): FieldNode {
  const node: FieldNode = { fieldPath, label, type: 'dict' };
  const inner = refOf(schemaJson, ref.inner);
  if (inner !== undefined) {
    const child = mapRef(schemaJson, inner, `${fieldPath}.<value>`, '<value>', undefined);
    if (child !== undefined) node.children = [child];
  }
  return withCommon(node, metaOf(ref));
}

function readonlyNode(fieldPath: string, label: string, value: unknown): FieldNode {
  return value === undefined
    ? { fieldPath, label, type: 'readonly' }
    : { fieldPath, label, type: 'readonly', value };
}
