import React from 'react';

/**
 * A Material Symbol.
 *
 * The icon set is a font (see the @import in index.css), so an icon is its own
 * name written as a ligature: `<Icon name="delete" />` renders the word
 * "delete" in a font where that word draws a bin. Two consequences worth
 * knowing:
 *
 * - The name is a real text node, so machine translation would happily turn
 *   "delete" into another language and leave the icon undrawn. `translate="no"`
 *   is what stops that.
 * - Icons are decoration beside a label almost everywhere here, so they are
 *   hidden from assistive technology by default. Pass `label` for the few that
 *   stand alone and have to say what they are.
 */
export default function Icon({ name, className = '', filled = false, label }) {
  const classes = ['icon', filled ? 'filled' : '', className].filter(Boolean).join(' ');

  return (
    <span
      className={classes}
      translate="no"
      {...(label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true })}
    >
      {name}
    </span>
  );
}
