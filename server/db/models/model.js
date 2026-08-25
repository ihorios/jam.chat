import { randomUUID } from 'node:crypto';

import {
  CRUD_ACTIONS,
  SCOPES,
  isValidPermission,
  parsePermission,
  permissionKey,
} from './catalog.js';
import {
  ValidationError,
  defaultClause,
  defaultValue,
  defineField,
  singular,
  titleize,
} from './fields.js';

/**
 * Relation types. Both store their data in a side table rather than a column,
 * so they are resolved by the repository rather than the SELECT list.
 */
const RELATION_TYPES = {
  /** e.g. users <-> roles through user_roles. */
  manyToMany(name, def, modelName) {
    if (!def.target) throw new Error(`Relation "${name}" requires a \`target\` model.`);

    /*
     * Columns the link row carries beyond the two keys — data belonging to the
     * *pair* rather than to either end of it. How far a user has read in a
     * group is the one today: it is neither a fact about the user nor about the
     * group but about their membership, and keeping it in a table of its own
     * meant keeping the two in step by hand.
     *
     * Declaring any of these changes how the relation is written. A relation
     * without them is replaced wholesale on every write, which is right when
     * the link rows hold nothing worth keeping — and is exactly what would
     * erase this, since every invitation rewrites the whole member list. A
     * relation that carries payload is reconciled instead: see writeRelations
     * in either repository.
     */
    const columns = {};
    for (const [columnName, raw] of Object.entries(def.columns || {})) {
      const field = defineField(`${modelName}.${name}`, columnName, raw);
      if (field.type === 'reference') {
        throw new Error(
          `Relation "${name}": a link column cannot be a reference (${columnName}).`
        );
      }
      columns[columnName] = field;
    }

    return {
      kind: 'manyToMany',
      name,
      target: def.target,
      through: def.through || [modelName, def.target].sort().join('_'),
      localKey: def.localKey || `${singular(modelName)}_id`,
      targetKey: def.targetKey || `${singular(def.target)}_id`,
      privileged: Boolean(def.privileged),
      columns: Object.freeze(columns),
      /** Reconciled rather than replaced, so what the rows carry survives. */
      carriesPayload: Object.keys(columns).length > 0,
    };
  },
  /** A set of `<model>:<action>` grants, stored as (owner_id, model, action). */
  permissionSet(name, def, modelName) {
    return {
      kind: 'permissionSet',
      name,
      through: def.through || `${singular(modelName)}_permissions`,
      localKey: def.localKey || `${singular(modelName)}_id`,
      privileged: Boolean(def.privileged),
    };
  },
};

/**
 * Columns every table carries whatever its model declares, so a model may not
 * name a field after one of them:
 *
 *   id          the primary key, local and numeric
 *   uuid        a globally unique identifier, assigned by the server
 *   created_at  first written
 *   updated_at  last written
 */
export const SYSTEM_COLUMNS = Object.freeze(['id', 'uuid', 'created_at', 'updated_at']);

/**
 * Base class for every model. A subclass declares its shape by passing a
 * definition to `super()` and overrides the hooks it needs:
 *
 *   class Widgets extends Model {
 *     constructor() {
 *       super({ name: 'widgets', requires: ['users'], fields: {...} });
 *     }
 *     async seed(repositories, log) { ... }   // default rows
 *     transform(row) { ... }                  // shape a row on the way out
 *     beforeDelete(row) { ... }               // veto a delete
 *   }
 *   export default new Widgets();
 *
 * The instance is the single source of truth for the model's tables, its
 * permissions, its repository and its REST routes — see index.js for how it
 * gets picked up.
 */
export class Model {
  /** name -> Model, injected by the registry once every model has loaded. */
  #registry = null;

  constructor(def = {}) {
    if (new.target === Model) {
      throw new Error('Model is abstract: define a model by extending it.');
    }
    if (!def.name) throw new Error('Model: `name` is required.');

    const fields = {};
    for (const [fieldName, raw] of Object.entries(def.fields || {})) {
      const field = defineField(def.name, fieldName, raw);
      if (SYSTEM_COLUMNS.includes(field.column)) {
        throw new Error(
          `Model "${def.name}": "${field.column}" is a system column and cannot be declared.`
        );
      }
      fields[fieldName] = field;
    }

    const relations = {};
    for (const [relationName, raw] of Object.entries(def.relations || {})) {
      const build = RELATION_TYPES[raw.type];
      if (!build) {
        throw new Error(
          `Model "${def.name}": unknown relation type "${raw.type}" on "${relationName}".`
        );
      }
      relations[relationName] = Object.freeze(build(relationName, raw, def.name));
    }

    const actions = def.actions || CRUD_ACTIONS;
    const unknownAction = actions.find((action) => !CRUD_ACTIONS.includes(action));
    if (unknownAction) {
      throw new Error(`Model "${def.name}": unknown action "${unknownAction}".`);
    }

    this.name = def.name;
    this.table = def.table || def.name;
    this.label = def.label || titleize(def.name);
    this.actions = Object.freeze([...actions]);
    this.fields = Object.freeze(fields);
    this.relations = Object.freeze(relations);
    /** Field names matched by the ?search= query parameter. */
    this.searchable = Object.freeze(def.searchable || []);
    /**
     * Models this one is built on top of. They are installed first — their
     * tables exist before this model's schema() runs, which is what lets a
     * foreign key point at them. Every relation or reference target must be
     * listed here; link() enforces that.
     */
    this.requires = Object.freeze(def.requires || []);
    /**
     * The reference field naming the user a row belongs to, if any. Declaring
     * it is what brings this model's `:own` permissions into existence and
     * what an own-scoped request is filtered by. A model without it can only
     * ever be granted wholesale.
     */
    this.ownedBy = def.ownedBy || null;

    if (this.ownedBy) {
      const field = fields[this.ownedBy];
      if (!field || field.type !== 'reference') {
        throw new Error(
          `Model "${def.name}": ownedBy must name a reference field, got "${this.ownedBy}".`
        );
      }
    }

    /**
     * How belonging to a row is decided, if it can be. Two shapes:
     *
     *   { relation: 'members' }  the users in this many-to-many are its members
     *   { via: 'group' }         membership is whatever the referenced row says
     *
     * Declaring it is what brings this model's `:member` permissions into
     * existence, and what a member-scoped request is filtered by. Ownership
     * and membership are independent: a group's owner is a single user, its
     * members are many, and either may be granted on its own.
     */
    this.membership = def.membership || null;

    if (this.membership) {
      const { relation, via } = this.membership;
      if (relation && relations[relation]?.kind !== 'manyToMany') {
        throw new Error(
          `Model "${def.name}": membership.relation must name a manyToMany relation, got "${relation}".`
        );
      }
      if (via && fields[via]?.type !== 'reference') {
        throw new Error(
          `Model "${def.name}": membership.via must name a reference field, got "${via}".`
        );
      }
      if (!relation && !via) {
        throw new Error(`Model "${def.name}": membership needs either a relation or a via.`);
      }
    }
  }

  /** The model's identifier — the name of the base table it is stored in. */
  get id() {
    return this.table;
  }

  /** The column an ownership filter compares against, or null. */
  get ownerColumn() {
    return this.ownedBy ? this.fields[this.ownedBy].column : null;
  }

  /**
   * Field and relation names a scoped caller may not set, whatever they send.
   *
   * A scoped write is about the caller's own corner of the model, and some
   * columns decide how large that corner is. Granting `update:own` should mean
   * "you may edit yourself", never "you may promote yourself" — see
   * routes/crud.js, which strips these from the body.
   */
  privilegedKeys() {
    return [
      ...Object.values(this.fields).filter((field) => field.privileged).map((f) => f.name),
      ...Object.values(this.relations).filter((rel) => rel.privileged).map((r) => r.name),
    ];
  }

  /** Does this row belong to that user? False whenever nothing owns the model. */
  ownedByUser(row, userId) {
    if (!this.ownedBy || !row) return false;
    return Number(row[this.ownedBy]) === Number(userId);
  }

  /**
   * Every permission this model defines — the complete list of what a role may
   * be granted over it, and the only source the catalog is built from.
   *
   * The default is one permission per declared action, plus an own-scoped
   * variant of each when rows can be owned. A model that guards itself
   * differently overrides this and returns whatever set it means; the catalog,
   * the permission matrix and the route guards all follow, because they read
   * the model rather than assume the default.
   */
  permissions() {
    return [
      ...this.actions.map((action) => permissionKey(this.name, action)),
      ...(this.membership
        ? this.actions.map((action) => permissionKey(this.name, action, 'member'))
        : []),
      ...(this.ownedBy
        ? this.actions.map((action) => permissionKey(this.name, action, 'own'))
        : []),
    ];
  }

  /**
   * The reference field a member-scoped request follows to find out whether it
   * may touch a row, when membership is somebody else's business — a message
   * belongs to whoever belongs to its group. Null when the model answers for
   * itself, or cannot answer at all.
   */
  get membershipVia() {
    return this.membership?.via ? this.fields[this.membership.via] : null;
  }

  /** The many-to-many whose rows are this model's members, or null. */
  get membershipRelation() {
    return this.membership?.relation ? this.relations[this.membership.relation] : null;
  }

  /**
   * The scopes `action` can be granted at, broadest first, according to
   * permissions(). Empty when the model grants that action to nobody, which is
   * how a route learns it has no business existing.
   */
  scopesFor(action) {
    const scopes = new Set(
      this.permissions()
        .map(parsePermission)
        .filter((permission) => permission.action === action)
        .map((permission) => permission.scope)
    );
    return SCOPES.filter((scope) => scopes.has(scope));
  }

  /**
   * Column values the server assigns to every new row itself. Generated here
   * rather than by a SQL default so the in-memory driver produces exactly what
   * Postgres would.
   */
  generatedValues() {
    return { uuid: randomUUID() };
  }

  /** Every other model this one points at, via a relation or a reference field. */
  dependencies() {
    return [
      ...new Set([
        ...Object.values(this.fields)
          .filter((field) => field.type === 'reference')
          .map((field) => field.target),
        ...Object.values(this.relations)
          .map((relation) => relation.target)
          .filter(Boolean),
      ]),
    ];
  }

  /**
   * Hands the model the finished registry. Called once, by the registry, after
   * every model has loaded — a model cannot resolve its own foreign keys until
   * the models it points at exist.
   */
  link(registry) {
    for (const name of this.requires) {
      if (!registry[name]) {
        throw new Error(`Model "${this.name}" requires unknown model "${name}".`);
      }
    }
    for (const dependency of this.dependencies()) {
      if (dependency === this.name || this.requires.includes(dependency)) continue;
      throw new Error(
        `Model "${this.name}" points at "${dependency}" but does not list it in \`requires\`.`
      );
    }
    this.#registry = registry;
    return this;
  }

  /** The table backing `name`, which must be this model or one it requires. */
  targetTable(name) {
    if (name === this.name) return this.table;
    const target = this.#registry?.[name];
    if (!target) {
      throw new Error(`Model "${this.name}": relation targets unknown model "${name}".`);
    }
    return target.table;
  }

  /**
   * Every statement needed to create this model's storage: its own table
   * first, then one side table per relation. Ordering within the list matters
   * (side tables reference the base table); ordering between models is the
   * registry's job, via `requires`.
   */
  schema() {
    return [
      this.tableDdl(),
      ...Object.values(this.relations).map((relation) => this.relationDdl(relation)),
    ];
  }

  /** A column definition for CREATE TABLE, constraints included. */
  columnDefinition(field) {
    const parts = [field.column, field.sql];
    if (field.required) parts.push('NOT NULL');
    if (field.unique) parts.push('UNIQUE');
    if (field.type === 'reference') {
      parts.push(`REFERENCES ${this.targetTable(field.target)}(id) ON DELETE ${field.onDelete}`);
    }

    const clause = defaultClause(field);
    if (clause) parts.push(clause);
    return parts.join(' ');
  }

  /**
   * The same column for ALTER TABLE ADD COLUMN — always nullable and never
   * unique, because an existing table may hold rows that would violate either.
   * See syncColumns() in db/schema.js.
   */
  addColumnDefinition(field) {
    const parts = [field.column, field.sql];
    if (field.type === 'reference') {
      parts.push(`REFERENCES ${this.targetTable(field.target)}(id) ON DELETE ${field.onDelete}`);
    }
    const clause = defaultClause(field);
    if (clause) parts.push(clause);
    return parts.join(' ');
  }

  /** CREATE TABLE for the model itself, derived entirely from its fields. */
  tableDdl() {
    const columns = [
      'id SERIAL PRIMARY KEY',
      'uuid UUID NOT NULL UNIQUE',
      ...Object.values(this.fields).map((field) => this.columnDefinition(field)),
      'created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP',
      'updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP',
    ];
    return `CREATE TABLE IF NOT EXISTS ${this.table} (\n  ${columns.join(',\n  ')}\n)`;
  }

  /** CREATE TABLE for one relation's side table. */
  relationDdl(relation) {
    if (relation.kind === 'manyToMany') {
      // One line per payload column, each already trailing its comma, so the
      // primary key below reads the same whether there are any or none.
      const payload = Object.values(relation.columns || {})
        .map((field) => {
          const clause = defaultClause(field);
          return `  ${field.column} ${field.sql}${clause ? ` ${clause}` : ''},\n`;
        })
        .join('');

      return `CREATE TABLE IF NOT EXISTS ${relation.through} (
  ${relation.localKey} INTEGER NOT NULL REFERENCES ${this.table}(id) ON DELETE CASCADE,
  ${relation.targetKey} INTEGER NOT NULL REFERENCES ${this.targetTable(relation.target)}(id) ON DELETE CASCADE,
${payload}  PRIMARY KEY (${relation.localKey}, ${relation.targetKey})
)`;
    }

    if (relation.kind === 'permissionSet') {
      return `CREATE TABLE IF NOT EXISTS ${relation.through} (
  ${relation.localKey} INTEGER NOT NULL REFERENCES ${this.table}(id) ON DELETE CASCADE,
  model VARCHAR(64) NOT NULL,
  action VARCHAR(32) NOT NULL,
  scope VARCHAR(8) NOT NULL DEFAULT 'any',
  PRIMARY KEY (${relation.localKey}, model, action, scope)
)`;
    }

    throw new Error(`Unsupported relation kind "${relation.kind}".`);
  }

  /**
   * The indexes this model's storage wants, as CREATE INDEX statements.
   *
   * Separate from schema() because they are applied after syncColumns: a column
   * added to a table that already existed cannot be indexed in the same pass
   * that adds it. Every statement is IF NOT EXISTS, so this runs on every boot
   * and an index added to these rules reaches an existing database.
   *
   * Three rules, each answering a query this application actually makes:
   *
   *  - **Every reference column.** Postgres does not index a foreign key of its
   *    own accord, and two different things need it to be. ON DELETE CASCADE has
   *    to find the children of the row being deleted, which without an index is
   *    a scan of the whole child table per parent row — deleting a group would
   *    read every message in the database. And these are the same columns the
   *    owner- and member-scoped filters compare against on the way in.
   *  - **The target key of every many-to-many.** The link table's primary key is
   *    (local, target), which serves lookups by the local side and nothing at
   *    all by the target side — and the target side is the hot one. Resolving
   *    "which groups is this user in" reads user_group_users by user_id, and
   *    that happens on every member-scoped request there is.
   *  - **LOWER() of every unique text field.** findRawBy compares case
   *    insensitively, so the plain btree that UNIQUE already built cannot be
   *    used for it. That is the query behind every sign-in.
   *
   * A field may also ask for one with `index: true`, for a lookup none of the
   * rules can infer — users.logo_file, which is a foreign key in all but name.
   *
   * Deliberately not here: the `?search=` filter, which is ILIKE '%term%' and
   * wants a pg_trgm GIN index. That needs an extension the server may not be
   * allowed to create, so it is a decision for whoever runs the database rather
   * than something to attempt on every boot.
   */
  indexes() {
    const statements = [];
    const create = (table, name, expression) => statements.push(
      `CREATE INDEX IF NOT EXISTS ${name} ON ${table} (${expression})`
    );

    for (const field of Object.values(this.fields)) {
      // A unique column already has a btree behind it, built by the constraint,
      // so a second plain index on it would be dead weight.
      if ((field.type === 'reference' || field.index) && !field.unique) {
        create(this.table, `idx_${this.table}_${field.column}`, field.column);
      }

      if (field.unique && (field.type === 'string' || field.type === 'text')) {
        create(this.table, `idx_${this.table}_${field.column}_lower`, `LOWER(${field.column})`);
      }
    }

    for (const relation of Object.values(this.relations)) {
      // A permissionSet is keyed (local, model, action, scope) and only ever
      // read by the local side, which its primary key already leads with.
      if (relation.kind !== 'manyToMany') continue;
      create(
        relation.through,
        `idx_${relation.through}_${relation.targetKey}`,
        relation.targetKey
      );
    }

    return statements;
  }

  /**
   * Rows this model needs in order to be useful: the defaults a fresh database
   * starts with, and the fixtures tests rely on. Runs on every boot, right
   * after schema(), in dependency order — so it must be idempotent, and may
   * assume the models in `requires` have already seeded.
   *
   * `repositories` is the full set, keyed by model name, not just this one's.
   */
  async seed(_repositories, _log) {}

  /** Shapes a hydrated row before it leaves the repository. */
  transform(row) {
    return row;
  }

  /** Vetoes a delete by throwing (e.g. protecting system rows). */
  beforeDelete(_row) {}

  /**
   * Tidies up after a row that has just been removed — the counterpart to
   * beforeDelete, and unlike it, awaited.
   *
   * Called with the row as it was — hydrated, so its relations are still
   * visible even though the link rows have just cascaded away — once the
   * delete has succeeded, by every driver. It is where a model reaches beyond
   * its own table on the way out: a file model deletes the object its row
   * pointed at, a message takes its attachments with it.
   *
   * `context.getRepo(name)` reaches the other repositories, since a model has
   * no registry of its own. Throwing here fails a delete that has already
   * happened, so implementations swallow their own errors and log instead.
   */
  async afterDelete(_row, _context) {}

  /**
   * Validates and normalises client input against this model.
   * Returns the physical column values and the relation values separately,
   * because they are written to different tables.
   */
  async parseInput(input = {}, { partial = false } = {}) {
    const columns = {};
    const relations = {};

    for (const field of Object.values(this.fields)) {
      const provided = Object.hasOwn(input, field.name) && input[field.name] !== undefined;

      if (!provided) {
        if (partial) continue;
        if (field.hasDefault) {
          columns[field.column] = defaultValue(field);
          continue;
        }
        if (field.required) throw new ValidationError(`${field.label} is required.`);
        continue;
      }

      const value = input[field.name];

      if (partial && field.immutable) {
        throw new ValidationError(`${field.label} cannot be changed after creation.`);
      }

      if (value === null || value === '') {
        // A required field can never be blanked. On an update that means "leave
        // it alone", which is what lets an edit form submit an empty password to
        // keep the current one; on a create there is nothing to fall back to.
        if (field.required) {
          if (partial) continue;
          throw new ValidationError(`${field.label} is required.`);
        }
        // On a create, a blank field with a declared default takes the default:
        // a form that submits every input as an empty string should still get
        // the value the model promises.
        if (!partial && field.hasDefault) {
          columns[field.column] = defaultValue(field);
          continue;
        }
        // An optional field genuinely cleared.
        columns[field.column] = null;
        continue;
      }

      columns[field.column] = await field.parse(value);
    }

    for (const relation of Object.values(this.relations)) {
      if (!Object.hasOwn(input, relation.name) || input[relation.name] === undefined) continue;

      const value = input[relation.name];
      if (!Array.isArray(value)) {
        throw new ValidationError(`${relation.name} must be an array.`);
      }

      if (relation.kind === 'permissionSet') {
        const invalid = value.filter((permission) => !isValidPermission(permission));
        if (invalid.length > 0) {
          throw new ValidationError(`Unknown permission(s): ${invalid.join(', ')}.`);
        }
        relations[relation.name] = [...new Set(value)];
      } else {
        relations[relation.name] = [...new Set(value.map((id) => {
          const parsed = Number.parseInt(id, 10);
          if (Number.isNaN(parsed)) throw new ValidationError(`Invalid ${relation.name} id: ${id}.`);
          return parsed;
        }))];
      }
    }

    return { columns, relations };
  }
}

export { ValidationError };
