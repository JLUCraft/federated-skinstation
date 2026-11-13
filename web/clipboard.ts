import { useEffect, useState } from 'react';
import type { Note } from './InlineNote';
import { t } from './i18n';

const COPY_NOTICE_MS = 2000;

export function useClipboard() {
  const [status, setStatus] = useState<'idle' | 'copied' | 'failed'>('idle');
  useEffect(() => {
    if (status !== 'copied') return;
    const timer = window.setTimeout(() => setStatus('idle'), COPY_NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [status]);

  const failed = (error: unknown) => {
    console.error(error);
    setStatus('failed');
  };
  const copy = (text: string) => {
    setStatus('idle');
    try {
      navigator.clipboard
        .writeText(text)
        .then(() => setStatus('copied'))
        .catch(failed);
    } catch (error: unknown) {
      failed(error);
    }
  };
  const note: Note | null = status === 'failed' ? { tone: 'error', text: t('复制失败') } : null;
  return { copy, copied: status === 'copied', note };
}
