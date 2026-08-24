import { api } from './api';

/**
 * Saving an edit, including what it dropped.
 *
 * Shared by the messenger and the dashboard because the order matters and is
 * easy to get wrong: the message is updated first, and only then are the files
 * it no longer carries deleted. The other way round, an update that failed
 * would leave the message pointing at bytes that no longer exist.
 *
 * A file that cannot be deleted is left alone rather than reported. It is
 * attached to nothing now, which is exactly what the sweep on the server
 * collects — and a reader correcting a typo should not be shown a bucket
 * error.
 */
export async function saveMessageEdit(message, { value, files }) {
  const before = (message.files || []).map((file) => file.id);
  const after = files.map((file) => file.id);

  const saved = await api(`/api/user_messages/${message.id}`, {
    method: 'PUT',
    // A message may be nothing but its attachments, and the server requires a
    // value; a blank one is a space, as when it was first sent.
    body: { value: value.trim() || ' ', files: after },
  });

  const dropped = before.filter((id) => !after.includes(id));
  await Promise.all(dropped.map(
    (id) => api(`/api/files/${id}`, { method: 'DELETE' }).catch(() => {})
  ));

  return saved.user_message;
}

/** Deletes uploads that were staged and then abandoned. */
export async function discardUploads(files) {
  await Promise.all(files.map(
    (file) => api(`/api/files/${file.id}`, { method: 'DELETE' }).catch(() => {})
  ));
}

/** Has this message been changed since it was sent? */
export function isEdited(message) {
  if (!message?.updated_at || !message?.created_at) return false;
  // A second's tolerance: the two timestamps are written by the same statement
  // and can differ by a hair without anybody having edited anything.
  return Date.parse(message.updated_at) - Date.parse(message.created_at) > 1000;
}
