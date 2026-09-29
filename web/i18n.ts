import messages from './locales/zh-CN';

export function t(key: keyof typeof messages): string {
  return messages[key];
}
