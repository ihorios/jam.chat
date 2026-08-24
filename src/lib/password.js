/**
 * Mirrors PASSWORD_RULES in server/db/models/fields.js so the form can give live
 * feedback while typing. Deliberately duplicated rather than imported: the
 * server module pulls in bcrypt and pg, which have no business in a browser
 * bundle.
 *
 * The server is authoritative. This copy exists to save the user a round trip,
 * not to decide anything — a password that slips past it is still rejected.
 */
/**
 * Each rule carries an id rather than a label: the wording is a translation
 * key ('password.length' and so on), looked up where it is rendered. A module
 * that knows how to test a password has no business knowing what language the
 * page is in.
 */
export const PASSWORD_RULES = [
  { id: 'length', test: (value) => value.length >= 8 },
  { id: 'letter', test: (value) => /[A-Za-z]/.test(value) },
  { id: 'digit', test: (value) => /\d/.test(value) },
  { id: 'symbol', test: (value) => /[^A-Za-z0-9]/.test(value) },
];

export function checkPassword(password = '') {
  return PASSWORD_RULES.map((rule) => ({ ...rule, passed: rule.test(password) }));
}

export function passwordIsStrong(password = '') {
  return PASSWORD_RULES.every((rule) => rule.test(password));
}
