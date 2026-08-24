import React from 'react';
import { useTranslation } from 'react-i18next';

import Icon from './Icon';
import { formatBytes } from '../lib/format';

/**
 * The files on a message, and the ones about to be on one.
 *
 * Every download goes through /api/files/:id/content rather than at the bucket
 * directly: whether you may read an attachment is decided by the group it was
 * sent to, and a URL cannot be withdrawn when somebody leaves one.
 */

/* Material Symbol names, by extension: the file type says which icon, and the
   paperclip is what anything unrecognised gets. */
const ICONS = {
  pdf: 'picture_as_pdf',
  doc: 'description', docx: 'description', odt: 'description', rtf: 'description',
  xls: 'table', xlsx: 'table', csv: 'table', ods: 'table',
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image',
  svg: 'image', avif: 'image',
  mp3: 'audio_file', wav: 'audio_file', ogg: 'audio_file', m4a: 'audio_file',
  flac: 'audio_file',
  mp4: 'movie', mov: 'movie', webm: 'movie', mkv: 'movie',
  zip: 'folder_zip', gz: 'folder_zip', tar: 'folder_zip', rar: 'folder_zip',
  '7z': 'folder_zip',
  txt: 'article', md: 'article', json: 'data_object', log: 'article',
};

const iconFor = (extension) => ICONS[String(extension || '').toLowerCase()] || 'attach_file';

/** Read-only: what is already attached to a message. */
export function AttachmentList({ files }) {
  if (!files || files.length === 0) return null;

  return (
    <ul className="attachments">
      {files.map((file) => (
        <li key={file.id}>
          <a
            className="attachment"
            href={`/api/files/${file.id}/content`}
            // The server names the file in Content-Disposition; this is what
            // makes a click download rather than navigate.
            download={file.name}
          >
            <Icon className="attachment-icon" name={iconFor(file.extension)} />
            <span className="attachment-name">{file.name}</span>
            <span className="attachment-size">{formatBytes(file.size)}</span>
          </a>
        </li>
      ))}
    </ul>
  );
}

/**
 * Editable: what is staged on a message not yet sent. Removing one deletes it
 * outright — it was uploaded the moment it was chosen, so leaving it behind
 * would be paying to store something nobody will ever see.
 */
export function AttachmentDrafts({ files, uploading, onRemove }) {
  const { t } = useTranslation();

  if ((!files || files.length === 0) && !uploading) return null;

  return (
    <div className="attachment-drafts">
      {files.map((file) => (
        <span key={file.id} className="attachment-chip">
          <Icon name={iconFor(file.extension)} />
          <span className="attachment-name">{file.name}</span>
          <span className="attachment-size">{formatBytes(file.size)}</span>
          <button
            type="button"
            onClick={() => onRemove(file)}
            aria-label={t('attachments.remove', { name: file.name })}
          >
            <Icon name="close" />
          </button>
        </span>
      ))}

      {uploading && <span className="attachment-chip pending">{t('attachments.uploading')}</span>}
    </div>
  );
}
