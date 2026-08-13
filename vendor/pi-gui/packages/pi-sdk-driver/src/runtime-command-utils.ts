export function normalizeRuntimeCommandName(value: string): string {
  // Cardo: re-trim after stripping leading slashes so the function is
  // idempotent — previously "/ x" normalized to " x", which normalized again
  // to "x", breaking the normalize-twice == normalize-once contract.
  return value.trim().replace(/^\/+/, "").trim();
}

export function skillCommandName(name: string): string {
  return `skill:${normalizeRuntimeCommandName(name)}`;
}

export function skillSlashCommand(name: string): string {
  return `/${skillCommandName(name)}`;
}
