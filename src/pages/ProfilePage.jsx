import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';

import PictureField from '../components/PictureField';
import { useAuth } from '../context/auth';
import { LANGUAGES } from '../i18n';

/**
 * The account editing itself.
 *
 * Only the fields an account may change about itself are here. The address it
 * signs in with, its password and its roles are deliberately absent: the
 * server refuses them on an own-scoped write, so offering them would be a form
 * whose save button cannot work.
 */
export default function ProfilePage() {
  const { user, updateProfile, adoptUser } = useAuth();
  const { t } = useTranslation();

  const [form, setForm] = useState({
    first_name: user.first_name || '',
    last_name: user.last_name || '',
    language: user.language || 'en',
  });
  const [status, setStatus] = useState('idle'); // 'idle' | 'saving' | 'saved'
  const [error, setError] = useState('');

  const set = (field) => (e) => {
    setForm({ ...form, [field]: e.target.value });
    // Any edit makes a previous "Saved" stale.
    setStatus('idle');
    setError('');
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setStatus('saving');

    try {
      await updateProfile({
        first_name: form.first_name.trim(),
        last_name: form.last_name.trim(),
        language: form.language,
      });
      setStatus('saved');
    } catch (err) {
      setError(err.message);
      setStatus('idle');
    }
  };

  return (
    <div className="page-container">
      <div className="hero-card profile-card">
        <h1>{t('profile.title')}</h1>
        <p className="subtitle">{t('profile.subtitle')}</p>

        {error && <div className="modal-error">{error}</div>}

        <form onSubmit={handleSubmit} className="profile-form">
          <div className="form-row">
            <div className="form-group">
              <label htmlFor="profile-first">{t('auth.firstName')}</label>
              <input
                id="profile-first"
                type="text"
                required
                autoComplete="given-name"
                value={form.first_name}
                onChange={set('first_name')}
              />
            </div>
            <div className="form-group">
              <label htmlFor="profile-last">
                {t('auth.lastName')} <span className="optional">{t('common.optional')}</span>
              </label>
              <input
                id="profile-last"
                type="text"
                autoComplete="family-name"
                value={form.last_name}
                onChange={set('last_name')}
              />
            </div>
          </div>

          {/* Outside the form's save button on purpose: a picture is a file,
              so it is uploaded and in place the moment it is chosen. */}
          <PictureField
            user={user}
            onChange={adoptUser}
            label={t('profile.logo')}
            hint={t('picture.rules')}
          />

          <div className="form-group">
            <label htmlFor="profile-language">{t('profile.language')}</label>
            <select id="profile-language" value={form.language} onChange={set('language')}>
              {LANGUAGES.map((language) => (
                <option key={language.code} value={language.code}>
                  {language.nativeName}
                </option>
              ))}
            </select>
          </div>

          {/* Read-only: changing the address you sign in with is a different
              operation, and the server refuses it on an own-scoped write. */}
          <div className="form-group">
            <label htmlFor="profile-email">{t('auth.email')}</label>
            <input id="profile-email" type="email" value={user.email} readOnly disabled />
            <p className="field-hint">{t('profile.emailFixed')}</p>
          </div>

          {/* Shown and not editable, for the same reason as the address above:
              an account that could tick this itself would be confirming
              nothing. Signing in with Google ticks it, since Google hands over
              an address it has verified; otherwise an administrator does. */}
          <div className="form-group checkbox-group">
            <label>
              <input type="checkbox" checked={Boolean(user.email_confirmed)} disabled readOnly />
              {t('profile.emailConfirmed')}
            </label>
            <p className="field-hint">
              {user.email_confirmed ? t('profile.emailConfirmedYes') : t('profile.emailConfirmedNo')}
            </p>
          </div>

          <div className="profile-actions">
            <button type="submit" className="btn btn-primary" disabled={status === 'saving'}>
              {status === 'saving' ? t('common.saving') : t('common.save')}
            </button>
            {status === 'saved' && <span className="profile-saved">{t('profile.saved')}</span>}
          </div>
        </form>
      </div>
    </div>
  );
}
