import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import { api, uploadFiles } from '../lib/api';
import { formatDateTime, userLabel } from '../lib/format';
import { saveMessageEdit, discardUploads, isEdited } from '../lib/messages';
import { useAuth } from '../context/auth';
import { AttachmentList, AttachmentDrafts } from '../components/Attachments';
import Icon from '../components/Icon';
import Pagination from '../components/Pagination';
import { usePagination } from '../lib/pagination';
import ConfirmDialog from '../components/ConfirmDialog';

const EMPTY_FORM = { owner: '', group: '', value: '', reply_to: null };

/** A message shortened to something that fits on one line. */
function preview(value, length = 70) {
  return value.length > length ? `${value.slice(0, length)}…` : value;
}

/**
 * A group as a line in a picker: which row, whose it is, and how many people
 * are in it.
 *
 * The id is kept here, unlike in the messenger — this is a table of rows, every
 * other column in it is addressed by `#id`, and an administrator picking a
 * group out of a list of similar ones needs to know which row they picked.
 */
function groupLabel(t, group, usersById) {
  if (!group) return '—';
  const owner = usersById.get(group.owner);
  return t('panels.messages.groupLabel', {
    id: group.id,
    owner: owner ? userLabel(owner, group.owner) : `#${group.owner}`,
    count: group.members.length,
  });
}

/**
 * Messages as what was said, by whom, and where. Authors and groups are
 * resolved to names wherever the caller may read them, and the composer only
 * offers choices the server would actually accept from this session.
 */
export default function UserMessagesPanel() {
  const { t } = useTranslation();
  const [confirming, setConfirming] = useState(null);
  const { can, scope, user: currentUser } = useAuth();

  const [messages, setMessages] = useState([]);
  const [groups, setGroups] = useState([]);
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [searchTerm, setSearchTerm] = useState('');
  const [groupFilter, setGroupFilter] = useState('all');
  const [authorFilter, setAuthorFilter] = useState('all');
  const [kindFilter, setKindFilter] = useState('all');

  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingMessage, setEditingMessage] = useState(null);
  const [formData, setFormData] = useState(EMPTY_FORM);
  const [formError, setFormError] = useState('');

  // The attachments an edit will save. Removing one here stages the removal;
  // saveMessageEdit deletes what the message no longer carries, so abandoning
  // the edit leaves the file exactly where it was.
  const [attachments, setAttachments] = useState([]);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef(null);

  const canReadUsers = can('users:read');
  const canReadGroups = can('user_groups:read');
  // An own-scoped author writes as themselves whatever the form says.
  const authorIsFixed = scope('user_messages:create') === 'own';

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [messagesRes, groupsRes, usersRes] = await Promise.all([
        api('/api/user_messages'),
        canReadGroups ? api('/api/user_groups') : Promise.resolve({ user_groups: [] }),
        canReadUsers ? api('/api/users') : Promise.resolve({ users: [] }),
      ]);
      setMessages(messagesRes.user_messages);
      setGroups(groupsRes.user_groups);
      setUsers(usersRes.users);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [canReadGroups, canReadUsers]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const usersById = useMemo(() => new Map(users.map((user) => [user.id, user])), [users]);
  const groupsById = useMemo(() => new Map(groups.map((group) => [group.id, group])), [groups]);
  const messagesById = useMemo(
    () => new Map(messages.map((message) => [message.id, message])),
    [messages]
  );

  const openCreate = () => {
    setEditingMessage(null);
    setFormData({
      ...EMPTY_FORM,
      owner: currentUser?.id ?? '',
      // One group to choose from is not a choice; save the click.
      group: groups.length === 1 ? groups[0].id : '',
    });
    setFormError('');
    setIsModalOpen(true);
  };

  /** Compose an answer to `message` — same group, and pointed back at it. */
  const openReply = (message) => {
    setEditingMessage(null);
    setFormData({
      ...EMPTY_FORM,
      owner: currentUser?.id ?? '',
      group: message.group,
      reply_to: message.id,
    });
    setFormError('');
    setIsModalOpen(true);
  };

  const openEdit = (message) => {
    setEditingMessage(message);
    setFormData({
      owner: message.owner,
      group: message.group,
      value: message.value,
      reply_to: message.reply_to,
    });
    setAttachments(message.files || []);
    setFormError('');
    setIsModalOpen(true);
  };

  /** Closes the form, deleting anything uploaded into an edit that was abandoned. */
  const closeModal = () => {
    if (editingMessage) {
      const original = new Set((editingMessage.files || []).map((file) => file.id));
      discardUploads(attachments.filter((file) => !original.has(file.id)));
    }
    setIsModalOpen(false);
    setAttachments([]);
  };

  const handleAttach = async (e) => {
    const chosen = [...e.target.files];
    e.target.value = '';
    if (chosen.length === 0) return;

    setUploading(true);
    setFormError('');
    try {
      const uploaded = await uploadFiles(chosen);
      setAttachments((prev) => [...prev, ...uploaded]);
    } catch (err) {
      setFormError(err.message);
    } finally {
      setUploading(false);
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setFormError('');

    try {
      if (editingMessage) {
        // The body and its attachments are the only things an edit is for;
        // moving a message to another author, group or parent would rewrite
        // history rather than correct it.
        await saveMessageEdit(editingMessage, { value: formData.value, files: attachments });
      } else {
        await api('/api/user_messages', {
          method: 'POST',
          body: {
            owner: authorIsFixed ? currentUser.id : Number(formData.owner),
            group: Number(formData.group),
            value: formData.value,
            ...(formData.reply_to ? { reply_to: formData.reply_to } : {}),
          },
        });
      }

      setIsModalOpen(false);
      setAttachments([]);
      loadData();
    } catch (err) {
      setFormError(err.message);
    }
  };

  const handleDelete = async (message) => {
    try {
      await api(`/api/user_messages/${message.id}`, { method: 'DELETE' });
      loadData();
    } catch (err) {
      setError(err.message);
    }
  };

  /**
   * Two sentences, and the second only when there is something to warn about:
   * a reply outlives the message it answered (reply_to is SET NULL), so
   * deleting one that has been answered strands the answers.
   */
  const askToDelete = (message) => {
    const replies = messages.filter((other) => other.reply_to === message.id).length;
    setConfirming({
      message: [
        t('panels.messages.confirmDelete', { preview: preview(message.value, 60) }),
        replies > 0 ? t('panels.messages.confirmDeleteReplies', { count: replies }) : '',
      ].filter(Boolean).join(' '),
      run: () => handleDelete(message),
    });
  };

  // Only groups the message list or the group list actually mentions.
  const groupOptions = useMemo(() => {
    const ids = [...new Set([...groups.map((g) => g.id), ...messages.map((m) => m.group)])];
    return ids.sort((a, b) => a - b);
  }, [groups, messages]);

  /* Only the people who have written something — every account would mostly be
     authors with nothing behind them. */
  const authorOptions = useMemo(
    () => [...new Set(messages.map((message) => message.owner))].sort((a, b) => a - b),
    [messages]
  );

  const visibleMessages = messages.filter((message) => {
    const author = userLabel(usersById.get(message.owner), message.owner);
    const haystack = `${message.value} ${author}`.toLowerCase();
    const matchesSearch = haystack.includes(searchTerm.toLowerCase());
    const matchesGroup = groupFilter === 'all' || message.group === Number(groupFilter);
    const matchesAuthor = authorFilter === 'all' || message.owner === Number(authorFilter);
    /*
     * Notices the application wrote about itself — "so-and-so left the group" —
     * against remarks people made. Worth separating: reading a conversation
     * means the second kind, and auditing what the server did means the first.
     */
    const matchesKind = kindFilter === 'all'
      || (kindFilter === 'system' ? Boolean(message.system) : !message.system);
    return matchesSearch && matchesGroup && matchesAuthor && matchesKind;
  });

  const page = usePagination(visibleMessages);

  if (loading) return <div className="loading-state">{t('panels.messages.loading')}</div>;
  if (error) {
    return (
      <div className="error-banner">
        <Icon name="error" filled /> {error}
      </div>
    );
  }

  const canCompose = can('user_messages:create') && (canReadGroups ? groups.length > 0 : true);

  return (
    <div>
      <div className="panel-toolbar">
        <div className="metrics-row">
          <div className="metric-box">
            <div className="metric-value">{messages.length}</div>
            <div className="metric-label">{t('panels.messages.total')}</div>
          </div>
          <div className="metric-box">
            <div className="metric-value">
              {new Set(messages.map((message) => message.group)).size}
            </div>
            <div className="metric-label">{t('panels.messages.activeGroups')}</div>
          </div>
          <div className="metric-box">
            <div className="metric-value">
              {new Set(messages.map((message) => message.owner)).size}
            </div>
            <div className="metric-label">{t('panels.messages.authors')}</div>
          </div>
        </div>
        {can('user_messages:create') && (
          <button onClick={openCreate} className="btn btn-primary" disabled={!canCompose}>
            {t('panels.messages.new')}
          </button>
        )}
      </div>

      {can('user_messages:create') && canReadGroups && groups.length === 0 && (
        <p className="subtitle">{t('panels.messages.noGroupYet')}</p>
      )}

      <div className="filters-bar">
        <label className="search-field">
          <Icon name="search" />
          <input
            type="text"
            placeholder={t('panels.messages.searchPlaceholder')}
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="search-input"
          />
        </label>
        <select
          value={groupFilter}
          onChange={(e) => setGroupFilter(e.target.value)}
          className="role-select"
        >
          <option value="all">{t('panels.messages.allGroups')}</option>
          {groupOptions.map((id) => (
            <option key={id} value={id}>
              {groupsById.has(id)
                ? groupLabel(t, groupsById.get(id), usersById)
                : t('panels.messages.groupRow', { id })}
            </option>
          ))}
        </select>
        <select
          value={authorFilter}
          onChange={(e) => setAuthorFilter(e.target.value)}
          className="role-select"
        >
          <option value="all">{t('panels.messages.allAuthors')}</option>
          {/* Only the people who have actually written something: a list of
              every account would mostly be authors with nothing to show. */}
          {authorOptions.map((id) => (
            <option key={id} value={id}>
              {userLabel(usersById.get(id), id)}
            </option>
          ))}
        </select>
        <select
          value={kindFilter}
          onChange={(e) => setKindFilter(e.target.value)}
          className="role-select"
        >
          <option value="all">{t('panels.messages.allKinds')}</option>
          <option value="said">{t('panels.messages.kindSaid')}</option>
          <option value="system">{t('panels.messages.kindSystem')}</option>
        </select>
      </div>

      <div className="table-responsive">
        <table className="users-table">
          <thead>
            <tr>
              <th>{t('common.id')}</th>
              <th>{t('panels.messages.author')}</th>
              <th>{t('panels.messages.group')}</th>
              <th>{t('panels.messages.message')}</th>
              <th>{t('panels.messages.sent')}</th>
              <th>{t('panels.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {visibleMessages.length === 0 ? (
              <tr><td colSpan="6" className="empty-state">{t('panels.messages.noMatches')}</td></tr>
            ) : (
              page.visible.map((message) => {
                const author = usersById.get(message.owner);
                return (
                  <tr key={message.id}>
                    <td>#{message.id}</td>
                    <td>
                      <div className="user-name">
                        {userLabel(author, message.owner)}
                        {message.owner === currentUser?.id && (
                          <span className="badge system-badge">you</span>
                        )}
                      </div>
                      {author?.email && <div className="user-email">{author.email}</div>}
                    </td>
                    <td>
                      <span className="perm-tag">#{message.group}</span>
                      {groupsById.has(message.group) && (
                        <div className="user-email">
                          {userLabel(
                            usersById.get(groupsById.get(message.group).owner),
                            groupsById.get(message.group).owner
                          )}
                          {t('panels.messages.possessive')}
                        </div>
                      )}
                    </td>
                    <td>
                      {message.reply_to !== null && message.reply_to !== undefined && (
                        <div className="reply-context">
                          <Icon name="reply" /> {t('panels.messages.inReplyTo', {
                            id: message.reply_to,
                          })}
                          {messagesById.has(message.reply_to) && (
                            <span className="reply-quote">
                              {' '}“{preview(messagesById.get(message.reply_to).value, 48)}”
                            </span>
                          )}
                        </div>
                      )}
                      <div className="message-body">{message.value}</div>
                      <AttachmentList files={message.files} />
                    </td>
                    <td>
                      {formatDateTime(message.created_at)}
                      {isEdited(message) && (
                        <div className="user-email" title={formatDateTime(message.updated_at)}>
                          edited
                        </div>
                      )}
                    </td>
                    <td>
                      <div className="actions-group">
                        {can('user_messages:create') && (
                          <button onClick={() => openReply(message)} className="btn-action">
                            <Icon name="reply" /> {t('messenger.reply')}
                          </button>
                        )}
                        {can('user_messages:update') && (
                          <button onClick={() => openEdit(message)} className="btn-action edit">
                            <Icon name="edit" /> {t('common.edit')}
                          </button>
                        )}
                        {can('user_messages:delete') && (
                          <button
                            onClick={() => askToDelete(message)}
                            className="btn-action delete"
                          >
                            <Icon name="delete" /> {t('common.delete')}
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      <Pagination state={page} />

      {isModalOpen && (
        <div className="modal-overlay">
          <div className="modal-content">
            <div className="modal-header">
              <h3>
                {editingMessage
                  ? t('panels.messages.editTitle', { id: editingMessage.id })
                  : formData.reply_to
                    ? t('panels.messages.replyTitle', { id: formData.reply_to })
                    : t('panels.messages.newTitle')}
              </h3>
              <button onClick={closeModal} className="close-btn" aria-label={t('common.close')}><Icon name="close" /></button>
            </div>

            {formError && <div className="modal-error">{formError}</div>}

            {!editingMessage && formData.reply_to && messagesById.has(formData.reply_to) && (
              <div className="modal-note">
                <strong>
                  {userLabel(
                    usersById.get(messagesById.get(formData.reply_to).owner),
                    messagesById.get(formData.reply_to).owner
                  )}
                </strong>{' '}
                wrote: “{preview(messagesById.get(formData.reply_to).value, 120)}”
              </div>
            )}

            <form onSubmit={handleSubmit}>
              <div className="form-row">
                <div className="form-group">
                  <label>{t('panels.messages.author')}</label>
                  {editingMessage || authorIsFixed || !canReadUsers ? (
                    <>
                      <input
                        type="text"
                        disabled
                        value={
                          editingMessage
                            ? userLabel(usersById.get(editingMessage.owner), editingMessage.owner)
                            : userLabel(currentUser, currentUser?.id)
                        }
                      />
                      <small className="optional">
                        {editingMessage
                          ? t('panels.messages.authorFixedEdit')
                          : authorIsFixed
                            ? t('panels.messages.authorFixed')
                            : t('panels.messages.authorNeedsUsers')}
                      </small>
                    </>
                  ) : (
                    <select
                      required
                      value={formData.owner}
                      onChange={(e) => setFormData({ ...formData, owner: e.target.value })}
                      className="role-select"
                    >
                      <option value="">{t('panels.messages.selectAuthor')}</option>
                      {users.map((user) => (
                        <option key={user.id} value={user.id}>
                          {userLabel(user, user.id)} — {user.email}
                        </option>
                      ))}
                    </select>
                  )}
                </div>

                <div className="form-group">
                  <label>{t('panels.messages.group')}</label>
                  {editingMessage || formData.reply_to || !canReadGroups ? (
                    <>
                      <input
                        type="text"
                        disabled
                        value={formData.group ? t('panels.messages.groupRow', { id: formData.group }) : ''}
                        placeholder={t('panels.messages.groupNeedsGroups')}
                      />
                      <small className="optional">
                        {editingMessage
                          ? 'A message stays in the group it was sent to.'
                          : formData.reply_to
                            ? 'A reply goes to the group it answers.'
                            : 'Choosing a group needs permission to read them.'}
                      </small>
                    </>
                  ) : (
                    <select
                      required
                      value={formData.group}
                      onChange={(e) => setFormData({ ...formData, group: e.target.value })}
                      className="role-select"
                    >
                      <option value="">{t('panels.messages.selectGroup')}</option>
                      {groups.map((group) => (
                        <option key={group.id} value={group.id}>
                          {groupLabel(t, group, usersById)}
                        </option>
                      ))}
                    </select>
                  )}
                </div>
              </div>

              <div className="form-group">
                <label>{t('panels.messages.message')}</label>
                <textarea
                  rows={5}
                  required
                  value={formData.value}
                  onChange={(e) => setFormData({ ...formData, value: e.target.value })}
                  placeholder={t('panels.messages.bodyPlaceholder')}
                />
              </div>

              {/* Attachments are editable but not creatable here: a new
                  message is composed in the messenger, where the files go up
                  as they are chosen. */}
              {editingMessage && (
                <div className="form-group">
                  <label>{t('panels.messages.attachments')}</label>

                  <AttachmentDrafts
                    files={attachments}
                    uploading={uploading}
                    onRemove={(file) => setAttachments(
                      (prev) => prev.filter((row) => row.id !== file.id)
                    )}
                  />

                  {can('files:create') && (
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
                        disabled={uploading}
                      >
                        <Icon name="attach_file" /> {t('panels.messages.addFiles')}
                      </button>
                    </>
                  )}

                  <small className="optional">
                    {t('panels.messages.removeNote')}
                  </small>
                </div>
              )}

              <div className="modal-footer">
                <button type="button" onClick={closeModal} className="btn btn-secondary">
                  {t('common.cancel')}
                </button>
                <button type="submit" className="btn btn-primary">
                  {editingMessage ? t('common.saveChanges') : t('panels.messages.send')}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {confirming && (
        <ConfirmDialog
          title={t('messenger.confirm.deleteMessageTitle')}
          message={confirming.message}
          confirmLabel={t('common.delete')}
          destructive
          onCancel={() => setConfirming(null)}
          onConfirm={async () => {
            await confirming.run();
            setConfirming(null);
          }}
        />
      )}
    </div>
  );
}
