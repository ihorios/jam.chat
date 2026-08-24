import React from 'react';
import { useTranslation } from 'react-i18next';
import { NavLink } from 'react-router-dom';

import Icon from './Icon';
import UserMenu from './UserMenu';
import { useAuth } from '../context/auth';
import { useRealtime } from '../context/realtime';

export default function Navbar() {
  const { user, canAdminister } = useAuth();
  const { unread } = useRealtime();
  const { t } = useTranslation();

  const linkClass = ({ isActive }) => (isActive ? 'nav-link active' : 'nav-link');

  return (
    <header className="navbar-container">
      <div className="navbar-brand">
        {/* The wordmark is served as a file rather than drawn inline so that it
            is literally public/logo-lockup.png — the artwork as approved, with
            no second copy to drift from it. */}
        <NavLink to="/" className="brand-logo">
          <img
            src="/logo-lockup.png"
            alt="JAM.chat"
            className="brand-wordmark"
            width="1607"
            height="384"
          />
          <span className="brand-tagline">{t('nav.tagline')}</span>
        </NavLink>
      </div>

      <nav className="navbar-links">
        {/* Links only where there is a choice to make. An ordinary account can
            reach exactly one page, so a bar of navigation would be a bar with
            "you are here" written across it — see canAdminister, and the same
            check on the routes themselves in App.jsx. */}
        {user && canAdminister && (
          <>
            <NavLink to="/chats" className={linkClass} title={t('nav.chats')}>
              <Icon name="forum" />
              <span className="nav-link-label">{t('nav.chats')}</span>
              {/* Anything unread anywhere, whichever page you are on. */}
              {unread.total > 0 && (
                <span
                  className="unread-dot"
                  role="status"
                  aria-label={t('nav.unreadAria', { count: unread.total })}
                  title={t('nav.unreadTitle', { count: unread.total })}
                />
              )}
            </NavLink>
            <NavLink to="/dashboard" className={linkClass} title={t('nav.dashboard')}>
              <Icon name="space_dashboard" />
              <span className="nav-link-label">{t('nav.dashboard')}</span>
            </NavLink>
          </>
        )}

        {/* Who you are, and what you can do about it — your profile, the way
            out, or the way in. All of it behind one button: see UserMenu. */}
        <UserMenu />

      </nav>
    </header>
  );
}
