import React, { useId } from 'react';

/**
 * The JAM.chat mark: the icon tile from the lockup — the accent sweep with a
 * speech bubble punched through it.
 *
 * Geometry is shared with public/icon.svg and with the tile in
 * public/logo-lockup.png: 96 square, radius 26, bubble at 52% of the tile.
 * Change one and the others have to follow.
 *
 * Kept as a component rather than an <img> so it stays crisp at any size and
 * can be recoloured from one place. The gradient id is unique per instance —
 * several marks on one page would otherwise collide on the same id and all
 * resolve to whichever gradient the browser saw first.
 */
export default function Logo({ size = 32, className = '', title = 'JAM.chat' }) {
  const gradientId = `jam-logo-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;

  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 96 96"
      role="img"
      aria-label={title}
      focusable="false"
    >
      <defs>
        {/* project accent sweep: accent-cyan to accent-purple (src/index.css) */}
        <linearGradient id={gradientId} gradientUnits="userSpaceOnUse" x1="0" y1="40" x2="96" y2="57">
          <stop offset="0" stopColor="#38bdf8" />
          <stop offset="1" stopColor="#818cf8" />
        </linearGradient>
      </defs>

      <rect width="96" height="96" rx="26" fill={`url(#${gradientId})`} />

      {/* The message, punched through the tile in bg-dark. */}
      <g transform="translate(22 22.1) scale(0.52)" fill="#0f172a">
        <path d="M18 0 H82 A18 18 0 0 1 100 18 V54 A18 18 0 0 1 82 72 H50 L22 90 L28 72 H18 A18 18 0 0 1 0 54 V18 A18 18 0 0 1 18 0 Z" />
      </g>
    </svg>
  );
}
