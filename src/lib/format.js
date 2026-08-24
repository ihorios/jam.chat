/** Presentation helpers shared by the admin panels. */

/** A timestamp as the reader's locale writes it, or an em dash if there is none. */
export function formatDateTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * A user as a person rather than a row: their name, falling back to the email
 * and then to the id, so an unreadable or missing user still renders as
 * something a human can act on.
 */
export function userLabel(user, id) {
  if (!user) return id === undefined || id === null ? '—' : `#${id}`;
  return user.name || user.email || `#${user.id}`;
}

const UNITS = ['B', 'KB', 'MB', 'GB'];

/** A byte count as a person would say it: 940 B, 12.4 KB, 3.1 MB. */
export function formatBytes(bytes) {
  const size = Number(bytes);
  if (!Number.isFinite(size) || size < 0) return '—';

  let value = size;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }

  // Whole bytes are always whole; anything scaled reads better with a decimal,
  // but not when it has rounded to something like "1.0 MB".
  const rounded = unit === 0 || value >= 100 || Number.isInteger(value)
    ? Math.round(value)
    : value.toFixed(1);

  return `${rounded} ${UNITS[unit]}`;
}

/**
 * Anything that is a picture rather than a letter. Regional indicators are
 * named separately because a flag is a picture made of two letters, and is not
 * Extended_Pictographic at all.
 */
const PICTOGRAPH = /[\p{Extended_Pictographic}\p{Regional_Indicator}]/u;
/**
 * Emoji, the bits that join them, and whitespace — and nothing else.
 * Emoji_Component alone would not do: it counts plain digits, so "2024" would
 * pass for a message made of pictures.
 */
// Written as alternation rather than a character class: the zero-width joiner
// and the variation selector are combining marks, and a class containing them
// is the sort of thing that means something subtly different from what it
// looks like.
const NOTHING_BUT_EMOJI = new RegExp(
  '^(?:'
  + '\\p{Extended_Pictographic}|\\p{Emoji_Component}|\\p{Regional_Indicator}'
  + '|\\u200D|\\uFE0F|\\s'
  + ')+$',
  'u'
);

/**
 * Is this message nothing but a few emoji?
 *
 * Messengers draw those larger, and the reason is worth stating: an emoji sent
 * on its own is the message, not decoration on one, and at body-text size it
 * reads as an afterthought. Only up to `max` of them — a wall of emoji is a
 * wall of text.
 */
export function emojiOnly(text, max = 3) {
  const value = String(text ?? '').trim();
  if (!value || !PICTOGRAPH.test(value) || !NOTHING_BUT_EMOJI.test(value)) return false;

  // Counted in graphemes, so a flag or a family — several code points that
  // draw as one picture — counts once.
  if (typeof Intl === 'undefined' || !Intl.Segmenter) return value.length <= max * 4;

  const graphemes = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    .segment(value)]
    .filter((entry) => entry.segment.trim() !== '');

  return graphemes.length > 0 && graphemes.length <= max;
}

/** Initials for an avatar circle, from whatever name we have. */
export function initials(label) {
  const parts = String(label ?? '').replace(/^#/, '').split(/[\s@._-]+/).filter(Boolean);
  return (parts[0]?.[0] || '?').toUpperCase() + (parts[1]?.[0] || '').toUpperCase();
}
