import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';

import { api } from '../lib/api';
import { useRealtime } from '../context/realtime';

/**
 * Who is connected right now, counted live.
 *
 * A connection is a WebSocket rather than a person, so the figures are kept
 * apart: one signed-in user with three tabs open is three connections and one
 * signed-in user. Guests are the connections nobody has signed in on — a
 * browser sitting on the login page is here, and saying so is the point of
 * counting them separately.
 *
 * Only rendered for a caller holding the unscoped users:read; the server
 * enforces the same rule on both the fetch and the socket frames.
 */
export default function PresenceMetrics() {
  const { t } = useTranslation();
  const { subscribe, status } = useRealtime();
  const [presence, setPresence] = useState(null);

  // The socket pushes a frame on every change, but a dashboard that has just
  // loaded should not wait for somebody else to connect before showing a number.
  useEffect(() => {
    let cancelled = false;

    api('/api/presence')
      // Only if nothing has arrived over the socket meanwhile: a pushed frame is
      // never older than this response, and may well be newer.
      .then((data) => { if (!cancelled) setPresence((current) => current ?? data); })
      .catch(() => {});

    return () => { cancelled = true; };
  }, []);

  useEffect(
    () => subscribe((event) => {
      if (event.type === 'presence') setPresence(event);
    }),
    [subscribe]
  );

  // Nothing yet rather than zero, which would read as "nobody is here".
  const count = (key) => (presence ? presence[key] : '—');

  return (
    <div className="panel-toolbar">
      <div className="metrics-row">
        <div className="metric-box">
          <div className="metric-value">{count('total')}</div>
          <div className="metric-label">{t('presence.connections')}</div>
        </div>
        <div className="metric-box">
          <div className="metric-value">{count('people')}</div>
          <div className="metric-label">{t('presence.people')}</div>
        </div>
        <div className="metric-box">
          <div className="metric-value">{count('anonymous')}</div>
          <div className="metric-label">{t('presence.guests')}</div>
        </div>
      </div>

      <span className={status === 'online' ? 'status-badge status-online' : 'status-badge status-offline'}>
        <span className="status-dot" />
        {t(status === 'online' ? 'presence.live' : 'presence.reconnecting')}
      </span>
    </div>
  );
}
