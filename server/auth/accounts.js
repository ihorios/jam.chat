import { randomBytes } from 'node:crypto';

import { normaliseLanguage, normaliseLogo } from '../db/models/users.js';

/**
 * What an account is when it creates itself.
 *
 * Both ways in — a password sign-up and a Google sign-in — land here, so the
 * two cannot drift apart on what a new account starts with.
 */

/**
 * The role every self-created account is given.
 *
 * Named rather than an id: roles are seeded rows and an installation may have
 * edited this one, so it is looked up on each use. An account with no roles can
 * sign in and see nothing at all, which is not what somebody who just
 * registered is meant to find — the `user` role is the messenger and their own
 * profile, and nothing administrative (see db/models/roles.js).
 */
export const DEFAULT_ROLE = 'user';

/**
 * A password nobody holds, for an account whose credential is an identity
 * provider rather than something typed. A row still needs one, so it gets a
 * value long enough to be unguessable and shaped to satisfy PASSWORD_RULES so
 * the model accepts it. The point is that password sign-in for such an account
 * is impossible, not that the value is ever used.
 */
const unusablePassword = () => `${randomBytes(24).toString('base64url')}Aa1!`;

/**
 * The provider's account picture, or none.
 *
 * A URL that would be refused as a logo is dropped rather than raised: whether
 * somebody can sign in must not turn on whether their picture is usable.
 */
function pictureOrNull(picture, log) {
  if (!picture) return null;
  try {
    return normaliseLogo(picture);
  } catch (err) {
    log?.warn(`Ignored a Google account picture: ${err.message}`);
    return null;
  }
}

/** The ids to hand a new account, or none if the role has been deleted. */
export async function defaultRoleIds(repositories, log) {
  const role = await repositories.roles.findRawBy('name', DEFAULT_ROLE);
  if (!role) {
    log?.warn(`No "${DEFAULT_ROLE}" role to grant, so the new account starts with none.`);
    return [];
  }
  return [role.id];
}

/**
 * The account behind a verified Google identity, created if this is the first
 * time that address has been seen.
 *
 * Returns `{ user, created }`. Kept out of the route so the rules a Google
 * sign-in follows are testable without a token, a key set and the network.
 */
export async function googleAccount(repositories, identity, { language, log } = {}) {
  const users = repositories.users;
  const existing = await users.findRawBy('email', identity.email);

  if (!existing) {
    const [first, ...rest] = identity.name.split(/\s+/).filter(Boolean);
    const user = await users.create({
      email: identity.email,
      // Providers are not obliged to send a name; the local part of the
      // address is a better placeholder than an empty required field.
      first_name: first || identity.email.split('@')[0],
      last_name: rest.join(' ') || null,
      password: unusablePassword(),
      is_active: true,
      // Google verified the address before it would put it in a token
      // (identityFromClaims refuses one that says otherwise), so there is
      // nothing left for this application to confirm.
      email_confirmed: true,
      logo: pictureOrNull(identity.picture, log),
      language: normaliseLanguage(language),
      roles: await defaultRoleIds(repositories, log),
    });
    return { user, created: true };
  }

  /*
   * An account that already exists keeps everything it has. Two things are
   * filled in: the address is now proven, and a picture where there was none.
   * A logo the person set is theirs and is left alone — signing in again is not
   * a reason to overwrite it with whatever Google currently holds.
   */
  const patch = {};
  if (!existing.email_confirmed) patch.email_confirmed = true;
  // Only where there is no picture at all: one they uploaded is theirs, and a
  // provider's URL is not an improvement on it.
  const picture = pictureOrNull(identity.picture, log);
  if (!existing.logo && !existing.logo_file && picture) patch.logo = picture;

  const user = Object.keys(patch).length > 0
    ? await users.update(existing.id, patch)
    : await users.findById(existing.id);

  return { user, created: false };
}
