import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import i18n from '../i18n';
import { createPeerMesh, loadIceServers } from '../lib/webrtc';
import { useRealtime } from './realtime';
import { CallContext } from './call';

/**
 * One call at a time, for the whole tab.
 *
 * It sits above the pages because a call is not a page: the popup has to
 * arrive wherever the person is looking, and the conversation has to survive
 * them navigating away from the messenger. The socket underneath is the one
 * everything else already uses — calls add frames to it, not another socket.
 *
 * The division of labour is the same as on the server. This file knows what a
 * call is — who is ringing, who has answered, whether the microphone is on —
 * and `lib/webrtc.js` knows what an offer is. Neither knows the other's half.
 */
export function CallProvider({ children }) {
  const { subscribe, send, status: socketStatus } = useRealtime();

  /** A call being offered to us: the popup. */
  const [incoming, setIncoming] = useState(null);
  /** The call we are in, once we have said yes to one. */
  const [call, setCall] = useState(null);
  const [peers, setPeers] = useState([]);
  const [streams, setStreams] = useState({});
  const [micOn, setMicOn] = useState(true);
  const [error, setError] = useState('');

  const meshRef = useRef(null);
  const localStreamRef = useRef(null);
  /** The group we are in a call in, for the handlers that cannot see state. */
  const groupRef = useRef(null);
  /** Same, for whether anybody has answered yet. */
  const peersRef = useRef([]);
  /** ICE servers and when their credentials stop working. */
  const iceRef = useRef({ servers: null, expiresAt: 0 });

  useEffect(() => { peersRef.current = peers; }, [peers]);

  /**
   * Ends the call as far as this tab is concerned: peers closed, microphone
   * released — a browser that keeps the recording light on after a call is a
   * browser nobody trusts. Deliberately safe to run twice, because hanging up
   * and being told the call ended often arrive together.
   */
  const teardown = useCallback(() => {
    meshRef.current?.close();
    meshRef.current = null;

    for (const track of localStreamRef.current?.getTracks() || []) track.stop();
    localStreamRef.current = null;

    groupRef.current = null;
    setCall(null);
    setPeers([]);
    setStreams({});
    setMicOn(true);
  }, []);

  /** The microphone, asked for once per call. */
  const ensureMedia = useCallback(async () => {
    if (localStreamRef.current) return localStreamRef.current;
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    localStreamRef.current = stream;
    return stream;
  }, []);

  /**
   * The ICE servers, kept until shortly before the TURN credentials in them
   * expire. Re-fetched rather than refreshed: a minted credential is cheap,
   * and a call started on an expired one simply fails to relay.
   */
  const ensureIce = useCallback(async () => {
    const now = Date.now();
    if (iceRef.current.servers && now < iceRef.current.expiresAt) return iceRef.current.servers;

    const { iceServers, ttl } = await loadIceServers();
    // A minute early, so a call placed on the hour does not run out mid-ring.
    iceRef.current = { servers: iceServers, expiresAt: now + Math.max(ttl - 60, 60) * 1000 };
    return iceServers;
  }, []);

  const ensureMesh = useCallback((group) => {
    if (meshRef.current) return meshRef.current;

    meshRef.current = createPeerMesh({
      stream: localStreamRef.current,
      iceServers: iceRef.current.servers,
      sendSignal: (to, payload) => send({ type: 'call:signal', group, to, payload }),
      onTrack: (peerId, stream) => setStreams((prev) => ({ ...prev, [peerId]: stream })),
      onState: (peerId, state) => setPeers((prev) => prev.map(
        (peer) => (peer.connectionId === peerId ? { ...peer, state } : peer)
      )),
      onError: () => setError(i18n.t('call.error.peerFailed')),
    });

    return meshRef.current;
  }, [send]);

  // Registered once: every handler works from the frame and functional
  // updates, never from a value captured when it was written.
  useEffect(() => subscribe((event) => {
    switch (event.type) {
      case 'call:ringing':
        return setIncoming({ group: event.group, from: event.from, startedAt: event.startedAt });

      case 'call:state': {
        // We are in. By the server's rule the arriver offers, so this is where
        // the conversation with everyone already there begins.
        groupRef.current = event.group;
        setCall({
          group: event.group,
          self: event.self,
          startedBy: event.startedBy,
          startedAt: event.startedAt,
        });
        setPeers(event.peers.map((peer) => ({ ...peer, state: 'new' })));

        if (!localStreamRef.current) return setError(i18n.t('call.error.noMic'));
        const mesh = ensureMesh(event.group);
        for (const peer of event.peers) mesh.offerTo(peer.connectionId);
        return;
      }

      case 'call:peer-joined':
        // They will offer to us; there is nothing to do but expect them.
        return setPeers((prev) => (
          prev.some((peer) => peer.connectionId === event.peer.connectionId)
            ? prev
            : [...prev, { ...event.peer, state: 'new' }]
        ));

      case 'call:signal':
        return meshRef.current?.accept(event.from, event.payload);

      case 'call:peer-left': {
        const { connectionId } = event.peer;
        meshRef.current?.drop(connectionId);
        setPeers((prev) => prev.filter((peer) => peer.connectionId !== connectionId));
        setStreams((prev) => {
          if (!prev[connectionId]) return prev;
          const { [connectionId]: _gone, ...rest } = prev;
          return rest;
        });
        return;
      }

      case 'call:ended':
        // For a call we were only being rung about, this just closes the popup.
        setIncoming((prev) => (prev?.group === event.group ? null : prev));
        if (groupRef.current === event.group) {
          // Ringing out is the one ending worth a word: the caller has been
          // listening to it and deserves to know it stopped for a reason.
          if (event.reason === 'unanswered') setError(i18n.t('call.error.unanswered'));
          teardown();
        }
        return;

      case 'error':
        // While a call is being placed, its frames are the only ones this tab
        // has sent, so a refusal now belongs to it — better said out loud than
        // left ringing forever. Once somebody has answered it is a different
        // matter: a refused signal is usually a race with a peer leaving, and
        // not a reason to end a conversation.
        if (groupRef.current !== null && peersRef.current.length === 0) {
          setError(event.error || i18n.t('call.error.notPlaced'));
          teardown();
        }
        return;

      default:
    }
  }), [subscribe, ensureMesh, teardown]);

  /**
   * A socket that has gone took our place in the call with it — the server
   * treats a dropped connection as a hangup, and the other side has already
   * been told we left. Showing a call that no longer exists would be a lie.
   */
  useEffect(() => {
    if (socketStatus !== 'online' && groupRef.current !== null) {
      setError(i18n.t('call.error.dropped'));
      teardown();
    }
  }, [socketStatus, teardown]);

  // A tab being closed mid-call should still let go of the microphone.
  useEffect(() => teardown, [teardown]);

  const startCall = useCallback(async (group) => {
    if (groupRef.current !== null) return;
    setError('');

    // Both before ringing anybody: no point waking a room for a call that
    // cannot carry sound. Only the microphone can refuse — asking for ICE
    // servers falls back rather than fails.
    try {
      await Promise.all([ensureMedia(), ensureIce()]);
    } catch {
      return setError(i18n.t('call.error.micRefusedCalling'));
    }

    groupRef.current = group;
    // Shown as "Calling…" before the server answers, so the button does
    // something the moment it is pressed.
    setCall({ group, self: null, startedBy: null, startedAt: null });
    setPeers([]);

    if (!send({ type: 'call:start', group })) {
      setError(i18n.t('call.error.offlineCalling'));
      teardown();
    }
  }, [ensureMedia, ensureIce, send, teardown]);

  const answer = useCallback(async () => {
    if (!incoming) return;
    setError('');

    try {
      await Promise.all([ensureMedia(), ensureIce()]);
    } catch {
      return setError(i18n.t('call.error.micRefusedAnswering'));
    }

    const { group } = incoming;
    setIncoming(null);
    groupRef.current = group;
    setCall({ group, self: null, startedBy: null, startedAt: null });
    setPeers([]);

    if (!send({ type: 'call:join', group })) {
      setError(i18n.t('call.error.offlineAnswering'));
      teardown();
    }
  }, [incoming, ensureMedia, ensureIce, send, teardown]);

  /** Declining is leaving a call you were never in. The server sees no difference. */
  const decline = useCallback(() => {
    if (!incoming) return;
    send({ type: 'call:leave', group: incoming.group });
    setIncoming(null);
  }, [incoming, send]);

  const hangUp = useCallback(() => {
    const group = groupRef.current;
    if (group !== null) send({ type: 'call:leave', group });
    // Torn down now rather than when the server confirms: a hangup should be
    // instant, and everyone else finds out from the server either way.
    teardown();
  }, [send, teardown]);

  /** Dismisses a failure that outlived the call it was about. */
  const clearError = useCallback(() => setError(''), []);

  const toggleMic = useCallback(() => {
    const stream = localStreamRef.current;
    if (!stream) return;

    setMicOn((on) => {
      for (const track of stream.getAudioTracks()) track.enabled = !on;
      return !on;
    });
  }, []);

  /** What the call looks like from outside: one word for the whole state. */
  const state = useMemo(() => {
    if (!call) return 'idle';
    if (peers.length === 0) return 'ringing';
    return peers.some((peer) => peer.state === 'connected') ? 'talking' : 'connecting';
  }, [call, peers]);

  const value = useMemo(() => ({
    incoming,
    call,
    peers,
    streams,
    state,
    micOn,
    error,
    startCall,
    answer,
    decline,
    hangUp,
    toggleMic,
    clearError,
  }), [
    incoming, call, peers, streams, state, micOn, error,
    startCall, answer, decline, hangUp, toggleMic, clearError,
  ]);

  return <CallContext.Provider value={value}>{children}</CallContext.Provider>;
}
