/**
 * Copy dictionaries for the Integrations settings page (issue #2). Product
 * copy is Chinese first (the dsh web convention); English mirrors it.
 */

export const zh = {
  nav: '扩展 / 集成',
  loading: '正在加载扩展设置…',
  loadFailed: '加载失败',
  retry: '重试',
  noSettings: '此扩展没有注册可配置的设置命名空间。',
  openDocument: '打开配置文件',
  opening: '正在打开…',
  opened: '配置文件已就绪。',
  openFailed: '无法打开配置文件。',
  save: '保存',
  saving: '正在保存…',
  saved: '已保存。',
  saveFailed: '保存失败：{message}',
  conflict: '设置已被其他窗口修改，已刷新最新值。',
  required: '必填',
  secretPlaceholder: '密钥（不回显）',
  readonly: '只读',
  selectPlaceholder: '请选择…',
  arrayHint: '数组（JSON 编辑）',
  dictHint: '键值映射（JSON 编辑）',
  invalidJson: 'JSON 无效，尚未保存。',
} as const;

export type LocaleKey = keyof typeof zh;

export const en: Record<LocaleKey, string> = {
  nav: 'Extensions / Integrations',
  loading: 'Loading extension settings…',
  loadFailed: 'Failed to load',
  retry: 'Retry',
  noSettings: 'This extension registers no schema-configurable settings.',
  openDocument: 'Open settings document',
  opening: 'Opening…',
  opened: 'Settings document ready.',
  openFailed: 'Could not open the settings document.',
  save: 'Save',
  saving: 'Saving…',
  saved: 'Saved.',
  saveFailed: 'Save failed: {message}',
  conflict: 'Settings changed elsewhere; refreshed to the latest values.',
  required: 'required',
  secretPlaceholder: 'Secret (never echoed)',
  readonly: 'read-only',
  selectPlaceholder: 'Select…',
  arrayHint: 'Array (JSON editor)',
  dictHint: 'Key-value map (JSON editor)',
  invalidJson: 'Invalid JSON; not saved.',
};
