import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';

import { api, uploadFiles } from '../lib/api';
import { emojiOnly, formatDateTime, userLabel } from '../lib/format';
import { saveMessageEdit, discardUploads, isEdited } from '../lib/messages';
import { scopeOf } from '../lib/permissions';
import Avatar from '../components/Avatar';
import Icon from '../components/Icon';
import ConfirmDialog from '../components/ConfirmDialog';
import EmojiButton from '../components/EmojiButton';
import { useAuth } from '../context/auth';
import { useRealtime } from '../context/realtime';
import { useCall } from '../context/call';
import { AttachmentList, AttachmentDrafts } from '../components/Attachments';

/** Kept in step with FILE_MAX_PER_MESSAGE; the server refuses more regardless. */
const MAX_ATTACHMENTS = 3;

function timeOnly(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

/**
 * The landing screen for everybody, admin or not: groups down the left, the
 * selected group's conversation on the right.
 *
 * There is nothing messenger-specific on the server — this reads the same
 * permission-scoped endpoints the admin panels use. What a session sees is
 * therefore decided entirely by its permissions: `user_groups:read:member`
 * returns the groups you belong to, `user_messages:read:member` everything
 * said in them, and an administrator holding the unscoped pair sees the lot.
 *
 * The list is fetched once. After that, messages arrive on the shared socket
 * as they are written, and the server decides who each one is for — this page
 * never asks again.
 */
export default function MessengerPage() {
  const { t } = useTranslation();
  const { can, user: currentUser } = useAuth();
  const { unread, subscribe, markRead, status } = useRealtime();
  const { startCall, call } = useCall();

  const [groups, setGroups] = useState([]);
  const [users, setUsers] = useState([]);
  const [messages, setMessages] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [draft, setDraft] = useState('');
  const [replyTo, setReplyTo] = useState(null);
  // The message being corrected, if any. The composer serves both jobs: an
  // edit is the same box with the old words already in it.
  const [editing, setEditing] = useState(null);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState('');

  // Files already uploaded and waiting to be sent with the next message. They
  // exist on the server from the moment they are chosen, which is what lets
  // the message itself be one ordinary POST.
  const [attachments, setAttachments] = useState([]);
  const [uploading, setUploading] = useState(false);

  // Starting a conversation, growing one, and walking out of one. Their errors
  // are kept apart from the composer's: none of them is about a message, and a
  // failed invite must not look like a message that did not send.
  const [creating, setCreating] = useState(false);
  const [groupError, setGroupError] = useState('');
  const [inviting, setInviting] = useState(false);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteError, setInviteError] = useState('');
  const [inviteBusy, setInviteBusy] = useState(false);

  /*
   * The question currently being asked, as { title, message, confirmLabel,
   * destructive, run } — or null. One piece of state for all three of them,
   * because only one question can be on screen at a time and each is the same
   * shape: some words, and the thing to do if the answer is yes.
   */
  const [confirming, setConfirming] = useState(null);
  const [confirmBusy, setConfirmBusy] = useState(false);

  const bottomRef = useRef(null);
  const fileInputRef = useRef(null);
  const composerRef = useRef(null);
  /*
   * Whether an invite is already on its way.
   *
   * A ref rather than the `inviteBusy` state beside it, because state does not
   * update until the next render: pressing Enter and clicking Invite in the
   * same tick both read the old `false` and both send. The state is still what
   * disables the button — this is what stops the second request.
   */
  const invitingRef = useRef(false);

  const canReadGroups = can('user_groups:read');
  const canCreateGroups = can('user_groups:create');
  const canReadMessages = can('user_messages:read');
  const canReadUsers = can('users:read');
  const canWrite = can('user_messages:create');
  const canAttach = can('files:create');
  const canEdit = can('user_messages:update');

  /*
   * `?scope=member` on both reads, and it is the whole of what makes this page
   * somebody's own conversations.
   *
   * An administrator holds the unscoped permissions, so without it this screen
   * answered with every group in the installation and everything ever said in
   * one — a moderation view wearing a messenger's clothes, and nobody's actual
   * chats. Reading past your own conversations is the dashboard's job, where it
   * is what somebody went looking for.
   *
   * The server clamps rather than widens (routes/crud.js), so an account that
   * only holds the member- or own-scoped permission is unaffected by asking.
   */
  const loadMessages = useCallback(async () => {
    if (!canReadMessages) return;
    const res = await api('/api/user_messages?scope=member');
    setMessages(res.user_messages);
  }, [canReadMessages]);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const [groupsRes, usersRes] = await Promise.all([
          canReadGroups ? api('/api/user_groups?scope=member') : Promise.resolve({ user_groups: [] }),
          canReadUsers ? api('/api/users') : Promise.resolve({ users: [] }),
        ]);
        if (cancelled) return;
        setGroups(groupsRes.user_groups);
        setUsers(usersRes.users);
        await loadMessages();
      } catch (err) {
        if (!cancelled) setError(err.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [canReadGroups, canReadUsers, loadMessages]);

  // Live messages. The server has already decided this socket may see
  // anything it pushes, so there is nothing to filter here — a frame is either
  // one we have not seen or a newer version of one we have, and an edit should
  // replace the words somebody has already read.
  useEffect(() => subscribe((event) => {
    /*
     * A group of ours has appeared or changed — somebody was invited, somebody
     * left, the owner handed it on. The server sends this only to the people in
     * it, so there is nothing to check: it is either one we already have, in a
     * newer state, or one we have just been added to.
     *
     * A group we have just joined arrives with a conversation already in it, so
     * the messages are fetched again rather than waited for.
     */
    if (event.type === 'group') {
      setGroups((prev) => (
        prev.some((group) => group.id === event.group.id)
          ? prev.map((group) => (group.id === event.group.id ? event.group : group))
          : [...prev, event.group]
      ));
      // Unconditionally rather than only for a group we did not already have:
      // a state updater is no place for a side effect, and a membership change
      // is rare enough that reading the conversation again costs nothing.
      loadMessages().catch(() => {});
      return;
    }

    // Ours no longer: we left it, we were removed, or it is gone entirely. Its
    // messages go with it — we are no longer entitled to any of them.
    if (event.type === 'group-gone') {
      setGroups((prev) => prev.filter((group) => group.id !== event.id));
      setMessages((prev) => prev.filter((message) => message.group !== event.id));
      setSelectedId((prev) => (prev === event.id ? null : prev));
      return;
    }

    if (event.type === 'message-deleted') {
      setMessages((prev) => prev.filter((message) => message.id !== event.id));
      // Nothing may go on pointing at a message that is no longer there.
      setReplyTo((prev) => (prev?.id === event.id ? null : prev));
      setEditing((prev) => (prev?.id === event.id ? null : prev));
      return;
    }

    if (event.type !== 'message') return;
    setMessages((prev) => (
      prev.some((message) => message.id === event.message.id)
        ? prev.map((message) => (message.id === event.message.id ? event.message : message))
        : [...prev, event.message]
    ));
  }), [subscribe, loadMessages]);

  // A group being looked at is a group being read, including messages that
  // land while it is open.
  useEffect(() => {
    if (selectedId !== null && unread.groups?.[selectedId]) markRead(selectedId);
  }, [selectedId, unread.groups, markRead]);

  const usersById = useMemo(() => new Map(users.map((user) => [user.id, user])), [users]);
  const messagesById = useMemo(
    () => new Map(messages.map((message) => [message.id, message])),
    [messages]
  );

  /**
   * The face for a conversation: the other person's, when there is exactly one
   * of them. A group of several has no one picture to stand for it, so it keeps
   * its initials.
   */
  const groupLogo = useCallback((group) => {
    const others = group.members.filter((member) => member.id !== currentUser?.id);
    if (others.length !== 1) return null;
    // Preferring the users list keeps the picture current: a group's member rows
    // are only as fresh as the last time the group itself was fetched.
    return usersById.get(others[0].id)?.picture || others[0].picture || null;
  }, [currentUser, usersById]);

  /**
   * A group reads as who is in it — there is no name to give one.
   *
   * Two names, then a count. Never the row's id: "Group #7" tells the reader
   * nothing they were looking for, and a conversation they are actually in can
   * always be described by the people in it.
   */
  const NAMES_SHOWN = 2;

  const groupTitle = useCallback((group) => {
    const others = group.members.filter((member) => member.id !== currentUser?.id);

    // Nobody else in it. Either they are alone in a group of their own, or an
    // administrator is reading one that has been emptied.
    if (others.length === 0) {
      return group.members.length === 0
        ? t('messenger.emptyGroup')
        : t('messenger.justYou');
    }

    const names = others.map((member) => userLabel(member, member.id));
    if (names.length <= NAMES_SHOWN) return names.join(', ');

    return t('messenger.andMorePeople', {
      names: names.slice(0, NAMES_SHOWN).join(', '),
      count: names.length - NAMES_SHOWN,
    });
  }, [currentUser, t]);

  const messagesByGroup = useMemo(() => {
    const grouped = new Map();
    for (const message of messages) {
      if (!grouped.has(message.group)) grouped.set(message.group, []);
      grouped.get(message.group).push(message);
    }
    return grouped;
  }, [messages]);

  const conversation = useMemo(
    () => (selectedId === null ? [] : messagesByGroup.get(selectedId) || []),
    [messagesByGroup, selectedId]
  );

  /**
   * The composer is as tall as what is in it.
   *
   * A textarea does not grow on its own: it keeps the height it was given and
   * scrolls, so a long message becomes a two-line window over the paragraph
   * somebody is still writing. Measuring is the only way — the height a wrapped
   * line needs is not knowable without laying it out.
   *
   * `height: auto` first, and it is not redundant: scrollHeight reports the
   * content height *or* the box height, whichever is larger, so a box that has
   * already grown would keep reporting its old height and never shrink back.
   *
   * Where it stops is CSS's business (max-height on .composer-row textarea) —
   * a pasted essay makes the field scroll rather than eating the conversation.
   */
  const resizeComposer = useCallback(() => {
    const field = composerRef.current;
    if (!field) return;
    field.style.height = 'auto';
    field.style.height = `${field.scrollHeight}px`;
  }, []);

  // Whatever changed the text: typing, sending (which empties it), starting an
  // edit (which fills it with the old words), or an emoji dropped in mid-line.
  useEffect(resizeComposer, [draft, resizeComposer]);

  // A narrower window rewraps the same text onto more lines, and the height
  // measured for the old width is then wrong.
  useEffect(() => {
    window.addEventListener('resize', resizeComposer);
    return () => window.removeEventListener('resize', resizeComposer);
  }, [resizeComposer]);

  // Stay pinned to the newest message, as a messenger does.
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [conversation.length, selectedId]);

  const selectedGroup = groups.find((group) => group.id === selectedId) || null;

  // The server rings a group's members, so only a member has anyone to call —
  // an administrator reading a conversation they are not part of does not.
  const inThisGroup = Boolean(
    selectedGroup?.members.some((member) => member.id === currentUser?.id)
  );

  /*
   * Ending it is the owner's decision. Read through the granted scope rather
   * than from `can()` alone, so the button is offered only where it would
   * actually succeed: an own-scoped account sees it on the group it owns, and
   * an administrator holding the unscoped permission sees it anywhere.
   */
  const deleteScope = scopeOf(currentUser?.permissions, 'user_groups:delete');
  const ownsThisGroup = Number(selectedGroup?.owner) === Number(currentUser?.id);
  const canDeleteGroup = selectedGroup !== null
    && (deleteScope === 'any' || (deleteScope === 'own' && ownsThisGroup));

  const openGroup = (group) => {
    setSelectedId(group.id);
    setReplyTo(null);
    setSendError('');
    setGroupError('');
    markRead(group.id);
  };

  /**
   * Starts a conversation, which begins as a group of one: the server puts the
   * caller in it and refuses to take a member list from an ordinary account.
   *
   * So it opens the invite box straight away. A group with nobody else in it is
   * not yet a conversation, and the next thing to do with one is always to say
   * who it is with.
   */
  const handleNewGroup = async () => {
    setGroupError('');
    setCreating(true);
    try {
      const res = await api('/api/user_groups', {
        method: 'POST',
        // Sent explicitly for an unscoped caller (an admin starting one of
        // their own); an own-scoped session has it pinned by the server anyway.
        body: { owner: currentUser.id },
      });
      setGroups((prev) => (
        prev.some((group) => group.id === res.user_group.id)
          ? prev
          : [...prev, res.user_group]
      ));
      setSelectedId(res.user_group.id);
      setInviteEmail('');
      setInviteError('');
      setInviting(true);
    } catch (err) {
      setGroupError(err.message);
    } finally {
      setCreating(false);
    }
  };

  /**
   * Adds somebody by their address — the exact one, because that is the whole
   * of the invitation: you can only bring in someone whose address you already
   * have. There is no list to pick from and no id to guess at.
   */
  const handleInvite = async (e) => {
    e.preventDefault();
    if (!inviteEmail.trim() || invitingRef.current || selectedId === null) return;

    invitingRef.current = true;
    setInviteBusy(true);
    setInviteError('');
    try {
      const res = await api(`/api/messenger/groups/${selectedId}/invite`, {
        method: 'POST',
        body: { email: inviteEmail.trim() },
      });
      // Ours is updated here; the invitee's tab, and everybody else's, hears
      // about it over the socket.
      setGroups((prev) => prev.map((group) => (
        group.id === res.user_group.id ? res.user_group : group
      )));
      setInviting(false);
      setInviteEmail('');
    } catch (err) {
      setInviteError(err.message);
    } finally {
      invitingRef.current = false;
      setInviteBusy(false);
    }
  };

  /**
   * Walks out. Whether the group survives is the server's to decide — it goes
   * if leaving would leave one person in it — so the answer says which happened
   * and neither outcome leaves it on screen.
   */
  /**
   * Ending a conversation for everybody in it, which is the owner's to do and
   * nobody else's. Distinct from leaving on purpose: people drifting out of a
   * group never destroys it, so throwing it away has to be said out loud.
   */
  const handleDeleteGroup = async (group) => {
    setGroupError('');
    try {
      await api(`/api/user_groups/${group.id}`, { method: 'DELETE' });
      setGroups((prev) => prev.filter((row) => row.id !== group.id));
      setMessages((prev) => prev.filter((message) => message.group !== group.id));
      setSelectedId((prev) => (prev === group.id ? null : prev));
    } catch (err) {
      setGroupError(err.message);
    }
  };

  const handleLeave = async (group) => {
    setGroupError('');
    try {
      await api(`/api/messenger/groups/${group.id}/leave`, { method: 'POST' });
      setGroups((prev) => prev.filter((row) => row.id !== group.id));
      setMessages((prev) => prev.filter((message) => message.group !== group.id));
      setSelectedId((prev) => (prev === group.id ? null : prev));
    } catch (err) {
      setGroupError(err.message);
    }
  };

  /**
   * Uploads as soon as files are chosen, rather than when the message is sent.
   * The wait belongs where the person is still typing, not after they have
   * pressed Send — and it means a failure is reported while there is still a
   * draft to attach something else to.
   */
  const handleAttach = async (e) => {
    const chosen = [...e.target.files];
    // The input is cleared straight away so picking the same file twice in a
    // row still fires a change event.
    e.target.value = '';
    if (chosen.length === 0) return;

    if (attachments.length + chosen.length > MAX_ATTACHMENTS) {
      setSendError(t('messenger.tooManyFiles', { count: MAX_ATTACHMENTS }));
      return;
    }

    setUploading(true);
    setSendError('');
    try {
      const uploaded = await uploadFiles(chosen);
      setAttachments((prev) => [...prev, ...uploaded]);
    } catch (err) {
      setSendError(err.message);
    } finally {
      setUploading(false);
    }
  };

  /**
   * Unsending an attachment.
   *
   * On a draft the file was uploaded for this message and nothing else, so it
   * goes now. While editing, it is still on the message until the edit is
   * saved — deleting it here would destroy it even if the edit were then
   * abandoned, so removal is staged and saveMessageEdit does the deleting.
   */
  const handleUnattach = async (file) => {
    setAttachments((prev) => prev.filter((row) => row.id !== file.id));

    const wasAlreadyOnTheMessage = (editing?.files || []).some((row) => row.id === file.id);
    if (wasAlreadyOnTheMessage) return;

    try {
      await api(`/api/files/${file.id}`, { method: 'DELETE' });
    } catch {
      // Left behind rather than reported: the sweep collects anything that
      // ends up attached to nothing, and this is not worth a message about.
    }
  };

  /**
   * Drops an emoji where the caret is, rather than at the end — somebody who
   * has gone back to fix a word expects it to land there.
   */
  const insertEmoji = (emoji) => {
    const field = composerRef.current;
    if (!field) {
      setDraft((prev) => prev + emoji);
      return;
    }

    const start = field.selectionStart ?? draft.length;
    const end = field.selectionEnd ?? draft.length;
    setDraft(draft.slice(0, start) + emoji + draft.slice(end));

    // After React has painted the new value, or the caret would be placed in
    // the old one and then overwritten.
    requestAnimationFrame(() => {
      const caret = start + emoji.length;
      field.focus();
      field.setSelectionRange(caret, caret);
    });
  };

  const startEdit = (message) => {
    setEditing(message);
    setDraft(message.value.trim());
    setAttachments(message.files || []);
    setReplyTo(null);
    setSendError('');
  };

  /** Abandons an edit, taking anything uploaded during it with it. */
  const cancelEdit = () => {
    const original = new Set((editing?.files || []).map((file) => file.id));
    const added = attachments.filter((file) => !original.has(file.id));

    setEditing(null);
    setDraft('');
    setAttachments([]);
    setSendError('');

    discardUploads(added);
  };

  /**
   * Leaving, which is two different questions wearing one button.
   *
   * With somebody else still in the group it is reversible in every way that
   * matters — they can invite you back. Alone in it, leaving is the delete: the
   * group goes, and saying "you will stop seeing it" would be true and
   * misleading at once.
   */
  const askToLeave = (group) => {
    const last = group.members.length <= 1;
    setConfirming({
      title: t('messenger.confirm.leaveTitle'),
      message: t(last ? 'messenger.confirm.leaveLastBody' : 'messenger.confirm.leaveBody'),
      confirmLabel: t('messenger.confirm.leaveConfirm'),
      destructive: last,
      run: () => handleLeave(group),
    });
  };

  const askToDeleteGroup = (group) => setConfirming({
    title: t('messenger.confirm.deleteGroupTitle'),
    message: t('messenger.confirm.deleteGroupBody'),
    confirmLabel: t('common.delete'),
    destructive: true,
    run: () => handleDeleteGroup(group),
  });

  const askToDeleteMessage = (message) => setConfirming({
    title: t('messenger.confirm.deleteMessageTitle'),
    message: t('messenger.confirm.deleteMessageBody'),
    confirmLabel: t('common.delete'),
    destructive: true,
    run: () => handleDelete(message),
  });

  const handleSend = async (e) => {
    e.preventDefault();
    // A message may be nothing but attachments, but it cannot be nothing.
    if ((!draft.trim() && attachments.length === 0) || sending || uploading) return;

    setSending(true);
    setSendError('');

    if (editing) {
      try {
        const saved = await saveMessageEdit(editing, { value: draft, files: attachments });
        // Ours is updated here; everybody else's arrives over the socket.
        setMessages((prev) => prev.map((m) => (m.id === saved.id ? saved : m)));
        setEditing(null);
        setDraft('');
        setAttachments([]);
      } catch (err) {
        setSendError(err.message);
      } finally {
        setSending(false);
      }
      return;
    }

    try {
      await api('/api/user_messages', {
        method: 'POST',
        body: {
          // Sent explicitly for an unscoped author (an admin writing as
          // themselves); a member-scoped session has it pinned by the server
          // either way.
          owner: currentUser.id,
          group: selectedId,
          value: draft.trim() || ' ',
          files: attachments.map((file) => file.id),
          ...(replyTo ? { reply_to: replyTo.id } : {}),
        },
      });
      setDraft('');
      setReplyTo(null);
      setAttachments([]);
      // The socket delivers this back to everyone including us, but a sender
      // should never be left waiting on the network to see their own words.
      await loadMessages();
    } catch (err) {
      setSendError(err.message);
    } finally {
      setSending(false);
    }
  };

  const handleDelete = async (message) => {
    try {
      await api(`/api/user_messages/${message.id}`, { method: 'DELETE' });
      await loadMessages();
    } catch (err) {
      setSendError(err.message);
    }
  };

  // Enter sends, shift+enter starts a new line.
  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend(e);
    }
  };

  if (loading) return <div className="loading-state">{t('messenger.loading')}</div>;
  if (error) {
    return (
      <div className="error-banner">
        <Icon name="error" filled /> {error}
      </div>
    );
  }

  if (!canReadGroups) {
    return (
      <div className="messenger-empty standalone">
        <h2>{t('messenger.nothingYet')}</h2>
        <p className="subtitle">{t('messenger.noGroupsForAccount')}</p>
      </div>
    );
  }

  return (
    <div className="messenger">
      <aside className="messenger-sidebar">
        <div className="messenger-sidebar-header">
          <h2>{t('nav.chats')}</h2>
          {canCreateGroups && (
            <button
              type="button"
              className="btn btn-new-chat"
              onClick={handleNewGroup}
              disabled={creating}
              title={t('messenger.newChat')}
            >
              <Icon name="add" label={t('messenger.newChat')} />
            </button>
          )}
        </div>

        {groupError && <div className="modal-error sidebar-error">{groupError}</div>}

        {groups.length === 0 ? (
          <p className="messenger-sidebar-empty">
            {t(canCreateGroups ? 'messenger.empty' : 'messenger.notInAnyGroup')}
          </p>
        ) : (
          <ul className="chat-list">
            {groups.map((group) => {
              const thread = messagesByGroup.get(group.id) || [];
              const last = thread[thread.length - 1];
              const title = groupTitle(group);
              const pending = unread.groups?.[group.id] || 0;

              return (
                <li key={group.id}>
                  <button
                    type="button"
                    className={[
                      'chat-item',
                      group.id === selectedId ? 'active' : '',
                      // Outlined until it has been looked at.
                      pending > 0 ? 'unread' : '',
                    ].filter(Boolean).join(' ')}
                    onClick={() => openGroup(group)}
                    aria-current={group.id === selectedId}
                  >
                    <Avatar logo={groupLogo(group)} name={title} />
                    <span className="chat-item-body">
                      <span className="chat-item-top">
                        <span className="chat-title">{title}</span>
                        <span className="chat-time">{last ? timeOnly(last.created_at) : ''}</span>
                      </span>
                      <span className="chat-item-bottom">
                        <span className="chat-preview">
                          {last
                            ? `${last.owner === currentUser?.id && !last.system
                              ? t('messenger.youPrefix') : ''}${last.value}`
                            : t('messenger.noMessagesYet')}
                        </span>
                        {pending > 0 && (
                          <span className="chat-badge" aria-label={`${pending} new`}>
                            {pending}
                          </span>
                        )}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </aside>

      <section className="messenger-thread">
        {!selectedGroup ? (
          <div className="messenger-empty">
            <Icon className="empty-icon" name="forum" />
            <p className="subtitle">
              {groups.length === 0
                ? t('messenger.onceAdded')
                : t('messenger.selectOne')}
            </p>
          </div>
        ) : (
          <>
            <header className="thread-header">
              <div>
                <h3>{groupTitle(selectedGroup)}</h3>
                <p className="thread-subtitle">
                  {t('messenger.memberCount', { count: selectedGroup.members.length })}
                  {' · '}
                  {/* Your own name read back at you is the one thing this line
                      must not say. The group title already speaks this way —
                      "Just you" rather than your name — and after the owner
                      leaves, the person the group has been handed to is very
                      often the person reading. */}
                  {Number(selectedGroup.owner) === Number(currentUser?.id)
                    ? t('messenger.ownedByYou')
                    : t('messenger.ownedBy', {
                      name: userLabel(usersById.get(selectedGroup.owner), selectedGroup.owner),
                    })}
                </p>
              </div>

              <div className="thread-actions">
                {/* Both are membership rather than permission: only somebody in
                    a group may bring anyone into it or take themselves out. An
                    administrator reading a conversation they are not part of has
                    the dashboard for changing who is in it. */}
                {inThisGroup && (
                  <>
                    <button
                      type="button"
                      className="btn btn-invite"
                      onClick={() => {
                        setInviteEmail('');
                        setInviteError('');
                        setInviting(true);
                      }}
                      title={t('messenger.inviteTooltip')}
                    >
                      <Icon name="group" /> {t('messenger.invite')}
                    </button>
                    <button
                      type="button"
                      className="btn btn-leave"
                      onClick={() => askToLeave(selectedGroup)}
                      title={t(selectedGroup.members.length === 1
                        ? 'messenger.leaveLastTooltip'
                        : 'messenger.leaveTooltip')}
                    >
                      <Icon name="logout" /> {t('messenger.leave')}
                    </button>
                  </>
                )}

                {canDeleteGroup && (
                  <button
                    type="button"
                    className="btn btn-leave delete"
                    onClick={() => askToDeleteGroup(selectedGroup)}
                    title={t('messenger.deleteGroupTooltip')}
                  >
                    <Icon name="delete" /> {t('messenger.deleteGroup')}
                  </button>
                )}

                {/* One press rings every open tab of every member. */}
                <button
                  type="button"
                  className="btn btn-call"
                  onClick={() => startCall(selectedGroup.id)}
                  disabled={call !== null || status !== 'online' || !inThisGroup}
                  title={
                    !inThisGroup
                      ? t('messenger.callNotMember')
                      : status !== 'online'
                        ? t('messenger.callOffline')
                        : call !== null
                          ? t('messenger.callBusy')
                          : t('messenger.callEveryone')
                  }
                >
                  <Icon name="call" filled />
                  {' '}{t(call?.group === selectedGroup.id ? 'messenger.inCall' : 'messenger.call')}
                </button>
              </div>
            </header>

            <div className="thread-body">
              {!canReadMessages ? (
                <p className="no-perm">{t('messenger.cannotRead')}</p>
              ) : conversation.length === 0 ? (
                <p className="no-perm">{t('messenger.saySomething')}</p>
              ) : (
                conversation.map((message) => {
                  /*
                   * Written by the application, about somebody rather than by
                   * them: "so-and-so left the group". It is an ordinary row —
                   * that is what gets it delivered live and counted as unread —
                   * but it is not a remark, so it gets no bubble, no face, and
                   * nothing to reply to or edit.
                   */
                  if (message.system) {
                    return (
                      <p key={message.id} className="thread-notice">
                        <Icon name="logout" />
                        {' '}{message.value}{' '}
                        <time
                          dateTime={message.created_at}
                          title={formatDateTime(message.created_at)}
                        >
                          {timeOnly(message.created_at)}
                        </time>
                      </p>
                    );
                  }

                  const mine = message.owner === currentUser?.id;
                  const author = usersById.get(message.owner);
                  const parent = message.reply_to != null
                    ? messagesById.get(message.reply_to)
                    : null;

                  return (
                    <article key={message.id} className={`bubble-row${mine ? ' mine' : ''}`}>
                      {/* Only on other people's messages: a column of your own
                          face down the side of your own words says nothing. */}
                      {!mine && (
                        <Avatar
                          className="bubble-avatar"
                          logo={author?.picture}
                          name={userLabel(author, message.owner)}
                        />
                      )}
                      <div className="bubble">
                        {!mine && (
                          <div className="bubble-author">{userLabel(author, message.owner)}</div>
                        )}

                        {message.reply_to != null && (
                          <div className="bubble-reply">
                            <Icon name="reply" /> {parent
                              ? `${userLabel(usersById.get(parent.owner), parent.owner)}: ${
                                parent.value.length > 60
                                  ? `${parent.value.slice(0, 60)}…`
                                  : parent.value}`
                              : `message #${message.reply_to}`}
                          </div>
                        )}

                        {/* A message may be nothing but its attachments; the
                            server needs a value, so a blank one is a space. */}
                        {message.value.trim() && (
                          <div
                            className={
                              emojiOnly(message.value) ? 'bubble-text jumbo' : 'bubble-text'
                            }
                          >
                            {message.value}
                          </div>
                        )}

                        <AttachmentList files={message.files} />

                        <div className="bubble-meta">
                          <time
                            dateTime={message.created_at}
                            title={formatDateTime(message.created_at)}
                          >
                            {timeOnly(message.created_at)}
                          </time>
                          {isEdited(message) && (
                            <span
                              className="bubble-edited"
                              title={t('messenger.editedAt', {
                                when: formatDateTime(message.updated_at),
                              })}
                            >
                              {t('messenger.edited')}
                            </span>
                          )}
                          {canWrite && (
                            <button type="button" onClick={() => setReplyTo(message)}>
                              {t('messenger.reply')}
                            </button>
                          )}
                          {/* Your own words only. An administrator who may
                              rewrite anybody's does it from the dashboard,
                              where the change is deliberate rather than a
                              button beside a conversation. */}
                          {mine && canEdit && (
                            <button type="button" onClick={() => startEdit(message)}>
                              {t('common.edit')}
                            </button>
                          )}
                          {can('user_messages:delete') && (
                            <button type="button" onClick={() => askToDeleteMessage(message)}>
                              {t('common.delete')}
                            </button>
                          )}
                        </div>
                      </div>
                    </article>
                  );
                })
              )}
              <div ref={bottomRef} />
            </div>

            {canWrite ? (
              <form className="composer" onSubmit={handleSend}>
                {editing && (
                  <div className="composer-reply editing">
                    <span><Icon name="edit" /> {t('messenger.editingYours')}</span>
                    <button type="button" onClick={cancelEdit} aria-label={t('messenger.stopEditing')}>
                      <Icon name="close" />
                    </button>
                  </div>
                )}

                {replyTo && (
                  <div className="composer-reply">
                    <span>
                      <Icon name="reply" /> {t('messenger.replyingTo')}{' '}
                      {userLabel(usersById.get(replyTo.owner), replyTo.owner)}:{' '}
                      “{replyTo.value.length > 70
                        ? `${replyTo.value.slice(0, 70)}…`
                        : replyTo.value}”
                    </span>
                    <button type="button" onClick={() => setReplyTo(null)} aria-label={t('messenger.cancelReply')}>
                      <Icon name="close" />
                    </button>
                  </div>
                )}

                {sendError && <div className="modal-error">{sendError}</div>}

                <AttachmentDrafts
                  files={attachments}
                  uploading={uploading}
                  onRemove={handleUnattach}
                />

                <div className="composer-row">
                  {canAttach && (
                    <>
                      <input
                        ref={fileInputRef}
                        type="file"
                        multiple
                        hidden
                        onChange={handleAttach}
                      />
                      <button
                        type="button"
                        className="btn btn-attach"
                        onClick={() => fileInputRef.current?.click()}
                        disabled={uploading || attachments.length >= MAX_ATTACHMENTS}
                        title={
                          attachments.length >= MAX_ATTACHMENTS
                            ? t('messenger.tooManyFiles', { count: MAX_ATTACHMENTS })
                            : t('messenger.attach')
                        }
                        aria-label={t('messenger.attach')}
                      >
                        <Icon name="attach_file" />
                      </button>
                    </>
                  )}

                  <EmojiButton onPick={insertEmoji} disabled={sending} />

                  <textarea
                    ref={composerRef}
                    rows={1}
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder={t(editing ? 'messenger.editPlaceholder' : 'messenger.writePlaceholder')}
                    aria-label={t('messenger.messageLabel')}
                  />
                  <button
                    type="submit"
                    className="btn btn-primary"
                    disabled={(!draft.trim() && attachments.length === 0) || sending || uploading}
                  >
                    {sending
                      ? t(editing ? 'common.saving' : 'messenger.sending')
                      : t(editing ? 'common.save' : 'messenger.send')}
                  </button>
                </div>
              </form>
            ) : (
              <p className="composer-readonly no-perm">{t('messenger.readOnly')}</p>
            )}
          </>
        )}
      </section>

      {inviting && selectedGroup && (
        <div className="modal-overlay">
          <div className="modal-content">
            <div className="modal-header">
              <h3>{t('messenger.inviteHeading')}</h3>
              <button
                type="button"
                className="close-btn"
                onClick={() => setInviting(false)}
                aria-label={t('common.close')}
              >
                <Icon name="close" />
              </button>
            </div>

            {inviteError && <div className="modal-error">{inviteError}</div>}

            <form onSubmit={handleInvite}>
              <div className="form-group">
                <label htmlFor="invite-email">{t('messenger.inviteEmail')}</label>
                <input
                  id="invite-email"
                  type="email"
                  required
                  autoFocus
                  value={inviteEmail}
                  onChange={(e) => setInviteEmail(e.target.value)}
                  placeholder={t('messenger.invitePlaceholder')}
                />
                <small className="optional">{t('messenger.inviteHint')}</small>
              </div>

              <div className="modal-footer">
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => setInviting(false)}
                >
                  {t('common.cancel')}
                </button>
                <button
                  type="submit"
                  className="btn btn-primary"
                  disabled={!inviteEmail.trim() || inviteBusy}
                >
                  {inviteBusy ? t('messenger.inviting') : t('messenger.inviteSubmit')}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {confirming && (
        <ConfirmDialog
          title={confirming.title}
          message={confirming.message}
          confirmLabel={confirming.confirmLabel}
          destructive={confirming.destructive}
          busy={confirmBusy}
          onCancel={() => setConfirming(null)}
          onConfirm={async () => {
            setConfirmBusy(true);
            try {
              await confirming.run();
            } finally {
              // Closed either way: the handlers report their own failures, and
              // a question left on screen over an error reads as unanswered.
              setConfirmBusy(false);
              setConfirming(null);
            }
          }}
        />
      )}
    </div>
  );
}
