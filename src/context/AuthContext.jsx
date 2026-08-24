import React, { useState, useEffect, useCallback, useMemo } from 'react';

import i18n from '../i18n';
import { api } from '../lib/api';
import { hasAdministrativePermission, scopeOf } from '../lib/permissions';
import { AuthContext } from './auth';

/**
 * A signed-in user's stored language wins over whatever the browser or a
 * previous visit suggested — it is the choice they made, on whichever device
 * they made it.
 */
function applyUserLanguage(user) {
  if (user?.language && user.language !== i18n.resolvedLanguage) {
    i18n.changeLanguage(user.language);
  }
}

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  // Distinguishes "not signed in" from "we do not know yet", so the app does
  // not flash the login page while the session is being confirmed.
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    api('/api/auth/me')
      .then((data) => {
        if (cancelled) return;
        setUser(data.user);
        applyUserLanguage(data.user);
      })
      .catch(() => { if (!cancelled) setUser(null); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const login = useCallback(async (email, password) => {
    const data = await api('/api/auth/login', { method: 'POST', body: { email, password } });
    setUser(data.user);
    applyUserLanguage(data.user);
    return data.user;
  }, []);

  /**
   * Self-registration. The new account is signed in immediately, with no roles.
   *
   * The language the page is being read in goes with it: whatever the visitor
   * was shown is the language they chose to sign up in, and the account should
   * open in it on any device.
   */
  const register = useCallback(async (details) => {
    const data = await api('/api/auth/register', {
      method: 'POST',
      body: { ...details, language: i18n.resolvedLanguage },
    });
    setUser(data.user);
    return data.user;
  }, []);

  /**
   * Changes the interface language, and remembers it on the account when there
   * is one. Signed out it is still applied and cached locally, so choosing a
   * language before registering is what the new account is created with.
   */
  /**
   * The user editing their own row, through the ordinary model route — they
   * hold users:update:own, and the server keeps that to the fields an account
   * may change about itself.
   *
   * Errors are left to the caller: this is a form submission, and a form that
   * silently fails to save is worse than one that says so.
   */
  const updateProfile = useCallback(async (details) => {
    const data = await api(`/api/users/${user.id}`, { method: 'PUT', body: details });
    setUser(data.user);
    applyUserLanguage(data.user);
    return data.user;
  }, [user]);

  const setLanguage = useCallback(async (language) => {
    await i18n.changeLanguage(language);
    if (!user) return;

    try {
      await updateProfile({ language });
    } catch {
      // The page is already in the new language and localStorage has it. A
      // failure here means it will not follow them to another device — not a
      // reason to snap the interface back to a language they just left.
    }
  }, [user, updateProfile]);

  /**
   * Trades a Google ID token for an application session. The server decides
   * whether the token is genuine and which account it belongs to; nothing here
   * is trusted to say who the user is.
   */
  const loginWithGoogle = useCallback(async (token) => {
    const data = await api('/api/auth/google', {
      method: 'POST',
      // Only used if this is a first sign-in and the account is being created.
      body: { token, language: i18n.resolvedLanguage },
    });
    setUser(data.user);
    applyUserLanguage(data.user);
    return data.user;
  }, []);

  const logout = useCallback(async () => {
    try {
      await api('/api/auth/logout', { method: 'POST' });
    } finally {
      // Drop the local identity even if the request failed — the alternative
      // is a UI that still claims to be signed in.
      setUser(null);
    }
  }, []);

  /**
   * Mirrors the server guard: permissions are the union of the user's roles.
   *
   * Holding only the own-scoped form counts. It is enough to reach the screen
   * or the button — the server then decides which rows come back, and refuses
   * anything outside them. Gating the UI more tightly than that would hide
   * features from the very people entitled to use them.
   */
  const can = useCallback(
    (permission) => scopeOf(user?.permissions, permission) !== null,
    [user]
  );

  /**
   * Adopts a user the server has just handed back — a picture upload, say,
   * which changes the account without going through updateProfile.
   */
  const adoptUser = useCallback((updated) => {
    setUser(updated);
    applyUserLanguage(updated);
  }, []);

  /** How much of a model this session may act on: 'any', 'member', 'own', or null. */
  const scope = useCallback(
    (permission) => scopeOf(user?.permissions, permission),
    [user]
  );

  /**
   * Whether this account has any business on the dashboard — see
   * hasAdministrativePermission. It decides three things at once, which is why
   * it lives here rather than in each of them: which links the header offers,
   * which routes will open, and where "/" goes.
   */
  const canAdminister = useMemo(
    () => hasAdministrativePermission(user?.permissions),
    [user]
  );

  /**
   * Where this account starts. An ordinary account's home is the conversation
   * list, since that is the whole of the app for them; an administrator lands on
   * the dashboard, which is what they signed in to do.
   */
  const homePath = canAdminister ? '/dashboard' : '/chats';

  return (
    <AuthContext.Provider
      value={{
        user, loading, login, register, loginWithGoogle, logout,
        setLanguage, updateProfile, adoptUser, can, scope, canAdminister, homePath,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}
