import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';

import { api } from '../lib/api';
import { formatDateTime, userLabel } from '../lib/format';
import { useAuth } from '../context/auth';
import Icon from '../components/Icon';
import Pagination from '../components/Pagination';
import { usePagination } from '../lib/pagination';
import ConfirmDialog from '../components/ConfirmDialog';

const EMPTY_FORM = { owner: '', members: [] };

/**
 * Groups as owners and memberships rather than as rows of foreign keys: both
 * are resolved to people wherever the caller may read users. Somebody who may
 * not — an own-scoped member, say — still gets a working screen, just with ids
 * where the names would be.
 */
export default function UserGroupsPanel() {
  const { t } = useTranslation();
  const [confirming, setConfirming] = useState(null);
  const { can, scope, user: currentUser } = useAuth();

  const [groups, setGroups] = useState([]);
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [searchTerm, setSearchTerm] = useState('');
  const [ownerFilter, setOwnerFilter] = useState('all');
  const [sizeFilter, setSizeFilter] = useState('all');

  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingGroup, setEditingGroup] = useState(null);
  const [formData, setFormData] = useState(EMPTY_FORM);
  const [formError, setFormError] = useState('');

  const canReadUsers = can('users:read');
  // With only the own-scoped permission the server files every group under the
  // caller, so offering an owner picker would be offering a lie.
  const ownerIsFixed = scope('user_groups:create') === 'own';

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [groupsRes, usersRes] = await Promise.all([
        api('/api/user_groups'),
        canReadUsers ? api('/api/users') : Promise.resolve({ users: [] }),
      ]);
      setGroups(groupsRes.user_groups);
      setUsers(usersRes.users);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [canReadUsers]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const usersById = useMemo(
    () => new Map(users.map((user) => [user.id, user])),
    [users]
  );

  const openCreate = () => {
    setEditingGroup(null);
    setFormData({ ...EMPTY_FORM, owner: currentUser?.id ?? '' });
    setFormError('');
    setIsModalOpen(true);
  };

  const openEdit = (group) => {
    setEditingGroup(group);
    setFormData({
      owner: group.owner ?? '',
      members: group.members.map((member) => member.id),
    });
    setFormError('');
    setIsModalOpen(true);
  };

  const toggleMember = (userId) => {
    setFormData((prev) => ({
      ...prev,
      members: prev.members.includes(userId)
        ? prev.members.filter((id) => id !== userId)
        : [...prev.members, userId],
    }));
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setFormError('');

    const payload = {
      owner: ownerIsFixed ? currentUser.id : Number(formData.owner),
      members: formData.members,
    };

    try {
      await api(
        editingGroup ? `/api/user_groups/${editingGroup.id}` : '/api/user_groups',
        { method: editingGroup ? 'PUT' : 'POST', body: payload }
      );
      setIsModalOpen(false);
      loadData();
    } catch (err) {
      setFormError(err.message);
    }
  };

  const handleDelete = async (group) => {
    try {
      await api(`/api/user_groups/${group.id}`, { method: 'DELETE' });
      loadData();
    } catch (err) {
      setError(err.message);
    }
  };

  const askToDelete = (group) => setConfirming({
    message: t('panels.groups.confirmDelete', {
      id: group.id,
      owner: userLabel(usersById.get(group.owner), group.owner),
    }),
    run: () => handleDelete(group),
  });

  const owners = useMemo(() => {
    const ids = [...new Set(groups.map((group) => group.owner))];
    return ids.map((id) => ({ id, label: userLabel(usersById.get(id), id) }));
  }, [groups, usersById]);

  const visibleGroups = groups.filter((group) => {
    const haystack = [
      `#${group.id}`,
      userLabel(usersById.get(group.owner), group.owner),
      ...group.members.map((member) => userLabel(member, member.id)),
    ].join(' ').toLowerCase();

    const matchesSearch = haystack.includes(searchTerm.toLowerCase());
    const matchesOwner = ownerFilter === 'all' || group.owner === Number(ownerFilter);
    /*
     * A group with nobody in it is unreachable: no member can read it, invite
     * anybody into it, or delete it, so it can only be dealt with from here.
     * Being able to list exactly those is the point of this filter.
     */
    const matchesSize = sizeFilter === 'all'
      || (sizeFilter === 'empty' ? group.members.length === 0 : group.members.length > 0);
    return matchesSearch && matchesOwner && matchesSize;
  });

  const page = usePagination(visibleGroups);

  if (loading) return <div className="loading-state">{t('panels.groups.loading')}</div>;
  if (error) {
    return (
      <div className="error-banner">
        <Icon name="error" filled /> {error}
      </div>
    );
  }

  return (
    <div>
      <div className="panel-toolbar">
        <div className="metrics-row">
          <div className="metric-box">
            <div className="metric-value">{groups.length}</div>
            <div className="metric-label">{t('panels.groups.total')}</div>
          </div>
          <div className="metric-box">
            <div className="metric-value">
              {groups.reduce((total, group) => total + group.members.length, 0)}
            </div>
            <div className="metric-label">{t('panels.groups.memberships')}</div>
          </div>
          <div className="metric-box">
            <div className="metric-value">
              {groups.filter((group) => group.members.length === 0).length}
            </div>
            <div className="metric-label">{t('panels.groups.empty')}</div>
          </div>
        </div>
        {can('user_groups:create') && (
          <button onClick={openCreate} className="btn btn-primary">
            <Icon name="add" /> {t('panels.groups.add')}
          </button>
        )}
      </div>

      <div className="filters-bar">
        <label className="search-field">
          <Icon name="search" />
          <input
            type="text"
            placeholder={t('panels.groups.searchPlaceholder')}
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="search-input"
          />
        </label>
        <select
          value={ownerFilter}
          onChange={(e) => setOwnerFilter(e.target.value)}
          className="role-select"
        >
          <option value="all">{t('panels.groups.allOwners')}</option>
          {owners.map((owner) => (
            <option key={owner.id} value={owner.id}>{owner.label}</option>
          ))}
        </select>
        <select
          value={sizeFilter}
          onChange={(e) => setSizeFilter(e.target.value)}
          className="role-select"
        >
          <option value="all">{t('panels.groups.allSizes')}</option>
          <option value="any">{t('panels.groups.sizeAny')}</option>
          <option value="empty">{t('panels.groups.sizeEmpty')}</option>
        </select>
      </div>

      <div className="table-responsive">
        <table className="users-table">
          <thead>
            <tr>
              <th>{t('common.id')}</th>
              <th>{t('panels.groups.owner')}</th>
              <th>{t('panels.groups.members')}</th>
              <th>{t('panels.groups.created')}</th>
              <th>{t('panels.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {visibleGroups.length === 0 ? (
              <tr><td colSpan="5" className="empty-state">{t('panels.groups.noMatches')}</td></tr>
            ) : (
              page.visible.map((group) => {
                const owner = usersById.get(group.owner);
                return (
                  <tr key={group.id}>
                    <td>#{group.id}</td>
                    <td>
                      <div className="user-name">
                        {userLabel(owner, group.owner)}
                        {group.owner === currentUser?.id && (
                          <span className="badge system-badge">you</span>
                        )}
                      </div>
                      {owner?.email && <div className="user-email">{owner.email}</div>}
                    </td>
                    <td>
                      <div className="permissions-list">
                        {group.members.length > 0 ? (
                          group.members.map((member) => (
                            <span key={member.id} className="perm-tag">
                              {userLabel(member, member.id)}
                            </span>
                          ))
                        ) : (
                          <span className="no-perm">{t('panels.groups.noMembers')}</span>
                        )}
                      </div>
                    </td>
                    <td>{formatDateTime(group.created_at)}</td>
                    <td>
                      <div className="actions-group">
                        {can('user_groups:update') && (
                          <button onClick={() => openEdit(group)} className="btn-action edit">
                            <Icon name="edit" /> {t('common.edit')}
                          </button>
                        )}
                        {can('user_groups:delete') && (
                          <button onClick={() => askToDelete(group)} className="btn-action delete">
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
                {editingGroup
                  ? t('panels.groups.editTitle', { id: editingGroup.id })
                  : t('panels.groups.createTitle')}
              </h3>
              <button onClick={() => setIsModalOpen(false)} className="close-btn" aria-label={t('common.close')}><Icon name="close" /></button>
            </div>

            {formError && <div className="modal-error">{formError}</div>}

            <form onSubmit={handleSubmit}>
              <div className="form-group">
                <label>{t('panels.groups.owner')}</label>
                {ownerIsFixed || !canReadUsers ? (
                  <>
                    <input type="text" value={userLabel(currentUser, currentUser?.id)} disabled />
                    <small className="optional">
                      {ownerIsFixed
                        ? t('panels.groups.ownerFixed')
                        : t('panels.groups.ownerNeedsUsers')}
                    </small>
                  </>
                ) : (
                  <select
                    required
                    value={formData.owner}
                    onChange={(e) => setFormData({ ...formData, owner: e.target.value })}
                    className="role-select"
                  >
                    <option value="">{t('panels.groups.selectOwner')}</option>
                    {users.map((user) => (
                      <option key={user.id} value={user.id}>
                        {userLabel(user, user.id)} — {user.email}
                      </option>
                    ))}
                  </select>
                )}
              </div>

              <div className="form-group">
                <label>
                  {t('panels.groups.members')}{' '}
                  <span className="optional">{t('common.optional')}</span>
                </label>
                <div className="permissions-checkboxes">
                  {!canReadUsers ? (
                    <span className="no-perm">
                      {t('panels.groups.membersNeedUsers')}
                    </span>
                  ) : users.length === 0 ? (
                    <span className="no-perm">{t('panels.groups.noUsersToAdd')}</span>
                  ) : (
                    users.map((user) => (
                      <label key={user.id} className="checkbox-label">
                        <input
                          type="checkbox"
                          checked={formData.members.includes(user.id)}
                          onChange={() => toggleMember(user.id)}
                        />
                        {userLabel(user, user.id)}
                        <small> {user.email}</small>
                      </label>
                    ))
                  )}
                </div>
              </div>

              <div className="modal-footer">
                <button type="button" onClick={() => setIsModalOpen(false)} className="btn btn-secondary">
                  {t('common.cancel')}
                </button>
                <button type="submit" className="btn btn-primary">
                  {editingGroup ? t('common.saveChanges') : t('panels.groups.createTitle')}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {confirming && (
        <ConfirmDialog
          title={t('panels.groups.confirmDeleteTitle')}
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
