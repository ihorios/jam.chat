import React, { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import Avatar from './Avatar';
import Icon from './Icon';
import { removePicture, uploadPicture } from '../lib/api';
import { PICTURE_RULES, pictureProblem } from '../lib/picture';

/**
 * Somebody's picture, and the two things anyone wants to do with it: put a
 * different one there, or have none.
 *
 * Applied immediately rather than on a form's save button. A picture is a file,
 * not a field — it has to be uploaded before it can be shown — and a control
 * that has already done its work is less confusing than one whose effect is
 * waiting behind Save.
 *
 * `onChange` is handed the user the server sends back, so whatever holds this
 * (a profile page, the admin form) can keep the copy it is showing.
 */
export default function PictureField({ user, onChange, label, hint }) {
  const { t } = useTranslation();
  const inputRef = useRef(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const source = user.logo_file ? 'uploaded' : (user.logo ? 'external' : 'none');

  const choose = async (event) => {
    const file = event.target.files?.[0];
    // Cleared so choosing the same file again still counts as a change.
    event.target.value = '';
    if (!file) return;

    setError('');

    // Checked here as a courtesy — the upload would refuse it too, having read
    // the bytes first (src/lib/picture.js).
    const problem = await pictureProblem(file);
    if (problem) {
      setError(problem);
      return;
    }

    setBusy(true);
    try {
      onChange(await uploadPicture(user.id, file));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setError('');
    setBusy(true);
    try {
      onChange(await removePicture(user.id));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="form-group picture-field">
      <label htmlFor={`picture-${user.id}`}>{label}</label>

      <div className="picture-field-row">
        <Avatar className="picture-preview" logo={user.picture} name={user.name} />

        <div className="picture-field-actions">
          {/* The input itself is never shown: a file input cannot be styled to
              belong here, and a button that opens it can. */}
          <input
            id={`picture-${user.id}`}
            ref={inputRef}
            type="file"
            className="picture-input"
            accept={PICTURE_RULES.accept}
            onChange={choose}
            disabled={busy}
          />
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => inputRef.current?.click()}
            disabled={busy}
          >
            <Icon name="upload" />
            {' '}{source === 'none' ? t('picture.upload') : t('picture.replace')}
          </button>

          {source !== 'none' && (
            <button type="button" className="btn-action delete" onClick={remove} disabled={busy}>
              <Icon name="delete" /> {t('picture.remove')}
            </button>
          )}
        </div>
      </div>

      {error && <p className="picture-error">{error}</p>}

      <p className="field-hint">
        {source === 'external' && `${t('picture.fromProvider')} `}
        {source === 'uploaded' && `${t('picture.uploaded')} `}
        {hint}
      </p>
    </div>
  );
}
