import React, { useEffect, useState } from 'react';

import { initials } from '../lib/format';

/**
 * The picture that stands in for somebody, or their initials when there is none.
 *
 * `logo` goes straight into `src` because it is not free text: the users model
 * stores only an http(s) URL and refuses everything else, so the check lives
 * where the value is written rather than at each of the places it is read
 * (server/db/models/users.js).
 *
 * A URL that no longer resolves — a provider that moved the file, an account
 * picture that has gone private — falls back to the initials rather than
 * leaving a broken image in the conversation.
 */
export default function Avatar({ logo, name, className = 'chat-avatar' }) {
  const [broken, setBroken] = useState(false);

  // A different person in the same slot deserves a fresh attempt.
  useEffect(() => setBroken(false), [logo]);

  if (!logo || broken) {
    return <span className={className} aria-hidden="true">{initials(name)}</span>;
  }

  return (
    <img
      className={`${className} avatar-image`}
      src={logo}
      alt=""
      aria-hidden="true"
      loading="lazy"
      onError={() => setBroken(true)}
    />
  );
}
