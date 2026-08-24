import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate } from 'react-router-dom';

import Avatar from './Avatar';
import Icon from './Icon';
import { useAuth } from '../context/auth';

/**
 * The account menu: who you are signed in as, the way to your profile, and the
 * way out — or the way in, when there is no session.
 *
 * These belong together and none of them is somewhere you go often, so they sit
 * behind one button rather than spending header width. Navigation proper (Chats,
 * Dashboard) stays on the bar, one click away.
 *
 * Built as a menu button rather than a div that shows some links, because that
 * is what it is: aria-haspopup, aria-expanded, role="menu" over role="menuitem",
 * arrow keys between the items, Escape back to the button. A menu that only
 * opens with a mouse is a menu half its users cannot open.
 */
export default function UserMenu() {
  const { user, loading, logout } = useAuth();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();

  const [open, setOpen] = useState(false);
  const containerRef = useRef(null);
  const triggerRef = useRef(null);
  const surfaceRef = useRef(null);
  // Set when the menu is closed by something that should hand focus back —
  // Escape, or choosing an item — rather than by a click elsewhere on the page.
  const returnFocus = useRef(false);

  const items = useCallback(
    () => [...(surfaceRef.current?.querySelectorAll('[role="menuitem"]') || [])],
    []
  );

  const close = useCallback((giveFocusBack = false) => {
    returnFocus.current = giveFocusBack;
    setOpen(false);
  }, []);

  // A click anywhere else dismisses it, which is what makes this feel like a
  // menu rather than a panel somebody has to put away.
  useEffect(() => {
    if (!open) return undefined;

    const onPointerDown = (event) => {
      if (!containerRef.current?.contains(event.target)) close();
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [open, close]);

  // Opening moves focus onto the first item, so the keyboard carries on from
  // where the menu appeared; closing puts it back on the button it came from.
  useEffect(() => {
    if (open) {
      items()[0]?.focus();
    } else if (returnFocus.current) {
      returnFocus.current = false;
      triggerRef.current?.focus();
    }
  }, [open, items]);

  // Arriving somewhere new is an answer to the menu, so it should not be left
  // hanging open over the page that replaced it.
  useEffect(() => {
    setOpen(false);
  }, [location.pathname]);

  const onTriggerKeyDown = (event) => {
    // Down and Up open the menu from the keyboard, as a menu button should.
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      setOpen(true);
    }
  };

  const onMenuKeyDown = (event) => {
    const focusable = items();
    const index = focusable.indexOf(document.activeElement);

    switch (event.key) {
      case 'Escape':
        event.preventDefault();
        close(true);
        break;
      case 'ArrowDown':
        event.preventDefault();
        focusable[(index + 1) % focusable.length]?.focus();
        break;
      case 'ArrowUp':
        event.preventDefault();
        focusable[(index - 1 + focusable.length) % focusable.length]?.focus();
        break;
      case 'Home':
        event.preventDefault();
        focusable[0]?.focus();
        break;
      case 'End':
        event.preventDefault();
        focusable[focusable.length - 1]?.focus();
        break;
      case 'Tab':
        // Leaving by Tab closes it; where focus goes next is the page's business.
        close();
        break;
      default:
        break;
    }
  };

  const go = (path) => {
    close(true);
    navigate(path);
  };

  const handleLogout = async () => {
    close(true);
    await logout();
    navigate('/login', { replace: true });
  };

  // Nothing at all until the session is known, so the header does not flicker
  // between signed-out and signed-in.
  if (loading) return null;

  return (
    <div className="user-menu" ref={containerRef}>
      <button
        type="button"
        ref={triggerRef}
        className={open ? 'user-menu-trigger open' : 'user-menu-trigger'}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls="user-menu-surface"
        aria-label={t('nav.menu')}
        title={t('nav.menu')}
        onClick={() => setOpen((was) => !was)}
        onKeyDown={onTriggerKeyDown}
      >
        <Icon name="menu" />
      </button>

      {open && (
        <div
          className="user-menu-surface"
          id="user-menu-surface"
          role="menu"
          aria-label={t('nav.menu')}
          ref={surfaceRef}
          onKeyDown={onMenuKeyDown}
        >
          {user ? (
            <>
              {/* Who you are, rather than something to click: a menu offering to
                  sign you out should say whose session it would end. */}
              <div className="user-menu-identity">
                <Avatar className="user-avatar" logo={user.picture} name={user.name} />
                <div className="user-menu-identity-text">
                  <span className="user-menu-name">{user.name}</span>
                  <span className="user-menu-email">{user.email}</span>
                </div>
              </div>

              <div className="user-menu-divider" role="separator" />

              <button
                type="button"
                role="menuitem"
                className="user-menu-item"
                onClick={() => go('/profile')}
              >
                <Icon name="person" /> {t('nav.profile')}
              </button>
              <button
                type="button"
                role="menuitem"
                className="user-menu-item"
                onClick={handleLogout}
              >
                <Icon name="logout" /> {t('nav.signOut')}
              </button>
            </>
          ) : (
            <button
              type="button"
              role="menuitem"
              className="user-menu-item"
              onClick={() => go('/login')}
            >
              <Icon name="login" /> {t('nav.signIn')}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
