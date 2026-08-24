import React from 'react';
import { useTranslation } from 'react-i18next';

import { initials } from '../lib/format';
import { useCall } from '../context/call';

/**
 * The popup, wherever the person happens to be looking.
 *
 * It closes by itself when the caller gives up or the call ends without them —
 * the server says so, and nobody should have to dismiss a call that is no
 * longer happening.
 */
export default function IncomingCallDialog() {
  const { t } = useTranslation();
  const { incoming, answer, decline } = useCall();

  if (!incoming) return null;

  const caller = incoming.from?.name || t('call.somebody');

  return (
    <div className="call-popup" role="dialog" aria-modal="true" aria-label={t('call.incoming')}>
      <div className="call-popup-card">
        <span className="call-avatar ringing" aria-hidden="true">{initials(caller)}</span>

        <div className="call-popup-body">
          <h3>{t('call.isCalling', { name: caller })}</h3>
        </div>

        <div className="call-actions">
          <button type="button" className="btn call-answer" onClick={answer}>
            {t('call.answer')}
          </button>
          <button type="button" className="btn call-hangup" onClick={decline}>
            {t('call.decline')}
          </button>
        </div>
      </div>
    </div>
  );
}
