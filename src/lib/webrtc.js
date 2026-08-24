/**
 * The browser half of a call: one peer connection per person in it.
 *
 * Audio flows directly between the two browsers. The server sees none of it —
 * it only carries the blobs this file produces (`sendSignal`) and hands back
 * (`accept`), which is why the whole of WebRTC is confined to this module. If
 * calls ever move to an SFU, this is the file that changes and nothing else.
 *
 * Who offers is settled by the server's rule rather than negotiated: the peer
 * that joins offers to everyone already there, incumbents only answer. That is
 * what stops two browsers offering each other at once, and it is why there is
 * no perfect-negotiation dance here.
 *
 * Which ICE servers to use is the server's business, not this file's: TURN
 * credentials expire, so they are fetched per call rather than built in. What
 * is built in is the fallback below, so a browser that cannot reach that
 * endpoint still gets as far as STUN can take it.
 */

import { api } from './api';

/** Public STUN, if the server cannot be asked. Enough for most networks. */
const FALLBACK_ICE = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
];

/**
 * The ICE servers for this session, with the seconds they are good for.
 *
 * Never throws: a call on STUN alone is far better than no call, and the
 * failure shows up as the connection not establishing on the networks that
 * needed a relay.
 */
export async function loadIceServers() {
  try {
    const data = await api('/api/calls/ice');
    return {
      iceServers: data.iceServers?.length ? data.iceServers : FALLBACK_ICE,
      ttl: data.ttl || 3600,
    };
  } catch {
    return { iceServers: FALLBACK_ICE, ttl: 300 };
  }
}

/**
 * Builds the mesh around one local stream.
 *
 *   stream                       the microphone, already granted
 *   iceServers                   from loadIceServers(), above
 *   sendSignal(peerId, payload)  hand a blob to that peer, however you like
 *   onTrack(peerId, stream)      their audio has arrived
 *   onState(peerId, state)       'connecting' | 'connected' | 'failed' | ...
 *   onError(error, peerId)       negotiation went wrong with one peer
 */
export function createPeerMesh({
  stream,
  iceServers = FALLBACK_ICE,
  sendSignal,
  onTrack,
  onState,
  onError,
}) {
  /** peerId -> { pc, pending } */
  const peers = new Map();

  const fail = (err, peerId) => onError?.(err, peerId);

  const peerFor = (peerId) => {
    const existing = peers.get(peerId);
    if (existing) return existing;

    const pc = new RTCPeerConnection({ iceServers });
    // Candidates that arrived before there was a remote description to attach
    // them to. Signalling is faster than negotiation, so this happens often.
    const entry = { pc, pending: [] };
    peers.set(peerId, entry);

    for (const track of stream.getTracks()) pc.addTrack(track, stream);

    pc.addEventListener('icecandidate', (event) => {
      if (event.candidate) {
        sendSignal(peerId, { kind: 'candidate', candidate: event.candidate.toJSON() });
      }
    });

    pc.addEventListener('track', (event) => onTrack?.(peerId, event.streams[0]));
    pc.addEventListener('connectionstatechange', () => onState?.(peerId, pc.connectionState));

    return entry;
  };

  /** Attaches whatever arrived early, now that it can be attached. */
  const flush = async (entry) => {
    const waiting = entry.pending.splice(0);
    for (const candidate of waiting) {
      await entry.pc.addIceCandidate(candidate).catch((err) => fail(err));
    }
  };

  const describe = (description) => ({ type: description.type, sdp: description.sdp });

  return {
    /** Opens the conversation with a peer already in the call. */
    async offerTo(peerId) {
      const { pc } = peerFor(peerId);
      try {
        await pc.setLocalDescription(await pc.createOffer());
        sendSignal(peerId, { kind: 'offer', sdp: describe(pc.localDescription) });
      } catch (err) {
        fail(err, peerId);
      }
    },

    /** One relayed blob, whatever it turns out to be. */
    async accept(peerId, payload) {
      if (!payload || typeof payload !== 'object') return;
      const entry = peerFor(peerId);
      const { pc } = entry;

      try {
        if (payload.kind === 'offer') {
          await pc.setRemoteDescription(payload.sdp);
          await flush(entry);
          await pc.setLocalDescription(await pc.createAnswer());
          sendSignal(peerId, { kind: 'answer', sdp: describe(pc.localDescription) });
          return;
        }

        if (payload.kind === 'answer') {
          await pc.setRemoteDescription(payload.sdp);
          await flush(entry);
          return;
        }

        if (payload.kind === 'candidate' && payload.candidate) {
          // Out of order is normal, not an error: hold it until there is
          // something to add it to.
          if (pc.remoteDescription) await pc.addIceCandidate(payload.candidate);
          else entry.pending.push(payload.candidate);
        }
      } catch (err) {
        fail(err, peerId);
      }
    },

    /** That peer has left. */
    drop(peerId) {
      const entry = peers.get(peerId);
      if (!entry) return;
      peers.delete(peerId);
      entry.pc.close();
    },

    /** The call is over. Safe to call twice — hanging up often happens twice. */
    close() {
      for (const [, entry] of peers) entry.pc.close();
      peers.clear();
    },
  };
}
