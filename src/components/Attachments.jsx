import React, { useState } from 'react';
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

/**
 * The extensions worth trying to draw rather than describe.
 *
 * Read back off the icon map, so the two cannot disagree about what an image
 * is — adding `bmp` to ICONS is what makes a bmp previewable, and there is no
 * second list to remember.
 */
const IMAGES = new Set(
  Object.entries(ICONS).filter(([, icon]) => icon === 'image').map(([extension]) => extension)
);

const isImage = (file) => IMAGES.has(String(file.extension || '').toLowerCase());

/**
 * An attachment's mark: the picture itself when it is one, the glyph for its
 * type otherwise.
 *
 * Falling back on error rather than trusting the extension, because a file is
 * named by whoever uploaded it: `notes.png` may be anything at all, and a
 * broken-image box beside a filename says less than the paperclip it replaced.
 * A row can also outlive its object — see the note on missing bytes in
 * docs/file.md — and that arrives here as the same failure.
 *
 * `alt=""` on purpose: the file's name is already beside it, and a screen
 * reader announcing it twice is worse than not announcing the thumbnail at all.
 */
function AttachmentMark({ file, className }) {
  const [drawable, setDrawable] = useState(isImage(file));

  if (!drawable) return <Icon className={className} name={iconFor(file.extension)} />;

  return (
    <img
      className={[className, 'attachment-thumb'].filter(Boolean).join(' ')}
      src={`/api/files/${file.id}/content`}
      alt=""
      /* Only what is on screen. A conversation of photographs would otherwise
         fetch every one of them to draw thumbnails nobody has scrolled to. */
      loading="lazy"
      decoding="async"
      onError={() => setDrawable(false)}
    />
  );
}

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
            <AttachmentMark file={file} className="attachment-icon" />
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
          <AttachmentMark file={file} />
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
