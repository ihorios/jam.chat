/**
 * The application's WebSocket, with reconnection.
 *
 * The session travels in the same HTTP-only cookie the REST calls use — the
 * handshake is an ordinary request, so there is no token to attach here and
 * nothing for JavaScript to leak. Signing in or out therefore means opening a
 * new socket rather than telling this one about it.
 */

const FIRST_RETRY_MS = 1000;
const MAX_RETRY_MS = 15000;

function socketUrl() {
  const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
  return `${protocol}://${window.location.host}/ws`;
}

/**
 * Connects, and keeps connecting. `onEvent` receives every decoded frame;
 * `onStatus` receives 'connecting' | 'online' | 'offline'.
 *
 * Returns a handle whose send() is safe to call at any time: frames posted
 * while the socket is down are dropped rather than queued, because everything
 * this app sends is a statement about now (what has been read) that the next
 * hello will restate anyway.
 */
export function openSocket({ onEvent, onStatus } = {}) {
  let socket = null;
  let retryDelay = FIRST_RETRY_MS;
  let retryTimer = null;
  let closedByCaller = false;

  const setStatus = (status) => onStatus?.(status);

  function connect() {
    if (closedByCaller) return;
    setStatus('connecting');

    socket = new WebSocket(socketUrl());

    socket.addEventListener('open', () => {
      retryDelay = FIRST_RETRY_MS;
      setStatus('online');
    });

    socket.addEventListener('message', (event) => {
      let payload;
      try {
        payload = JSON.parse(event.data);
      } catch {
        return; // A frame we cannot read is a frame we cannot act on.
      }
      onEvent?.(payload);
    });

    socket.addEventListener('close', () => {
      if (closedByCaller) return;
      setStatus('offline');
      retryTimer = setTimeout(connect, retryDelay);
      // Back off, so a server that is down does not get hammered by every
      // open tab, but never wait so long that a recovery goes unnoticed.
      retryDelay = Math.min(retryDelay * 2, MAX_RETRY_MS);
    });

    // An error is always followed by a close, which is where reconnection
    // lives; this only stops it reaching the console as an unhandled event.
    socket.addEventListener('error', () => socket?.close());
  }

  connect();

  return {
    send(payload) {
      if (socket?.readyState !== WebSocket.OPEN) return false;
      socket.send(JSON.stringify(payload));
      return true;
    },
    close() {
      closedByCaller = true;
      clearTimeout(retryTimer);
      socket?.close();
    },
  };
}
