import t from 'tap';
import bcrypt from 'bcryptjs';

// Loading the registry populates the permission catalog that parseInput
// validates permissionSet values against.
import '../../server/db/models/index.js';
import { Model } from '../../server/db/models/model.js';
import { singular, ValidationError } from '../../server/db/models/fields.js';

/** A throwaway model class, for exercising the base class without a real one. */
function define(def) {
  return new (class extends Model {
    constructor() {
      super(def);
    }
  })();
}

t.test('singular derives foreign key stems', async (t) => {
  t.equal(singular('users'), 'user');
  t.equal(singular('roles'), 'role');
  t.equal(singular('user_groups'), 'user_group');
  t.equal(singular('categories'), 'category');
  t.equal(singular('media'), 'media');
});

t.test('Model is abstract', async (t) => {
  t.throws(() => new Model({ name: 'things' }), /Model is abstract/);
  t.ok(define({ name: 'things' }) instanceof Model, 'but a subclass instantiates');
});

t.test('a model rejects bad declarations', async (t) => {
  t.throws(() => define({}), /name` is required/);
  t.throws(
    () => define({ name: 'things', fields: { a: { type: 'nope' } } }),
    /unknown field type "nope"/
  );
  t.throws(
    () => define({ name: 'things', fields: { a: { type: 'reference' } } }),
    /requires a `target`/
  );
  t.throws(
    () => define({ name: 'things', relations: { a: { type: 'nope' } } }),
    /unknown relation type "nope"/
  );
  t.throws(
    () => define({ name: 'things', relations: { a: { type: 'manyToMany' } } }),
    /requires a `target`/
  );
  t.throws(() => define({ name: 'things', actions: ['read', 'explode'] }), /unknown action/);

  for (const column of ['uuid', 'created_at', 'id']) {
    t.throws(
      () => define({ name: 'things', fields: { [column]: { type: 'string' } } }),
      /is a system column and cannot be declared/,
      `${column} belongs to every table already`
    );
  }

  t.throws(
    () => define({ name: 'things', ownedBy: 'owner' }),
    /ownedBy must name a reference field/,
    'ownership has to point somewhere'
  );
  t.throws(
    () => define({ name: 'things', ownedBy: 'owner', fields: { owner: { type: 'string' } } }),
    /ownedBy must name a reference field/,
    'and a name is not an owner'
  );
});

t.test('a model normalises its fields and relations', async (t) => {
  const model = define({
    name: 'articles',
    requires: ['users'],
    fields: {
      title: { type: 'string', required: true, unique: true },
      body: { type: 'text' },
      secret: { type: 'password' },
      hits: { type: 'integer', default: 0 },
      published: { type: 'boolean', default: false },
      meta: { type: 'json' },
      posted: { type: 'timestamp', immutable: true },
      author: { type: 'reference', target: 'users' },
    },
    relations: {
      tags: { type: 'manyToMany', target: 'articles' },
    },
  });

  t.equal(model.table, 'articles');
  t.equal(model.label, 'Articles');
  t.same(model.actions, ['create', 'read', 'update', 'delete']);

  // password gets its own column name and never leaves the server.
  t.equal(model.fields.secret.column, 'secret_hash');
  t.ok(model.fields.secret.hidden);
  t.notOk(model.fields.title.hidden);
  t.equal(model.fields.title.label, 'Title');
  t.ok(model.fields.hits.hasDefault);

  // a reference is a single foreign key, stored as <name>_id.
  t.equal(model.fields.author.column, 'author_id');
  t.equal(model.fields.author.target, 'users');
  t.ok(model.fields.posted.immutable);

  // through/keys are derived when not given explicitly.
  t.equal(model.relations.tags.through, 'articles_articles');
  t.equal(model.relations.tags.localKey, 'article_id');
  t.equal(model.relations.tags.targetKey, 'article_id');

  t.same(model.dependencies().sort(), ['articles', 'users'], 'both kinds of target');
  t.throws(() => { model.fields.title.required = false; }, 'definitions are frozen');
});

t.test('a model may expose a subset of actions', async (t) => {
  const model = define({ name: 'logs', actions: ['read'], fields: { line: { type: 'text' } } });
  t.same(model.actions, ['read']);
});

t.test('link() holds a model to its declared requirements', async (t) => {
  const registry = { users: define({ name: 'users' }) };

  const undeclared = define({
    name: 'posts',
    relations: { readers: { type: 'manyToMany', target: 'users' } },
  });
  t.throws(
    () => undeclared.link(registry),
    /points at "users" but does not list it in `requires`/,
    'a target has to be declared, so install order can be worked out'
  );

  const missing = define({ name: 'posts', requires: ['ghosts'] });
  t.throws(() => missing.link(registry), /requires unknown model "ghosts"/);

  const ok = define({
    name: 'posts',
    requires: ['users'],
    fields: { author: { type: 'reference', target: 'users' } },
    relations: { readers: { type: 'manyToMany', target: 'users' } },
  });
  t.equal(ok.link(registry), ok, 'linking returns the model');
  t.equal(ok.targetTable('users'), 'users');

  const selfReferential = define({
    name: 'posts',
    relations: { related: { type: 'manyToMany', target: 'posts' } },
  });
  t.doesNotThrow(
    () => selfReferential.link(registry),
    'a model never has to require itself'
  );
});

t.test('a model states its own permissions', async (t) => {
  const plain = define({ name: 'things' });
  t.same(plain.permissions(), [
    'things:create', 'things:read', 'things:update', 'things:delete',
  ], 'one per declared action');

  const readOnly = define({ name: 'logs', actions: ['read'] });
  t.same(readOnly.permissions(), ['logs:read'], 'and no more than the actions it declares');

  const ownable = define({
    name: 'posts',
    requires: ['users'],
    ownedBy: 'author',
    actions: ['read', 'update'],
    fields: { author: { type: 'reference', target: 'users' } },
  });
  t.same(ownable.permissions(), [
    'posts:read', 'posts:update', 'posts:read:own', 'posts:update:own',
  ], 'plus an own-scoped variant of each, once rows can be owned');
});

t.test('scopesFor() answers what could satisfy a route, broadest first', async (t) => {
  const ownable = define({
    name: 'posts',
    requires: ['users'],
    ownedBy: 'author',
    fields: { author: { type: 'reference', target: 'users' } },
  });

  t.same(ownable.scopesFor('read'), ['any', 'own'], 'any is tried before own');
  t.same(define({ name: 'things' }).scopesFor('read'), ['any']);
  t.same(
    define({ name: 'logs', actions: ['read'] }).scopesFor('delete'),
    [],
    'an action nobody can be granted'
  );
});

t.test('overriding permissions() moves the guards with it', async (t) => {
  // What a later model will do when CRUD is the wrong shape for it.
  class Restricted extends Model {
    constructor() {
      super({
        name: 'posts',
        requires: ['users'],
        ownedBy: 'author',
        fields: { author: { type: 'reference', target: 'users' } },
      });
    }

    permissions() {
      // Readable by anyone who is granted it; writable only over your own.
      return ['posts:read', 'posts:update:own', 'posts:delete:own'];
    }
  }

  const posts = new Restricted();
  t.same(posts.scopesFor('read'), ['any'], 'read is not offered own-scoped');
  t.same(posts.scopesFor('update'), ['own'], 'and update is only offered own-scoped');
  t.same(posts.scopesFor('create'), [], 'while create is not offered at all');
});

t.test('seed() and the row hooks are no-ops until a model overrides them', async (t) => {
  const model = define({ name: 'things', fields: { a: { type: 'string' } } });

  t.equal(await model.seed({}, console), undefined, 'seeding nothing is valid');
  t.doesNotThrow(() => model.beforeDelete({ id: 1 }));
  t.same(model.transform({ id: 1 }), { id: 1 }, 'a row passes through untouched');
});

const sample = define({
  name: 'samples',
  requires: ['roles'],
  fields: {
    name: { type: 'string', required: true },
    slug: { type: 'string', immutable: true },
    note: { type: 'text' },
    count: { type: 'integer', default: 7 },
    active: { type: 'boolean', default: true },
    payload: { type: 'json' },
    password: { type: 'password', required: true },
    stamped: { type: 'timestamp', default: () => new Date().toISOString() },
  },
  relations: {
    roles: { type: 'manyToMany', target: 'roles', through: 'sample_roles' },
    permissions: { type: 'permissionSet' },
  },
});

t.test('parseInput applies defaults and coerces types', async (t) => {
  const { columns } = await sample.parseInput({
    name: 'Widget',
    count: '42',
    active: 'false',
    payload: { a: 1 },
    password: 'hunter2!',
  });

  t.equal(columns.name, 'Widget');
  t.equal(columns.count, 42, 'integer coerced from string');
  t.equal(columns.active, false, "the string 'false' is falsy, not truthy");
  t.equal(columns.payload, '{"a":1}', 'json serialised for storage');
  t.not(columns.password_hash, 'hunter2!', 'password is not stored in the clear');
  t.ok(await bcrypt.compare('hunter2!', columns.password_hash), 'password hash verifies');
  t.notOk('password' in columns, 'raw password field is never a column');

  t.match(columns.stamped, /^\d{4}-\d{2}-\d{2}T/, 'a function default is evaluated per row');
});

t.test('a function default also covers a field submitted blank', async (t) => {
  // Meta-driven forms post every input, empty ones included; a declared
  // default should still win over "" on a create.
  const { columns } = await sample.parseInput({
    name: 'Widget',
    password: 'hunter2!',
    stamped: '',
    count: '',
  });

  t.match(columns.stamped, /^\d{4}-\d{2}-\d{2}T/);
  t.equal(columns.count, 7);
});

t.test('parseInput enforces required fields', async (t) => {
  await t.rejects(sample.parseInput({ password: 'Passw0rd!' }), ValidationError);
  await t.rejects(sample.parseInput({ password: 'Passw0rd!' }), /Name is required/);
  await t.rejects(sample.parseInput({ name: 'A' }), /Password is required/);
  await t.rejects(sample.parseInput({ name: '', password: 'Passw0rd!' }), /Name is required/);
  await t.rejects(
    sample.parseInput({ name: 'A', count: 'abc', password: 'Passw0rd!' }),
    /not a whole number/
  );
  await t.rejects(
    sample.parseInput({ name: 'A', password: 'Passw0rd!', stamped: 'whenever' }),
    /is not a date/
  );
});

t.test('parseInput in partial mode only touches supplied fields', async (t) => {
  const { columns } = await sample.parseInput({ note: 'updated' }, { partial: true });
  t.same(Object.keys(columns), ['note'], 'no defaults are re-applied on update');

  const blankRequired = await sample.parseInput({ password: '' }, { partial: true });
  t.same(blankRequired.columns, {}, 'a blank required field means "leave it alone"');

  const blankOptional = await sample.parseInput({ note: '' }, { partial: true });
  t.same(blankOptional.columns, { note: null }, 'a blank optional field is genuinely cleared');

  const nulled = await sample.parseInput({ note: null }, { partial: true });
  t.same(nulled.columns, { note: null }, 'null clears too');

  await t.rejects(
    sample.parseInput({ slug: 'new' }, { partial: true }),
    /cannot be changed after creation/
  );
});

t.test('parseInput validates relation payloads', async (t) => {
  const { relations } = await sample.parseInput({
    name: 'A',
    password: 'Passw0rd!',
    roles: ['1', 2, 2],
    permissions: ['users:read', 'users:read'],
  });

  t.same(relations.roles, [1, 2], 'ids are numeric and de-duplicated');
  t.same(relations.permissions, ['users:read'], 'permissions are de-duplicated');

  await t.rejects(
    sample.parseInput({ name: 'A', password: 'Passw0rd!', roles: 'admin' }),
    /must be an array/
  );
  await t.rejects(
    sample.parseInput({ name: 'A', password: 'Passw0rd!', roles: ['abc'] }),
    /Invalid roles id/
  );
  await t.rejects(
    sample.parseInput({ name: 'A', password: 'Passw0rd!', permissions: ['ghosts:haunt'] }),
    /Unknown permission\(s\): ghosts:haunt/
  );
});

t.test('ValidationError carries a 400 status', async (t) => {
  const err = new ValidationError('nope');
  t.equal(err.statusCode, 400);
  t.equal(err.name, 'ValidationError');
});
