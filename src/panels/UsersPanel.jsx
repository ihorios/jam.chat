import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';

import Avatar from '../components/Avatar';
import PictureField from '../components/PictureField';
import { api } from '../lib/api';
import { useAuth } from '../context/auth';
import Icon from '../components/Icon';
import Pagination from '../components/Pagination';
import { usePagination } from '../lib/pagination';
import ConfirmDialog from '../components/ConfirmDialog';

/*
 * The bootstrap account, which has no delete button.
 *
 * Hardcoded here and refused in the users model's beforeDelete — the same
 * number in two places on purpose, because hiding the button is a courtesy to
 * whoever is reading the table and the model is what actually stops it.
 */
const FIRST_USER_ID = 1;

const EMPTY_FORM = {
  first_name: '',
  last_name: '',
  email: '',
  password: '',
  roles: [],
  is_active: true,
  // An address an administrator typed is no more proven than one a visitor
  // typed; whoever creates the account can tick the box if they know better.
  email_confirmed: false,
};

export default function UsersPanel() {
  const { t } = useTranslation();
  const [confirming, setConfirming] = useState(null);
  const { can, user: currentUser } = useAuth();

  const [users, setUsers] = useState([]);
  const [roles, setRoles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [searchTerm, setSearchTerm] = useState('');
  const [roleFilter, setRoleFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');

  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingUser, setEditingUser] = useState(null); // null for create mode
  const [formData, setFormData] = useState(EMPTY_FORM);
  const [formError, setFormError] = useState('');

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [usersRes, rolesRes] = await Promise.all([
        api('/api/users'),
        // Assigning roles needs the role list; a user who cannot read roles
        // still gets the table, just without the assignment controls.
        can('roles:read') ? api('/api/roles') : Promise.resolve({ roles: [] }),
      ]);
      setUsers(usersRes.users);
      setRoles(rolesRes.roles);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [can]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const handleOpenCreateModal = () => {
    setEditingUser(null);
    setFormData(EMPTY_FORM);
    setFormError('');
    setIsModalOpen(true);
  };

  const handleOpenEditModal = (user) => {
    setEditingUser(user);
    setFormData({
      first_name: user.first_name,
      last_name: user.last_name,
      email: user.email,
      password: '', // blank keeps the current one
      roles: user.roles.map((role) => role.id),
      is_active: user.is_active,
      email_confirmed: Boolean(user.email_confirmed),
    });
    setFormError('');
    setIsModalOpen(true);
  };

  const handleRoleToggle = (roleId) => {
    setFormData((prev) => ({
      ...prev,
      roles: prev.roles.includes(roleId)
        ? prev.roles.filter((id) => id !== roleId)
        : [...prev.roles, roleId],
    }));
  };

  // Mirrors the server: a user's permissions are the union of their roles'.
  const previewPermissions = useMemo(() => {
    const granted = roles
      .filter((role) => formData.roles.includes(role.id))
      .flatMap((role) => role.permissions);
    return [...new Set(granted)].sort();
  }, [roles, formData.roles]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setFormError('');

    const payload = { ...formData };
    // Omit an untouched password so the server keeps the existing hash.
    if (editingUser && !payload.password) delete payload.password;
    if (!can('roles:read')) delete payload.roles;

    try {
      await api(
        editingUser ? `/api/users/${editingUser.id}` : '/api/users',
        { method: editingUser ? 'PUT' : 'POST', body: payload }
      );
      setIsModalOpen(false);
      loadData();
    } catch (err) {
      setFormError(err.message);
    }
  };

  const handleDeleteUser = async (user) => {
    try {
      await api(`/api/users/${user.id}`, { method: 'DELETE' });
      loadData();
    } catch (err) {
      setError(err.message);
    }
  };

  const askToDeleteUser = (user) => setConfirming({
    message: t('panels.users.confirmDelete', { name: user.name }),
    run: () => handleDeleteUser(user),
  });

  const filteredUsers = users.filter((user) => {
    const haystack = `${user.name} ${user.email}`.toLowerCase();
    const matchesSearch = haystack.includes(searchTerm.toLowerCase());
    const matchesRole =
      roleFilter === 'all' || user.roles.some((role) => role.name === roleFilter);
    // Disabled accounts still hold their roles and their history, so they are
    // worth being able to look at on their own.
    const matchesStatus = statusFilter === 'all'
      || (statusFilter === 'active' ? user.is_active : !user.is_active);
    return matchesSearch && matchesRole && matchesStatus;
  });

  const page = usePagination(filteredUsers);

  if (loading) return <div className="loading-state">{t('panels.users.loading')}</div>;
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
            <div className="metric-value">{users.length}</div>
            <div className="metric-label">{t('panels.users.total')}</div>
          </div>
          <div className="metric-box">
            <div className="metric-value">{users.filter((u) => u.is_active).length}</div>
            <div className="metric-label">{t('panels.users.active')}</div>
          </div>
          <div className="metric-box">
            <div className="metric-value">{users.filter((u) => u.roles.length === 0).length}</div>
            <div className="metric-label">{t('panels.users.roleless')}</div>
          </div>
          <div className="metric-box">
            <div className="metric-value">{roles.length}</div>
            <div className="metric-label">{t('panels.users.definedRoles')}</div>
          </div>
        </div>
        {can('users:create') && (
          <button onClick={handleOpenCreateModal} className="btn btn-primary">
            <Icon name="add" /> {t('panels.users.add')}
          </button>
        )}
      </div>

      <div className="filters-bar">
        <label className="search-field">
          <Icon name="search" />
          <input
            type="text"
            placeholder={t('panels.users.searchPlaceholder')}
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="search-input"
          />
        </label>
        <select
          value={roleFilter}
          onChange={(e) => setRoleFilter(e.target.value)}
          className="role-select"
        >
          <option value="all">{t('panels.users.allRoles')}</option>
          {roles.map((role) => (
            <option key={role.id} value={role.name}>{role.name}</option>
          ))}
        </select>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="role-select"
        >
          <option value="all">{t('panels.users.allStatuses')}</option>
          <option value="active">{t('panels.users.statusActive')}</option>
          <option value="disabled">{t('panels.users.statusDisabled')}</option>
        </select>
      </div>

      <div className="table-responsive">
        <table className="users-table">
          <thead>
            <tr>
              <th>{t('common.id')}</th>
              <th>{t('panels.users.nameAndEmail')}</th>
              <th>{t('panels.users.roles')}</th>
              <th>{t('panels.users.status')}</th>
              <th>{t('panels.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {filteredUsers.length === 0 ? (
              <tr><td colSpan="5" className="empty-state">{t('panels.users.noMatches')}</td></tr>
            ) : (
              page.visible.map((user) => (
                <tr key={user.id}>
                  <td>#{user.id}</td>
                  <td>
                    <div className="user-cell">
                      <Avatar className="user-avatar" logo={user.picture} name={user.name} />
                      <div>
                        <div className="user-name">
                          {user.name}
                          {user.id === currentUser?.id && (
                            <span className="badge system-badge">you</span>
                          )}
                        </div>
                        <div className="user-email">
                          {user.email}
                          {/* Only the addresses nobody has proven are flagged:
                              a badge on every confirmed one would be a column
                              of ticks saying nothing. The edit form is where
                              the state itself is read and changed. */}
                          {!user.email_confirmed && (
                            <span className="badge unconfirmed-badge">unconfirmed</span>
                          )}
                        </div>
                      </div>
                    </div>
                  </td>
                  <td>
                    <div className="permissions-list">
                      {user.roles.length > 0 ? (
                        user.roles.map((role) => (
                          <span key={role.id} className={`role-pill role-${role.name}`}>
                            {role.name}
                          </span>
                        ))
                      ) : (
                        <span className="no-perm">{t('panels.users.noRoles')}</span>
                      )}
                    </div>
                  </td>
                  {/* The roles above say what this account may do. Listing
                      every permission they add up to as well made one row of the
                      overview taller than the rest of the table put together —
                      an administrator holds most of the catalogue. It is read in
                      the edit form, where there is room for it. */}
                  <td>
                    <span className={`status-pill ${user.is_active ? 'active' : 'inactive'}`}>
                      {t(user.is_active ? 'panels.users.statusActive' : 'panels.users.statusDisabled')}
                    </span>
                  </td>
                  <td>
                    <div className="actions-group">
                      {can('users:update') && (
                        <button onClick={() => handleOpenEditModal(user)} className="btn-action edit">
                          <Icon name="edit" /> {t('common.edit')}
                        </button>
                      )}
                      {can('users:delete') && user.id !== FIRST_USER_ID && (
                        <button onClick={() => askToDeleteUser(user)} className="btn-action delete">
                          <Icon name="delete" /> {t('common.delete')}
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))
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
                {editingUser
                  ? t('panels.users.editTitle', { id: editingUser.id })
                  : t('panels.users.createTitle')}
              </h3>
              <button onClick={() => setIsModalOpen(false)} className="close-btn" aria-label={t('common.close')}><Icon name="close" /></button>
            </div>

            {formError && <div className="modal-error">{formError}</div>}

            <form onSubmit={handleSubmit}>
              <div className="form-row">
                <div className="form-group">
                  <label>{t('auth.firstName')}</label>
                  <input
                    type="text"
                    required
                    value={formData.first_name}
                    onChange={(e) => setFormData({ ...formData, first_name: e.target.value })}
                    placeholder={t('auth.firstNamePlaceholder')}
                  />
                </div>
                <div className="form-group">
                  <label>
                    {t('auth.lastName')} <span className="optional">{t('common.optional')}</span>
                  </label>
                  <input
                    type="text"
                    value={formData.last_name}
                    onChange={(e) => setFormData({ ...formData, last_name: e.target.value })}
                    placeholder={t('auth.lastNamePlaceholder')}
                  />
                </div>
              </div>

              <div className="form-group">
                <label>{t('auth.email')}</label>
                <input
                  type="email"
                  required
                  value={formData.email}
                  onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                  placeholder={t('panels.users.emailPlaceholder')}
                />
              </div>

              <div className="form-row">
                <div className="form-group">
                  <label>
                    {editingUser ? t('panels.users.newPassword') : t('auth.password')}
                  </label>
                  <input
                    type="password"
                    required={!editingUser}
                    autoComplete="new-password"
                    value={formData.password}
                    onChange={(e) => setFormData({ ...formData, password: e.target.value })}
                    placeholder={editingUser
                      ? t('auth.passwordPlaceholder')
                      : t('panels.users.passwordPlaceholder')}
                  />
                </div>
                <div className="form-group checkbox-group">
                  <label>
                    <input
                      type="checkbox"
                      checked={formData.is_active}
                      onChange={(e) => setFormData({ ...formData, is_active: e.target.checked })}
                    />
                    {t('panels.users.activeAccount')}
                  </label>
                  {/* The account itself is shown this and cannot change it —
                      it is privileged on the model, so an own-scoped write
                      never reaches it. Here it is an administrator's to set:
                      a Google sign-in ticks it by itself, a password sign-up
                      leaves it for somebody to decide. */}
                  <label>
                    <input
                      type="checkbox"
                      checked={formData.email_confirmed}
                      onChange={(e) => setFormData({
                        ...formData,
                        email_confirmed: e.target.checked,
                      })}
                    />
                    {t('profile.emailConfirmed')}
                  </label>
                </div>
              </div>

              {/* Only for an account that exists: the picture is a file
                  belonging to a user row, so there has to be one first. */}
              {editingUser ? (
                <PictureField
                  user={editingUser}
                  onChange={(updated) => {
                    setEditingUser(updated);
                    setUsers((previous) => previous.map(
                      (row) => (row.id === updated.id ? updated : row)
                    ));
                  }}
                  label={t('profile.logo')}
                  hint={t('picture.rules')}
                />
              ) : (
                <p className="field-hint">{t('picture.createFirst')}</p>
              )}

              {can('roles:read') && (
                <>
                  <div className="form-group">
                    <label>{t('panels.users.roles')}</label>
                    <div className="permissions-checkboxes">
                      {roles.length === 0 ? (
                        <span className="no-perm">{t('panels.roles.none')}</span>
                      ) : (
                        roles.map((role) => (
                          <label key={role.id} className="checkbox-label">
                            <input
                              type="checkbox"
                              checked={formData.roles.includes(role.id)}
                              onChange={() => handleRoleToggle(role.id)}
                            />
                            <span className={`role-pill role-${role.name}`}>{role.name}</span>
                            {role.description && <small> {role.description}</small>}
                          </label>
                        ))
                      )}
                    </div>
                  </div>

                  <div className="form-group">
                    <label>{t('panels.users.resulting')}</label>
                    <div className="permissions-list derived-box">
                      {previewPermissions.length > 0 ? (
                        previewPermissions.map((perm) => (
                          <span key={perm} className="perm-tag derived">{perm}</span>
                        ))
                      ) : (
                        <span className="no-perm">
                          {t('panels.users.noneUntilRole')}
                        </span>
                      )}
                    </div>
                  </div>
                </>
              )}

              <div className="modal-footer">
                <button type="button" onClick={() => setIsModalOpen(false)} className="btn btn-secondary">
                  {t('common.cancel')}
                </button>
                <button type="submit" className="btn btn-primary">
                  {editingUser ? t('common.saveChanges') : t('panels.users.createTitle')}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {confirming && (
        <ConfirmDialog
          title={t('panels.users.confirmDeleteTitle')}
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
