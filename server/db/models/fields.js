import bcrypt from 'bcryptjs';

/**
 * The field kernel: what a declared field type means in storage, in SQL and on
 * the way in from a client. Model classes (model.js) consume this; nothing
 * here knows about models, tables or the registry.
 */

/** Thrown for bad client input; the error handler maps this to HTTP 400. */
export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
    this.statusCode = 400;
  }
}

/**
 * Minimum strength for any password field, anywhere. Enforced here rather than
 * in the registration route so it also covers admin-created users and password
 * changes — a rule that only lives in a form is not a rule.
 *
 * src/lib/password.js mirrors these for live feedback while typing; this copy
 * is the authoritative one.
 */
export const PASSWORD_RULES = Object.freeze([
  { id: 'length', label: 'at least 8 characters', test: (value) => value.length >= 8 },
  { id: 'letter', label: 'a letter', test: (value) => /[A-Za-z]/.test(value) },
  { id: 'digit', label: 'a digit', test: (value) => /\d/.test(value) },
  { id: 'symbol', label: 'a special character', test: (value) => /[^A-Za-z0-9]/.test(value) },
]);

/**
 * Field types. Each entry maps a declared type to its storage column, its SQL
 * type, and how a raw client value becomes a stored value (`parse`) or a
 * stored value becomes API output (`serialize`).
 *
 * Add a type here and every model can use it immediately.
 */
const FIELD_TYPES = {
  string: {
    sql: 'VARCHAR(255)',
    parse: (value) => String(value),
  },
  text: {
    sql: 'TEXT',
    parse: (value) => String(value),
  },
  integer: {
    sql: 'INTEGER',
    parse: (value) => {
      const parsed = Number.parseInt(value, 10);
      if (Number.isNaN(parsed)) throw new ValidationError(`"${value}" is not a whole number.`);
      return parsed;
    },
  },
  boolean: {
    sql: 'BOOLEAN',
    parse: (value) => value === true || value === 'true' || value === 1 || value === '1',
  },
  json: {
    sql: 'JSONB',
    parse: (value) => JSON.stringify(value ?? null),
    serialize: (value) => (typeof value === 'string' ? JSON.parse(value) : value),
  },
  timestamp: {
    sql: 'TIMESTAMP WITH TIME ZONE',
    parse: (value) => {
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) throw new ValidationError(`"${value}" is not a date.`);
      return date.toISOString();
    },
    // Postgres hands back a Date; the memory driver an ISO string. Normalise so
    // both drivers put the same thing in a response body.
    serialize: (value) => (value instanceof Date ? value.toISOString() : value),
  },
  /**
   * A single foreign key to another model's row, stored as `<name>_id` and
   * exposed to clients as the bare numeric id. Use a relation instead when a
   * row may point at many others.
   */
  reference: {
    sql: 'INTEGER',
    column: (name) => `${name}_id`,
    needsTarget: true,
    parse: (value) => {
      const parsed = Number.parseInt(value, 10);
      if (Number.isNaN(parsed)) throw new ValidationError(`"${value}" is not a row id.`);
      return parsed;
    },
  },
  password: {
    sql: 'TEXT',
    // Stored hashed under a different column name and never sent to a client.
    column: (name) => `${name}_hash`,
    hidden: true,
    parse: (value) => {
      const password = String(value);
      const missing = PASSWORD_RULES.filter((rule) => !rule.test(password));
      if (missing.length > 0) {
        throw new ValidationError(`Password needs ${missing.map((r) => r.label).join(', ')}.`);
      }
      return bcrypt.hash(password, 10);
    },
  },
};

/** Crude English singularisation — enough for deriving `user_id` from `users`. */
export function singular(word) {
  if (word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (word.endsWith('s')) return word.slice(0, -1);
  return word;
}

export function titleize(value) {
  return value.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Normalises one declared field into the frozen shape the rest of the app reads. */
export function defineField(modelName, fieldName, raw) {
  const type = FIELD_TYPES[raw.type];
  if (!type) {
    throw new Error(`Model "${modelName}": unknown field type "${raw.type}" on "${fieldName}".`);
  }
  if (type.needsTarget && !raw.target) {
    throw new Error(`Model "${modelName}": field "${fieldName}" requires a \`target\` model.`);
  }

  return Object.freeze({
    name: fieldName,
    type: raw.type,
    column: type.column ? type.column(fieldName) : fieldName,
    sql: type.sql,
    label: raw.label || titleize(fieldName),
    required: Boolean(raw.required),
    unique: Boolean(raw.unique),
    hidden: Boolean(type.hidden ?? raw.hidden),
    immutable: Boolean(raw.immutable),
    /**
     * Settable only by a caller with unscoped authority over the model.
     *
     * This is what makes an own-scoped write safe to grant: somebody editing
     * their own row may fix their name, and must not be able to hand
     * themselves a role or reactivate a disabled account. Enforced in
     * routes/crud.js, which strips these from a scoped body.
     */
    privileged: Boolean(raw.privileged),
    /**
     * Asks for a database index on this column, for a lookup the schema cannot
     * work out on its own.
     *
     * Reference fields and unique fields get one without saying so — see
     * Model#indexes, which knows what they are for. This is for the rest: a
     * column something looks rows up by, but which is neither. users.logo_file
     * is the one today.
     */
    index: Boolean(raw.index),
    hasDefault: 'default' in raw,
    default: raw.default,
    /** Only meaningful for `reference`: the model this key points at. */
    target: raw.target || null,
    onDelete: raw.onDelete || 'CASCADE',
    parse: type.parse,
    serialize: type.serialize,
  });
}

/**
 * A declared default may be a literal or a function. A function is evaluated
 * per row by the application — that is how a value like "now" stays identical
 * on both drivers instead of depending on a SQL default the memory store has
 * no way to apply.
 */
export function defaultValue(field) {
  return typeof field.default === 'function' ? field.default() : field.default;
}

export function sqlLiteral(value) {
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (typeof value === 'number') return String(value);
  return `'${String(value).replace(/'/g, "''")}'`;
}

/** `DEFAULT x` for a literal default, or '' when the application supplies it. */
export function defaultClause(field) {
  if (!field.hasDefault) return '';
  if (typeof field.default === 'function') return '';
  if (field.default === null || field.default === undefined) return '';
  return `DEFAULT ${sqlLiteral(field.default)}`;
}
