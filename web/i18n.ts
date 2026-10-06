import messages from './locales/zh-CN';

export function t(key: keyof typeof messages): string {
  return messages[key];
}

/** Message with `{name}` placeholders filled from `values`. */
export function tf(
  key: keyof typeof messages,
  values: Record<string, string | number>,
): string {
  return t(key).replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in values ? String(values[name]) : whole,
  );
}
