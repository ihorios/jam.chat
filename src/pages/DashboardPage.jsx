import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useParams, useNavigate } from 'react-router-dom';

import { api } from '../lib/api';
import { useAuth } from '../context/auth';
import Icon from '../components/Icon';
import Logo from '../components/Logo';
import PresenceMetrics from '../components/PresenceMetrics';
import UsersPanel from '../panels/UsersPanel';
import RolesPanel from '../panels/RolesPanel';
import UserGroupsPanel from '../panels/UserGroupsPanel';
import UserMessagesPanel from '../panels/UserMessagesPanel';
import GenericModelPanel from '../panels/GenericModelPanel';

/**
 * Bespoke screens for the models that earn one. Anything else falls back to
 * the meta-driven panel, so a model added on the server is manageable here
 * immediately — it just gets a plainer screen until someone writes it one.
 */
/* One icon per model, so a tab is recognisable before it is read. A model with
   no entry — a new one, mounted automatically — falls back to the generic
   table icon, exactly as it falls back to GenericModelPanel. */
const TAB_ICONS = {
  users: 'group',
  roles: 'admin_panel_settings',
  files: 'folder',
  user_groups: 'groups',
  user_messages: 'chat',
};

const PANELS = {
  users: UsersPanel,
  roles: RolesPanel,
  user_groups: UserGroupsPanel,
  user_messages: UserMessagesPanel,
};

export default function DashboardPage() {
  const { t } = useTranslation();
  const { model: modelParam } = useParams();
  const navigate = useNavigate();
  const { user, can, scope } = useAuth();

  const [models, setModels] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    api('/api/meta')
      .then((data) => setModels(data.models))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="loading-state">{t('dashboard.loading')}</div>;
  if (error) {
    return (
      <div className="error-banner">
        <Icon name="error" filled /> {error}
      </div>
    );
  }

  // A tab is only shown for a model the user may actually read. The server
  // enforces the same rule, so hiding one is convenience, not protection.
  const visible = models.filter((model) => can(`${model.name}:read`));

  if (visible.length === 0) {
    return (
      <div className="admin-container">
        <div className="empty-dashboard">
          <Logo size={56} />
          <h2>{t('dashboard.welcome', { name: user.name })}</h2>
          <p className="subtitle">{t('dashboard.noPermissions')}</p>
        </div>
      </div>
    );
  }

  const active = visible.find((model) => model.name === modelParam) || visible[0];

  const Panel = PANELS[active.name] || GenericModelPanel;

  return (
    <div className="admin-container">
      <div className="admin-header">
        <div>
          <h2 className="page-title"><Logo size={30} /> {t('nav.dashboard')}</h2>
          <p className="subtitle">
            {t('dashboard.signedInAs', {
              name: user.name,
              count: user.permissions.length,
            })}
          </p>
        </div>
      </div>

      {/* Presence is gated on the unscoped users:read, exactly as /api/presence
          is — seeing who is online is the same class of information as seeing
          who exists, so an own-scoped reader does not get it. */}
      {scope('users:read') === 'any' && <PresenceMetrics />}

      <div className="tab-buttons" role="tablist">
        {visible.map((model) => (
          <button
            key={model.name}
            role="tab"
            aria-selected={model.name === active.name}
            className={model.name === active.name ? 'tab-btn active' : 'tab-btn'}
            onClick={() => navigate(`/dashboard/${model.name}`)}
          >
            <Icon name={TAB_ICONS[model.name] || 'table'} />
            {model.label}
          </button>
        ))}
      </div>

      {/* Remount on tab change so each panel starts from a clean state. */}
      <Panel key={active.name} model={active} />
    </div>
  );
}
