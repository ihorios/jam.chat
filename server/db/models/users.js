import { config } from '../../config/env.js';
import { permissionKey } from './catalog.js';
import { Model, ValidationError } from './model.js';

/** Interface languages, as ISO 639-1 codes. `uk` is Ukrainian; `ua` is a country. */
export const LANGUAGES = Object.freeze(['en', 'uk']);
export const DEFAULT_LANGUAGE = 'en';

/**
 * The supported language closest to what was asked for, falling back rather
 * than refusing: a language tag arrives from a browser or a sign-up form, and
 * neither is worth failing a registration over.
 *
 * Region subtags are dropped, so `uk-UA` and `en-GB` both land somewhere
 * useful instead of nowhere.
 */
export function normaliseLanguage(value) {
  const base = String(value || '').trim().toLowerCase().split('-')[0];
  return LANGUAGES.includes(base) ? base : DEFAULT_LANGUAGE;
}

/**
 * The first row in the users table, which is the account this installation was
 * bootstrapped with — see seed() below, and helper.js in the tests.
 *
 * It cannot be deleted. Not because it is special in itself, but because it is
 * the way back in: an installation whose last administrator is gone has no
 * route to a new one, since the only write an anonymous caller may perform is
 * self-registration and that deliberately grants no roles. Deleting it also
 * cascades — the groups it owns, the conversations in them, the files in those.
 *
 * UsersPanel hides the delete button for this id too. That is a courtesy, and
 * this is the rule: a button that is merely absent is still a request anybody
 * can make by hand.
 */
export const FIRST_USER_ID = 1;

/** Longer than any real avatar URL, short enough not to be a place to hide data. */
const LOGO_MAX_LENGTH = 2048;

/**
 * The stored form of a logo, or null when there is none.
 *
 * A logo is rendered as an `<img src>` wherever the person appears, so an
 * http(s) URL is the only thing that may go in it: `javascript:` and `data:` in
 * that position are a script and a payload rather than a picture. Google's
 * account picture arrives the same way as one somebody typed and gets the same
 * check — the claim is only as trustworthy as the token it rode in on.
 */
export function normaliseLogo(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  if (raw.length > LOGO_MAX_LENGTH) throw new ValidationError('Logo URL is too long.');

  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new ValidationError('Logo must be a URL, e.g. https://example.com/me.png');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new ValidationError('Logo must be an http:// or https:// URL.');
  }
  return url.toString();
}

/**
 * Users hold no permissions of their own — they hold roles, and their
 * effective permissions are the union of those roles' grants.
 */
class Users extends Model {
  constructor() {
    super({
      name: 'users',
      label: 'Users',
      requires: ['roles'],
      fields: {
        /*
         * `privileged` on everything an account must not be able to change
         * about itself. Editing your own profile is a small, safe thing;
         * changing the address you sign in with, the password behind it, or
         * whether the account is even enabled are not, and each wants a flow
         * of its own. See Model#privilegedKeys and routes/crud.js.
         */
        email: { type: 'string', required: true, unique: true, label: 'Email Address', privileged: true },
        first_name: { type: 'string', required: true, label: 'First Name' },
        // Optional: plenty of people have one name, and registration does not ask.
        last_name: { type: 'string', label: 'Last Name' },
        password: { type: 'password', required: true, label: 'Password', privileged: true },
        is_active: { type: 'boolean', default: true, label: 'Active Account', privileged: true },
        /*
         * Whether the address has been proven, rather than merely typed.
         *
         * Privileged, so it behaves the way the forms describe it: on the
         * account's own profile it is shown and not editable, while `users:update`
         * — an administrator — may set it either way. A password sign-up starts
         * false; a Google sign-in sets it, because Google hands over an address
         * it has verified itself (see server/auth/google.js).
         */
        email_confirmed: {
          type: 'boolean',
          default: false,
          label: 'Email Confirmed',
          privileged: true,
        },
        /*
         * The picture that stands in for this person in chats and groups. Not
         * privileged: your own face is exactly the kind of thing an account may
         * change about itself. Stored as a URL — text rather than string,
         * because a provider's picture URL runs well past 255 characters.
         */
        logo: { type: 'text', label: 'Logo', description: 'URL of the picture shown in chats.' },
        /*
         * The uploaded picture, when it is one: the id of the file row holding
         * the bytes (server/routes/user-picture.js). `logo` and this are the
         * two ways to have a picture — somebody else's URL, or our own file —
         * and `picture` below is the one the client reads.
         *
         * A plain integer rather than a reference, because files already point
         * at users and a foreign key back would be a cycle the schema cannot
         * create. What a reference would have bought — no id left pointing at a
         * deleted row — the files model does instead, in its afterDelete.
         *
         * Privileged: setting it means naming a file, and a file id is not the
         * account's to choose. The picture route is the way in, and it uploads
         * the bytes it points at.
         */
        logo_file: {
          type: 'integer',
          label: 'Uploaded Picture',
          privileged: true,
          /*
           * Indexed by hand because the rules cannot see what this is: a
           * reference field would be indexed for its key, and this one has no
           * key to be indexed for. It is looked up all the same — findRawBy on
           * it is how a deleted file finds the person still pointing at it, and
           * the file sweep deletes in a loop.
           */
          index: true,
        },
        // Which language to show them. Set from the page they signed up on and
        // changeable afterwards; a default rather than required, so existing
        // rows and admin-created accounts do not need it supplied.
        language: { type: 'string', default: DEFAULT_LANGUAGE, label: 'Language' },
      },
      relations: {
        // The one that decides what an account may do, and therefore the one
        // an account may never hand itself.
        roles: { type: 'manyToMany', target: 'roles', through: 'user_roles', privileged: true },
      },
      searchable: ['first_name', 'last_name', 'email'],
    });
  }

  /**
   * A user owns themselves, far enough to edit their own profile.
   *
   * Only `update` is offered rather than the whole own-scoped set the base
   * class would generate: `users:delete:own` is an account deleting itself and
   * `users:create:own` means nothing at all. What an own-scoped update may
   * actually touch is decided by the `privileged` flags above — name and
   * language, and nothing that changes what the account is or may do.
   */
  permissions() {
    return [...super.permissions(), permissionKey(this.name, 'update', 'own')];
  }

  beforeDelete(user) {
    if (Number(user?.id) === FIRST_USER_ID) {
      throw new ValidationError(
        'The first account cannot be deleted: it is the way back in if every '
        + 'other administrator is locked out.'
      );
    }
  }

  /**
   * Ownership here is identity rather than a foreign key: the row is the user.
   * That is why users declares no `ownedBy` — there is no column to point at,
   * so both halves of the ownership question are answered directly instead.
   */
  get ownerColumn() {
    return 'id';
  }

  ownedByUser(row, userId) {
    return Boolean(row) && Number(row.id) === Number(userId);
  }

  /**
   * The first account, holding the `admin` role. Without it a fresh database
   * has no way in: the only write an anonymous caller may perform is
   * self-registration, and that deliberately grants no roles (routes/auth.js).
   *
   * Created only when the address is free, and an existing row is never
   * touched. That is the whole point — this runs on every boot, so a seed that
   * wrote the configured password each time would silently undo the password
   * change this account exists to receive.
   *
   * Nothing is seeded unless ADMIN_EMAIL and ADMIN_PASSWORD are both set, so
   * an installation that bootstraps its first account some other way — the
   * tests do — is left alone.
   */
  async seed(repositories, log) {
    const users = repositories[this.name];
    const { email, firstName, password } = config.admin;

    if (!email || !password) {
      // Worth saying only when it leaves nobody able to sign in; on a database
      // that already has accounts this is simply how it is configured.
      if ((await users.findAll()).length === 0) {
        log.warn('No users, and no ADMIN_EMAIL/ADMIN_PASSWORD to seed one with.');
      }
      return;
    }

    if (await users.findRawBy('email', email)) return;

    const adminRole = (await repositories.roles.findAll()).find((role) => role.name === 'admin');
    if (!adminRole) {
      log.warn(`No "admin" role to grant, so ${email} was not seeded.`);
      return;
    }

    try {
      await users.create({
        email,
        first_name: firstName,
        password,
        is_active: true,
        // Configured by whoever runs the installation, so there is nobody left
        // to prove the address to.
        email_confirmed: true,
        roles: [adminRole.id],
      });
      log.info(`Seeded the initial admin account: ${email}`);
    } catch (err) {
      // Almost always a password that fails PASSWORD_RULES, which is
      // configuration rather than a bug. Boot without an admin and say why,
      // rather than crashing the process on every restart.
      log.warn(`Could not seed the initial admin account (${email}): ${err.message}`);
    }
  }

  /**
   * `logo` is the one field here whose value is not merely typed but *rendered*,
   * so it is narrowed to a picture URL before it is stored rather than trusted
   * at every place that displays it. Everything else the base class handles.
   */
  async parseInput(input, options) {
    const parsed = await super.parseInput(input, options);
    if (Object.hasOwn(parsed.columns, 'logo')) {
      parsed.columns.logo = normaliseLogo(parsed.columns.logo);
    }
    return parsed;
  }

  /** Where a user's picture is read from, whichever of the two it is. */
  static pictureUrl(user) {
    if (user.logo_file) return `/api/files/${user.logo_file}/content`;
    return user.logo || null;
  }

  transform(user) {
    // Both derived on every read, never stored.
    user.name = [user.first_name, user.last_name].filter(Boolean).join(' ');
    // One field for "where is this person's picture", so no client has to know
    // that there are two places it could come from.
    user.picture = Users.pictureUrl(user);
    user.permissions = [
      ...new Set((user.roles || []).flatMap((role) => role.permissions || [])),
    ].sort();
    return user;
  }
}

export default new Users();
