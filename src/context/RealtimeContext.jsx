import React, { useState, useEffect, useRef, useCallback } from 'react';

import { api } from '../lib/api';
import { openSocket } from '../lib/socket';
import { useAuth } from './auth';
import { RealtimeContext } from './realtime';

const NOTHING_UNREAD = { groups: {}, total: 0 };

/**
 * One socket for the whole application, and the unread state that rides on it.
 *
 * It lives above the pages because two of them need it at once: the messenger
 * draws new messages as they arrive, and the header shows a dot whether or not
 * the messenger is open. A socket per component would mean several per tab and
 * a presence count that flattered itself.
 *
 * The socket is opened for anonymous visitors too. That is deliberate — the
 * server counts connections whether or not they have signed in, and reopening
 * on sign-in is what turns one into the other.
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

    const socket = openSocket({
      onStatus: setStatus,
      onEvent: (event) => {
        if (event.type === 'hello' || event.type === 'unread') {
          setUnread({ groups: event.groups || {}, total: event.total || 0 });
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
        if (!cancelled) setUnread({ groups: data.groups, total: data.total });
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
        groups: { ...prev.groups, [groupId]: 0 },
        total: Math.max(0, prev.total - current),
      };
    });

    if (socketRef.current?.send({ type: 'read', group: groupId })) return;

    try {
      const data = await api('/api/messenger/read', { method: 'POST', body: { group: groupId } });
      setUnread({ groups: data.groups, total: data.total });
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
