import React from 'react';

export type NoteTone = 'success' | 'error' | 'info' | 'warn';
export type Note = { tone: NoteTone; text: string };

const NOTE_CLASS: Record<NoteTone, string> = {
  success: 'inline-note inline-note--success',
  error: 'inline-note inline-note--error',
  info: 'inline-note inline-note--info',
  warn: 'inline-note inline-note--warn',
};

/** Form-scoped feedback rendered next to the control that triggered it. */
export function InlineNote({ note }: { note: Note | null }) {
  if (!note) return null;
  return (
    <p
      className={NOTE_CLASS[note.tone]}
      role={note.tone === 'error' ? 'alert' : 'status'}
    >
      {note.text}
    </p>
  );
}
