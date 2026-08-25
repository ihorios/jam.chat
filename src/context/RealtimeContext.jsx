import React, { useState, useEffect, useRef, useCallback } from 'react';

import { api } from '../lib/api';
import { openSocket } from '../lib/socket';
import { useAuth } from './auth';
import { RealtimeContext } from './realtime';

/*
 * `latest` is the last thing said in each group, which the server sends on the
 * same frame as the counts (server/realtime/unread.js). The sidebar draws its
 * preview line from it — the messenger holds only the conversation it has open,
 * so it has nothing of its own to derive one from for the rest.
 */
const NOTHING_UNREAD = { groups: {}, latest: {}, total: 0 };

/**
 * One socket for the whole application, and the unread state that rides on it.
 *
 * It lives above the pages because two of them need it at once: the messenger
 * draws new messages as they arrive, and the header shows a dot whether or not
 * the messenger is open. A socket per component would mean several per tab and
 * a presence count that flattered itself.
 *
 * Only ever for somebody signed in. It used to be opened for anonymous visitors
 * as well, so that a browser on the login page counted towards presence — but
 * the server now refuses a handshake without a session, and this effect is
 * keyed on the identity, so signing in opens one and signing out closes it.
 */
export function RealtimeProvider({ children }) {
  const { user } = useAuth();

  const [status, setStatus] = useState('connecting');
  const [unread, setUnread] = useState(NOTHING_UNREAD);

  const socketRef = useRef(null);
  // Subscribers are held in a ref so that adding one does not reopen the
  // socket, and so an event never arrives at a handler that has unmounted.
  const handlersRef = useRef(new Set());

  const subscribe = useCallback((handler) => {
    handlersRef.current.add(handler);
    return () => handlersRef.current.delete(handler);
  }, []);

  /**
   * Posts a frame, reporting whether it went. Stable, so a subscriber can hold
   * on to it without re-registering — calls send a great many of these.
   */
  const send = useCallback((payload) => Boolean(socketRef.current?.send(payload)), []);

  // Reopened whenever the identity changes: the handshake is what carries the
  // session, so a socket opened before signing in belongs to nobody.
  const identity = user?.id ?? null;

  useEffect(() => {
    setUnread(NOTHING_UNREAD);

    /*
     * No session, no socket — and this is not merely an optimisation.
     *
     * The server refuses a handshake without one (plugins/realtime.js), and
     * openSocket reconnects on every close with a backoff that tops out at
     * fifteen seconds. Opening one anyway would turn every signed-out visitor
     * into a permanent reconnect loop against a door that will never open.
     */
    if (identity === null) {
      setStatus('offline');
      return undefined;
    }

    const socket = openSocket({
      onStatus: setStatus,
      onEvent: (event) => {
        if (event.type === 'hello' || event.type === 'unread') {
          setUnread({
            groups: event.groups || {},
            latest: event.latest || {},
            total: event.total || 0,
          });
        }
        for (const handler of handlersRef.current) handler(event);
      },
    });
    socketRef.current = socket;

    return () => {
      socket.close();
      socketRef.current = null;
    };
  }, [identity]);

  // The socket says hello with the same numbers, but a page that has just
  // loaded should not wait on a handshake to know it has something waiting.
  useEffect(() => {
    if (!identity) return;
    let cancelled = false;

    api('/api/messenger/unread')
      .then((data) => {
        if (!cancelled) {
          setUnread({ groups: data.groups, latest: data.latest || {}, total: data.total });
        }
      })
      .catch(() => {});

    return () => { cancelled = true; };
  }, [identity]);

  /**
   * Says that everything in a group has been seen. Sent over the socket when
   * there is one, and over HTTP when there is not, so a reader on a flaky
   * connection still stops being told about what they have read.
   */
  const markRead = useCallback(async (groupId) => {
    if (groupId === null || groupId === undefined) return;

    // Clear it locally first: the outline should go the moment the group is
    // opened, not a round trip later.
    setUnread((prev) => {
      const current = prev.groups[groupId] || 0;
      if (current === 0) return prev;
      return {
        // Spread, so clearing a count does not take the preview lines with it.
        ...prev,
        groups: { ...prev.groups, [groupId]: 0 },
        total: Math.max(0, prev.total - current),
      };
    });

    if (socketRef.current?.send({ type: 'read', group: groupId })) return;

    try {
      const data = await api('/api/messenger/read', { method: 'POST', body: { group: groupId } });
      setUnread({ groups: data.groups, latest: data.latest || {}, total: data.total });
    } catch {
      // Not worth interrupting a reader over; the next hello restates it.
    }
  }, []);

  return (
    <RealtimeContext.Provider value={{ status, unread, subscribe, send, markRead }}>
      {children}
    </RealtimeContext.Provider>
  );
}
