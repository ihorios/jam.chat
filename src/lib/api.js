import i18n from '../i18n';

/**
 * Thin fetch wrapper for the JSON API.
 *
 * The session lives in an HTTP-only cookie, so there is no token to attach —
 * the browser sends it automatically and JavaScript cannot read it. Every
 * failure (network, HTTP status, or `{ ok: false }`) arrives as a thrown Error
 * carrying the server's message, so callers only need one catch.
 */
export async function api(path, { method = 'GET', body } = {}) {
  let res;
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw Object.assign(new Error(i18n.t('errors.unreachable')), { status: 0 });
  }

  const data = await res.json().catch(() => ({}));

  if (!res.ok || data.ok === false) {
    throw Object.assign(new Error(data.error || i18n.t('errors.request', { status: res.status })), {
      status: res.status,
    });
  }
  return data;
}

/**
 * Uploads files and returns the rows created for them.
 *
 * Separate from api() because a multipart body is not JSON: the browser has to
 * set its own Content-Type, boundary and all, so this one deliberately sends
 * no header at all.
 */
/**
 * Sets somebody's picture, or takes it away. One file, not the several an
 * attachment upload takes, and its own endpoint: the server creates the file
 * row and points the user at it in one step (server/routes/user-picture.js).
 */
export async function uploadPicture(userId, file) {
  const form = new FormData();
  form.append('picture', file, file.name);

  let res;
  try {
    res = await fetch(`/api/users/${userId}/picture`, {
      method: 'PUT',
      credentials: 'same-origin',
      body: form,
    });
  } catch {
    throw Object.assign(new Error(i18n.t('errors.unreachable')), { status: 0 });
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) {
    throw Object.assign(
      new Error(data.error || i18n.t('errors.upload', { status: res.status })),
      { status: res.status }
    );
  }
  return data.user;
}

/** Removes it, both an uploaded one and a provider's. Returns the user. */
export async function removePicture(userId) {
  const data = await api(`/api/users/${userId}/picture`, { method: 'DELETE' });
  return data.user;
}

export async function uploadFiles(files) {
  const form = new FormData();
  for (const file of files) form.append('file', file, file.name);

  let res;
  try {
    res = await fetch('/api/files', { method: 'POST', credentials: 'same-origin', body: form });
  } catch {
    throw Object.assign(new Error(i18n.t('errors.unreachable')), { status: 0 });
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) {
    throw Object.assign(
      new Error(data.error || i18n.t('errors.upload', { status: res.status })),
      { status: res.status }
    );
  }
  return data.files;
}
