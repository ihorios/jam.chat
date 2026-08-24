import React, { useEffect, useId, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import Icon from './Icon';

/**
 * "Are you sure?", drawn by the page.
 *
 * window.confirm was doing this job and is the wrong tool for three reasons,
 * none of them cosmetic:
 *
 *  - It is the browser's dialog, not ours, and the browser writes its buttons
 *    in the browser's language. An app that has been carefully translated says
 *    "Ви впевнені…" above an OK and a Cancel it cannot reach.
 *  - It blocks the main thread. A message arriving while somebody is deciding
 *    does not appear until they answer, and neither does the socket
 *    reconnecting.
 *  - Chrome suppresses it entirely after a few in a row, and in a cross-origin
 *    iframe — so an action can silently do nothing, or silently proceed,
 *    depending on which way the caller reads a false.
 *
 * The confirming button carries `destructive` when the answer cannot be walked
 * back, and focus opens on Cancel rather than on it: a confirmation that opens
 * with the dangerous option focused is one stray Enter away from not having
 * asked at all.
 */
export default function ConfirmDialog({
  title,
  message,
  confirmLabel,
  onConfirm,
  onCancel,
  destructive = false,
  busy = false,
}) {
  const { t } = useTranslation();
  const cancelRef = useRef(null);
  // Unique per instance, so the dialog can point at its own heading and body
  // even if the page ever renders two.
  const id = useId();

  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  // Escape is the same answer as Cancel, and the only one available to somebody
  // who reached the dialog by keyboard and wants out of it.
  useEffect(() => {
    const onKey = (event) => {
      if (event.key === 'Escape') onCancel();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onCancel]);

  return (
    <div
      className="modal-overlay"
      // Only the backdrop itself, so a click that starts inside the dialog and
      // ends on the overlay — dragging to select the text of the question —
      // does not dismiss it.
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <div
        className="modal-content confirm-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        aria-describedby={`${id}-body`}
      >
        <div className="modal-header">
          <h3 id={`${id}-title`}>{title}</h3>
          <button
            type="button"
            className="close-btn"
            onClick={onCancel}
            aria-label={t('common.close')}
          >
            <Icon name="close" />
          </button>
        </div>

        <p id={`${id}-body`} className="confirm-body">{message}</p>

        <div className="modal-footer">
          <button type="button" className="btn btn-secondary" ref={cancelRef} onClick={onCancel}>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className={destructive ? 'btn btn-danger' : 'btn btn-primary'}
            onClick={onConfirm}
            disabled={busy}
          >
            {destructive && <Icon name="delete" />}
            {destructive ? ' ' : ''}{confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
