import React, { useState, useMemo, useRef, useEffect } from 'react';
import { GoogleOAuthProvider, GoogleLogin } from '@react-oauth/google';
import { useTranslation } from 'react-i18next';
import { Navigate, useLocation } from 'react-router-dom';

import { useAuth } from '../context/auth';
import Icon from '../components/Icon';
import { normaliseLanguage } from '../i18n';
import { checkPassword, passwordIsStrong } from '../lib/password';

/**
 * Public by nature — it is handed to every browser that loads Google's button.
 * Unset, the button is simply not rendered and the form is the only way in.
 */
const GOOGLE_CLIENT_ID = (import.meta.env.VITE_GOOGLE_CLIENT_ID || '').trim();

const EMPTY = { email: '', first_name: '', last_name: '', password: '' };

/* Google renders its button at a width in pixels and will not take a
   percentage, so a fixed number is wrong at some screen size by definition —
   320 overflowed the card on every phone narrower than about 420px. These are
   the bounds Google itself enforces: it clamps anything above 400, and refuses
   to draw the `continue_with` label under about 200. */
const GOOGLE_BTN_MIN = 200;
const GOOGLE_BTN_MAX = 400;

export default function LoginPage() {
  const { user, loading, login, register, loginWithGoogle } = useAuth();
  const location = useLocation();
  const { t, i18n } = useTranslation();

  // Google localises its own button from the locale it is handed. Left unset it
  // follows the browser — or the visitor's Google account — which is how an
  // English UI ended up with a Ukrainian button.
  const googleLocale = normaliseLanguage(i18n.resolvedLanguage);

  const [mode, setMode] = useState('signin'); // 'signin' | 'register'
  const [form, setForm] = useState(EMPTY);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  // The checklist stays hidden until the field has been touched, so the form
  // does not greet a new visitor with four failed requirements.
  const [passwordTouched, setPasswordTouched] = useState(false);
  const [socialBusy, setSocialBusy] = useState(false);

  /* The width to hand Google, measured from the box it has to fit inside
     rather than assumed. Starts undefined so the first paint uses Google's own
     default instead of flashing a wrong width, and follows the element after
     that — which covers a rotation and a desktop window drag, not just load. */
  const googleBoxRef = useRef(null);
  const [googleWidth, setGoogleWidth] = useState();

  useEffect(() => {
    const box = googleBoxRef.current;
    if (!box || typeof ResizeObserver === 'undefined') return undefined;

    const observer = new ResizeObserver(([entry]) => {
      const available = entry.contentRect.width;
      if (!available) return; // hidden or not laid out yet; nothing to measure
      setGoogleWidth(
        Math.round(Math.min(GOOGLE_BTN_MAX, Math.max(GOOGLE_BTN_MIN, available))),
      );
    });

    observer.observe(box);
    return () => observer.disconnect();
  }, []);

  const isRegister = mode === 'register';
  const rules = useMemo(() => checkPassword(form.password), [form.password]);
  const strong = passwordIsStrong(form.password);

  if (loading) return <div className="loading-state">{t('common.checkingSession')}</div>;
  if (user) return <Navigate to={location.state?.from || '/'} replace />;

  const set = (field) => (e) => setForm({ ...form, [field]: e.target.value });

  const switchMode = (next) => {
    setMode(next);
    setForm(EMPTY);
    setError('');
    setPasswordTouched(false);
  };

  /**
   * Google's button hands back an ID token. It is not inspected here — the
   * server verifies it against Google's keys and decides whose account it is.
   */
  const handleGoogle = async (credentialResponse) => {
    setError('');
    setSocialBusy(true);
    try {
      await loginWithGoogle(credentialResponse.credential);
      // On success the provider sets the user and the <Navigate> above runs.
    } catch (err) {
      setError(err.message);
      setSocialBusy(false);
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');

    if (isRegister && !strong) {
      setPasswordTouched(true);
      setError(t('auth.weakPassword'));
      return;
    }

    setSubmitting(true);
    try {
      if (isRegister) {
        await register({
          email: form.email,
          first_name: form.first_name,
          last_name: form.last_name,
          password: form.password,
        });
      } else {
        await login(form.email, form.password);
      }
      // On success the provider sets the user and the <Navigate> above runs.
    } catch (err) {
      setError(err.message);
      setSubmitting(false);
    }
  };

  return (
    <div className="login-container">
      <div className="login-card">
        {/* The lockup is the whole header: it names the app, so no heading or
            blurb sits between it and the tabs. */}
        <div className="login-header">
          <img
            src="/logo-lockup.png"
            alt="JAM.chat"
            className="login-wordmark"
            width="1607"
            height="384"
          />
        </div>

        <div className="auth-toggle" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={!isRegister}
            className={!isRegister ? 'auth-tab active' : 'auth-tab'}
            onClick={() => switchMode('signin')}
          >
            {t('auth.signIn')}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={isRegister}
            className={isRegister ? 'auth-tab active' : 'auth-tab'}
            onClick={() => switchMode('register')}
          >
            {t('auth.register')}
          </button>
        </div>

        {error && <div className="modal-error">{error}</div>}

        {/* Google renders and owns this button; there is no styling of ours on
            it, which is a condition of using the sign-in flow. The locale is
            ours to set, though — see googleLocale above.

            The `key` is what makes a language switch take effect: the provider
            memoises its context on clientId and script-loaded alone, so a new
            locale prop would never reach the button. Remounting rebuilds the
            context and reloads Google's script with the matching `?hl=`. */}
        {GOOGLE_CLIENT_ID && (
          <>
            <div className="google-signin" aria-busy={socialBusy} ref={googleBoxRef}>
              <GoogleOAuthProvider
                key={googleLocale}
                clientId={GOOGLE_CLIENT_ID}
                locale={googleLocale}
              >
                <GoogleLogin
                  onSuccess={handleGoogle}
                  onError={() => setError(t('auth.googleFailed'))}
                  theme="filled_black"
                  shape="pill"
                  text="continue_with"
                  width={googleWidth}
                />
              </GoogleOAuthProvider>
            </div>
            <div className="auth-divider"><span>{t('common.or')}</span></div>
          </>
        )}

        <form onSubmit={handleSubmit}>
          {isRegister && (
            <div className="form-row">
              <div className="form-group">
                <label htmlFor="reg-first">{t('auth.firstName')}</label>
                <input
                  id="reg-first"
                  type="text"
                  required
                  autoComplete="given-name"
                  value={form.first_name}
                  onChange={set('first_name')}
                  placeholder={t('auth.firstNamePlaceholder')}
                />
              </div>
              <div className="form-group">
                <label htmlFor="reg-last">
                  {t('auth.lastName')} <span className="optional">{t('common.optional')}</span>
                </label>
                <input
                  id="reg-last"
                  type="text"
                  autoComplete="family-name"
                  value={form.last_name}
                  onChange={set('last_name')}
                  placeholder={t('auth.lastNamePlaceholder')}
                />
              </div>
            </div>
          )}

          <div className="form-group">
            <label htmlFor="auth-email">{t('auth.email')}</label>
            <input
              id="auth-email"
              type="email"
              required
              autoFocus={!isRegister}
              autoComplete={isRegister ? 'email' : 'username'}
              value={form.email}
              onChange={set('email')}
              placeholder={t('auth.emailPlaceholder')}
            />
          </div>

          <div className="form-group">
            <label htmlFor="auth-password">{t('auth.password')}</label>
            <input
              id="auth-password"
              type="password"
              required
              autoComplete={isRegister ? 'new-password' : 'current-password'}
              value={form.password}
              onChange={set('password')}
              onBlur={() => setPasswordTouched(true)}
              placeholder={t('auth.passwordPlaceholder')}
              aria-describedby={isRegister ? 'password-rules' : undefined}
            />
          </div>

          {isRegister && (passwordTouched || form.password) && (
            <ul className="pw-rules" id="password-rules">
              {rules.map((rule) => (
                <li key={rule.id} className={rule.passed ? 'pw-rule met' : 'pw-rule'}>
                  <Icon name={rule.passed ? 'check_circle' : 'radio_button_unchecked'} />
                  {t(`auth.passwordRules.${rule.id}`)}
                </li>
              ))}
            </ul>
          )}

          <button type="submit" className="btn btn-primary btn-block" disabled={submitting}>
            {submitting
              ? (isRegister ? t('auth.creating') : t('auth.signingIn'))
              : (isRegister ? t('auth.createAccount') : t('auth.signIn'))}
          </button>
        </form>
      </div>
    </div>
  );
}
