import React, { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import Icon from './Icon';
import { initials } from '../lib/format';
import { useCall } from '../context/call';

/**
 * A peer's voice.
 *
 * A media stream cannot be handed to an element as a prop — it is assigned,
 * not rendered — which is the whole reason this is a component rather than an
 * <audio> tag in the list below.
 */
function PeerAudio({ stream }) {
  const ref = useRef(null);

  useEffect(() => {
    if (ref.current) ref.current.srcObject = stream || null;
  }, [stream]);

  return <audio ref={ref} autoPlay playsInline />;
}

/* The peer states worth naming, mapped to their own keys. A state not listed
   here is shown as the raw word the browser gave us, which is better than
   nothing and is not something to translate blind. */
const PEER_STATE = {
  new: 'call.peer.connecting',
  connecting: 'call.peer.connecting',
  connected: 'call.peer.connected',
  disconnected: 'call.peer.reconnecting',
  failed: 'call.peer.failed',
  closed: 'call.peer.gone',
};

/**
 * The call itself, docked in the corner: who is on it, the microphone, and the
 * way out.
 *
 * Deliberately not a modal. A call is something you do *while* reading the
 * conversation it came from, so it must not take the screen away.
 */
export default function CallPanel() {
  const { t } = useTranslation();
  const { call, peers, streams, state, micOn, error, hangUp, toggleMic, clearError } = useCall();

  // A call that failed to start has no call to show, but the reason it failed
  // still has to be said somewhere.
  if (!call) {
    if (!error) return null;
    return (
      <section className="call-panel" aria-label={t('call.failedLabel')}>
        <p className="call-error">{error}</p>
        <div className="call-actions">
          <button type="button" className="btn call-mic" onClick={clearError}>{t('call.dismiss')}</button>
        </div>
      </section>
    );
  }

  return (
    <section className="call-panel" aria-label={t('call.inProgressLabel')}>
      <header className="call-panel-header">
        <span className={`status-dot call-state ${state}`} aria-hidden="true" />
        {/* No group named here on purpose: an id is not a conversation, and
            who is on the call is the list underneath. */}
        <h4>{t(state === 'ringing' ? 'call.calling' : 'call.inACall')}</h4>
      </header>

      <ul className="call-peers">
        {peers.length === 0 ? (
          <li className="call-peer waiting">{t('call.waiting')}</li>
        ) : (
          peers.map((peer) => (
            <li key={peer.connectionId} className="call-peer">
              <span className="call-avatar small" aria-hidden="true">
                {initials(peer.name)}
              </span>
              <span className="call-peer-name">{peer.name || `#${peer.userId}`}</span>
              <span className="call-peer-state">{PEER_STATE[peer.state] ? t(PEER_STATE[peer.state]) : peer.state}</span>
              <PeerAudio stream={streams[peer.connectionId]} />
            </li>
          ))
        )}
      </ul>

      {error && <p className="call-error">{error}</p>}

      <div className="call-actions">
        <button
          type="button"
          className={micOn ? 'btn call-mic' : 'btn call-mic off'}
          onClick={toggleMic}
          aria-pressed={!micOn}
        >
          <Icon name={micOn ? 'mic' : 'mic_off'} /> {t(micOn ? 'call.mute' : 'call.unmute')}
        </button>
        <button type="button" className="btn call-hangup" onClick={hangUp}>
          {t('call.leave')}
        </button>
      </div>
    </section>
  );
}
