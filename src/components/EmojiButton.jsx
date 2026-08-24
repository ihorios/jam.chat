import React, { Suspense, lazy, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import Icon from './Icon';

/**
 * The picker, and the button that opens it.
 *
 * Loaded only when somebody actually opens it. The library carries every emoji
 * Unicode defines along with its names and search terms, which is a great deal
 * of data to hand to a person who came here to read a message — so it lives in
 * its own chunk and the messenger loads without it.
 *
 * Rendered with the system's own emoji font rather than the library's images:
 * an emoji picked here has to look like the same emoji does inside a message,
 * where it is nothing but a character in the text. Switching to images would
 * make the picker prettier and make it lie — you would choose a drawing and
 * send a character the reader's font may not have.
 *
 * Which is what EMOJI_VERSION is for. See below.
 */

/**
 * The newest Emoji release the picker will offer.
 *
 * Native rendering means an emoji is only as drawable as the reader's font, and
 * a font that has never heard of a character draws the empty box instead. Every
 * platform's emoji font trails the standard, and Windows 10 trails it by
 * years — so a picker offering everything Unicode defines offers rows of boxes,
 * and worse, lets somebody pick one and send it.
 *
 * 12.0 (2019) is the last release present in every font still in service:
 * Segoe UI Emoji on Windows 10, Apple Color Emoji from macOS 10.15, Noto Color
 * Emoji from Android 10. Everything through 🥱 and 🦾, nothing that draws as a
 * box anywhere.
 *
 * Raise it when the machines that matter have caught up — it is one number, and
 * the library filters the rest. There is no way to raise it per reader: what the
 * *sender's* font can draw says nothing about the person reading it.
 */
const EMOJI_VERSION = '12.0';
const Picker = lazy(() => import('emoji-picker-react'));

export default function EmojiButton({ onPick, disabled = false, title }) {
  const { t } = useTranslation();
  const label = title || t('emoji.insert');
  const [open, setOpen] = useState(false);
  const containerRef = useRef(null);

  // Closing on an outside click is what makes this feel like a menu rather
  // than a panel somebody has to dismiss.
  useEffect(() => {
    if (!open) return undefined;

    const onDocumentClick = (event) => {
      if (!containerRef.current?.contains(event.target)) setOpen(false);
    };
    const onKey = (event) => {
      if (event.key === 'Escape') setOpen(false);
    };

    document.addEventListener('mousedown', onDocumentClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocumentClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="emoji-anchor" ref={containerRef}>
      <button
        type="button"
        className="btn btn-emoji"
        onClick={() => setOpen((was) => !was)}
        disabled={disabled}
        aria-expanded={open}
        aria-label={label}
        title={label}
      >
        <Icon name="mood" />
      </button>

      {open && (
        <div className="emoji-popover" role="dialog" aria-label={t('emoji.heading')}>
          <Suspense fallback={<div className="emoji-loading">{t('emoji.loading')}</div>}>
            <Picker
              onEmojiClick={(emoji) => {
                onPick(emoji.emoji);
                setOpen(false);
              }}
              // The system font, so what is picked matches what is read.
              emojiStyle="native"
              emojiVersion={EMOJI_VERSION}
              theme="dark"
              lazyLoadEmojis
              /* Deliberately not a pixel size. The library turns these into
                 an inline style on its own root, so a number here would be
                 unbeatable from CSS without !important — and the panel has to
                 be one width on a desktop and another on a phone. Handing it
                 100% makes .emoji-popover the single place that decides. */
              width="100%"
              height="100%"
              previewConfig={{ showPreview: false }}
              searchPlaceholder={t('emoji.search')}
            />
          </Suspense>
        </div>
      )}
    </div>
  );
}
