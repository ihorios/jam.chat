import t from 'tap';

import { freshRepositories } from '../helper.js';
import { ValidationError } from '../../server/db/models/fields.js';

/** An unseeded set of repositories per test, so cases never bleed into each other. */
function repos() {
  return freshRepositories();
}

t.test('a repository exists for every registered model', async (t) => {
  const repositories = freshRepositories();
  t.same(
    Object.keys(repositories).sort(),
    ['files', 'roles', 'user_group_reads', 'user_groups', 'user_messages', 'users'],
    'including the internal ones, which still need somewhere to be written'
  );
  t.equal(repositories.users.model.name, 'users');
});

t.test('messages CRUD, keyed to an author and a group', async (t) => {
  const { users, user_groups: groups, user_messages: messages } = repos();

  const author = await users.create({
    email: 'writer@example.com', first_name: 'Wri', last_name: 'Ter', password: 'Passw0rd!',
  });
  const group = await groups.create({ owner: author.id, members: [author.id] });

  const message = await messages.create({
    owner: author.id,
    group: group.id,
    value: 'Anyone about?',
  });

  t.equal(message.owner, author.id, 'both keys come back as plain ids');
  t.equal(message.group, group.id);
  t.equal(message.value, 'Anyone about?');
  t.ok(message.uuid && message.created_at);

  const edited = await messages.update(message.id, { value: 'Anyone around?' });
  t.equal(edited.value, 'Anyone around?');
  t.equal(edited.group, group.id, 'the group survives an edit to the body');

  await t.rejects(messages.create({ group: group.id, value: 'No author' }), /Author is required/);
  await t.rejects(messages.create({ owner: author.id, value: 'No group' }), /Group is required/);
  await t.rejects(
    messages.create({ owner: author.id, group: group.id }),
    /Message is required/
  );

  t.equal((await messages.findAll({ search: 'around' })).length, 1, 'the body is searchable');
  t.equal((await messages.findAll({ owner: author.id })).length, 1, 'and filterable by author');
  t.equal(await messages.remove(message.id), true);
});

t.test('roles CRUD', async (t) => {
  const { roles } = repos();

  t.same(await roles.findAll(), [], 'starts empty');

  const created = await roles.create({
    name: 'moderator',
    description: 'Keeps the peace',
    permissions: ['users:read', 'users:update'],
  });
  t.equal(created.name, 'moderator');
  t.equal(created.is_system, false, 'declared default applied');
  t.same(created.permissions, ['users:read', 'users:update']);
  t.ok(created.id > 0);
  t.ok(created.created_at && created.updated_at);

  t.equal((await roles.findAll()).length, 1);
  t.equal((await roles.findById(created.id)).name, 'moderator');
  t.equal(await roles.findById(9999), null, 'missing id');
  t.equal(await roles.findById('not-a-number'), null, 'unparseable id');

  const updated = await roles.update(created.id, { description: 'Updated' });
  t.equal(updated.description, 'Updated');
  t.same(updated.permissions, ['users:read', 'users:update'], 'untouched relation is preserved');

  const regranted = await roles.update(created.id, { permissions: ['roles:read'] });
  t.same(regranted.permissions, ['roles:read'], 'a submitted permission list replaces the old one');

  const cleared = await roles.update(created.id, { permissions: [] });
  t.same(cleared.permissions, [], 'an empty list revokes everything');

  t.equal(await roles.update(9999, { description: 'x' }), null, 'update of a missing row');
  t.equal(await roles.remove(created.id), true);
  t.equal(await roles.remove(created.id), false, 'second delete is a no-op');
});

t.test('roles reject invalid input', async (t) => {
  const { roles } = repos();

  await t.rejects(roles.create({ description: 'nameless' }), /Role Name is required/);
  await t.rejects(roles.create({ name: 'a', permissions: ['ghosts:read'] }), /Unknown permission/);

  await roles.create({ name: 'dupe' });
  await t.rejects(roles.create({ name: 'dupe' }), ValidationError, 'unique name enforced');
  await t.rejects(roles.create({ name: 'DUPE' }), /already exists/, 'case-insensitively');
});

t.test('system roles cannot be deleted', async (t) => {
  const { roles } = repos();
  const system = await roles.create({ name: 'admin', is_system: true });
  await t.rejects(roles.remove(system.id), /system role and cannot be deleted/);
  t.equal((await roles.findAll()).length, 1, 'still there');
});

t.test('users CRUD, and permissions come only from roles', async (t) => {
  const { users, roles } = repos();

  const reader = await roles.create({ name: 'reader', permissions: ['users:read'] });
  const writer = await roles.create({
    name: 'writer',
    permissions: ['users:read', 'users:create', 'users:update'],
  });

  const user = await users.create({
    email: 'alice@example.com',
    first_name: 'Alice',
    last_name: 'Ng',
    password: 'Secret123!',
    roles: [reader.id],
  });

  t.equal(user.email, 'alice@example.com');
  t.equal(user.is_active, true, 'declared default applied');
  t.same(user.roles.map((role) => role.name), ['reader']);
  t.same(user.permissions, ['users:read'], 'derived from the single role');

  // The union across roles, deduplicated.
  const promoted = await users.update(user.id, { roles: [reader.id, writer.id] });
  t.same(promoted.roles.map((r) => r.name).sort(), ['reader', 'writer']);
  t.same(promoted.permissions, ['users:create', 'users:read', 'users:update']);

  const demoted = await users.update(user.id, { roles: [] });
  t.same(demoted.roles, []);
  t.same(demoted.permissions, [], 'a user with no roles can do nothing');

  /*
   * The delete half uses a second account, because the first row in the table
   * is the one the installation was bootstrapped with and the model refuses to
   * remove it — see FIRST_USER_ID in models/users.js. In a fresh repository
   * that is whoever was created first, which is Alice above.
   */
  await t.rejects(
    users.remove(user.id),
    /first account cannot be deleted/,
    'the first row is the way back in, and is kept'
  );

  const second = await users.create({
    email: 'bob@example.com',
    first_name: 'Bob',
    password: 'Secret123!',
  });
  t.equal(await users.remove(second.id), true, 'any other account is ordinary');
  t.same(
    (await users.findAll()).map((row) => row.email),
    ['alice@example.com'],
    'and only the first one is left'
  );
});

t.test('passwords are hashed and never returned', async (t) => {
  const { users } = repos();

  const user = await users.create({ email: 'b@example.com', first_name: 'Bob', last_name: 'Ray', password: 'Pw123456!' });
  t.notOk('password' in user, 'no password key');
  t.notOk('password_hash' in user, 'no hash key either');
  t.notMatch(JSON.stringify(await users.findAll()), /Pw123456!/, 'the plaintext never surfaces');

  const unchanged = await users.update(user.id, { first_name: 'Bobby' });
  t.equal(unchanged.name, 'Bobby Ray', 'the derived name follows the field');
  t.notOk('password_hash' in unchanged);
});

t.test('user validation', async (t) => {
  const { users } = repos();

  await t.rejects(users.create({ first_name: 'No', last_name: 'Email', password: 'Passw0rd!' }), /Email Address is required/);
  await t.rejects(users.create({ email: 'a@b.c', password: 'Passw0rd!' }), /First Name is required/);
  await t.rejects(users.create({ email: 'a@b.c', first_name: 'A', last_name: 'B' }), /Password is required/);

  await users.create({ email: 'dupe@example.com', first_name: 'A', last_name: 'B', password: 'Passw0rd!' });
  await t.rejects(
    users.create({ email: 'dupe@example.com', first_name: 'C', last_name: 'D', password: 'Other0rd!' }),
    /already exists/
  );
});

t.test('deleting a role revokes it from its holders', async (t) => {
  const { users, roles } = repos();

  const temp = await roles.create({ name: 'temp', permissions: ['users:read'] });
  const keep = await roles.create({ name: 'keep', permissions: ['roles:read'] });
  const user = await users.create({
    email: 'c@example.com',
    first_name: 'Carol',
    last_name: 'Vo',
    password: 'Passw0rd!',
    roles: [temp.id, keep.id],
  });
  t.equal(user.permissions.length, 2);

  await roles.remove(temp.id);

  const after = await users.findById(user.id);
  t.same(after.roles.map((role) => role.name), ['keep'], 'the dropped role is gone');
  t.same(after.permissions, ['roles:read'], 'and so are the permissions it granted');
});

t.test('search filters on the declared searchable fields', async (t) => {
  const { users } = repos();

  await users.create({ email: 'ann@example.com', first_name: 'Ann', last_name: 'Shaw', password: 'Passw0rd!' });
  await users.create({ email: 'bob@other.org', first_name: 'Bob', last_name: 'Tran', password: 'Passw0rd!' });

  t.equal((await users.findAll({ search: 'ann' })).length, 1, 'matches name');
  t.equal((await users.findAll({ search: 'other.org' })).length, 1, 'matches email');
  t.equal((await users.findAll({ search: 'ANN' })).length, 1, 'case-insensitive');
  t.equal((await users.findAll({ search: 'nobody' })).length, 0);
  t.equal((await users.findAll({})).length, 2, 'no search returns everything');
});

t.test('user groups CRUD, with an owner and members', async (t) => {
  const { users, user_groups: groups } = repos();

  const owner = await users.create({
    email: 'owner@example.com', first_name: 'Ola', last_name: 'Berg', password: 'Passw0rd!',
  });
  const member = await users.create({
    email: 'member@example.com', first_name: 'Mel', last_name: 'Poe', password: 'Passw0rd!',
  });

  const group = await groups.create({ owner: owner.id, members: [owner.id, member.id] });

  t.equal(group.owner, owner.id, 'the owner is returned as a plain id');
  t.ok(group.created_at, 'the creation time comes from the table every model gets');
  t.same(
    group.members.map((user) => user.email).sort(),
    ['member@example.com', 'owner@example.com'],
    'members are hydrated rows, not ids'
  );

  const shrunk = await groups.update(group.id, { members: [owner.id] });
  t.same(shrunk.members.map((user) => user.id), [owner.id], 'membership is replaced wholesale');
  t.equal(shrunk.uuid, group.uuid, 'the identifier survives an update');

  await t.rejects(groups.create({}), /Owner is required/);

  t.equal(await groups.remove(group.id), true);
  t.same(await groups.findAll(), []);
});

t.test('every row carries a uuid of its own', async (t) => {
  const { users, roles } = repos();

  const role = await roles.create({ name: 'stamped' });
  const user = await users.create({
    email: 'uuid@example.com', first_name: 'You', last_name: 'Eyed', password: 'Passw0rd!',
  });

  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  t.match(user.uuid, UUID, 'assigned without being asked for');
  t.match(role.uuid, UUID, 'on every model, not just one');
  t.not(user.uuid, role.uuid, 'and unique across models, not only within one');

  t.equal((await users.findById(user.id)).uuid, user.uuid, 'stable across reads');
  t.equal((await users.findAll())[0].uuid, user.uuid);

  const renamed = await users.update(user.id, { first_name: 'Yew' });
  t.equal(renamed.uuid, user.uuid, 'and across writes');
});

t.test('an own-scoped listing only sees the owner rows', async (t) => {
  const { users, user_groups: groups, roles } = repos();

  const mine = await users.create({
    email: 'mine@example.com', first_name: 'My', last_name: 'Ne', password: 'Passw0rd!',
  });
  const theirs = await users.create({
    email: 'theirs@example.com', first_name: 'The', last_name: 'Irs', password: 'Passw0rd!',
  });

  await groups.create({ owner: mine.id, members: [mine.id] });
  await groups.create({ owner: mine.id, members: [] });
  await groups.create({ owner: theirs.id, members: [mine.id] });

  t.equal((await groups.findAll()).length, 3, 'unfiltered sees everything');
  t.equal((await groups.findAll({ owner: mine.id })).length, 2);
  t.equal((await groups.findAll({ owner: theirs.id })).length, 1);
  t.equal(
    (await groups.findAll({ owner: theirs.id }))[0].members.length,
    1,
    'membership is not ownership'
  );

  await t.rejects(
    async () => roles.findAll({ owner: mine.id }),
    /has no owner to filter on/,
    'a model nobody owns cannot be filtered by owner'
  );
});

t.test('a user can belong to several groups', async (t) => {
  const { users, user_groups: groups } = repos();

  const user = await users.create({
    email: 'joiner@example.com', first_name: 'Jo', last_name: 'Iner', password: 'Passw0rd!',
  });
  const other = await users.create({
    email: 'second@example.com', first_name: 'Sec', last_name: 'Ond', password: 'Passw0rd!',
  });

  await groups.create({ owner: user.id, members: [user.id, other.id] });
  await groups.create({ owner: other.id, members: [user.id] });

  const all = await groups.findAll();
  t.equal(all.length, 2);
  t.equal(
    all.filter((group) => group.members.some((m) => m.id === user.id)).length,
    2,
    'the same user is in both'
  );
});

t.test('membership sees the whole group, ownership only your own row', async (t) => {
  const { users, user_groups: groups, user_messages: messages } = repos();

  const ada = await users.create({
    email: 'ada@example.com', first_name: 'Ada', last_name: 'L', password: 'Passw0rd!',
  });
  const grace = await users.create({
    email: 'grace@example.com', first_name: 'Grace', last_name: 'H', password: 'Passw0rd!',
  });
  const outsider = await users.create({
    email: 'out@example.com', first_name: 'Out', last_name: 'Sider', password: 'Passw0rd!',
  });

  const shared = await groups.create({ owner: ada.id, members: [ada.id, grace.id] });
  const private_ = await groups.create({ owner: outsider.id, members: [outsider.id] });

  await messages.create({ owner: ada.id, group: shared.id, value: 'From Ada' });
  await messages.create({ owner: grace.id, group: shared.id, value: 'From Grace' });
  await messages.create({ owner: outsider.id, group: private_.id, value: 'Elsewhere' });

  // Grace is a member of the shared group but owns neither it nor most of it.
  t.same(
    (await groups.findAll({ member: grace.id })).map((group) => group.id),
    [shared.id],
    'a member sees the group without owning it'
  );
  t.same(
    (await groups.findAll({ owner: grace.id })).map((group) => group.id),
    [],
    'while ownership alone would show her nothing'
  );

  t.same(
    (await messages.findAll({ member: grace.id })).map((message) => message.value),
    ['From Ada', 'From Grace'],
    'and she sees what everyone in her group said, not only her own'
  );
  t.same(
    (await messages.findAll({ member: outsider.id })).map((message) => message.value),
    ['Elsewhere'],
    'membership of one group is not membership of another'
  );

  const [adaMessage] = await messages.findAll({ owner: ada.id });
  t.ok(await messages.isMemberOf(adaMessage.id, grace.id), 'a row check agrees with the filter');
  t.notOk(await messages.isMemberOf(adaMessage.id, outsider.id));
  t.ok(await groups.isMemberOf(shared.id, grace.id));
  t.notOk(await groups.isMemberOf(private_.id, grace.id));
});

t.test('belonging to nothing shows nothing', async (t) => {
  const { users, user_groups: groups, user_messages: messages } = repos();

  const loner = await users.create({
    email: 'loner@example.com', first_name: 'Lo', last_name: 'Ner', password: 'Passw0rd!',
  });
  const other = await users.create({
    email: 'other@example.com', first_name: 'Oth', last_name: 'Er', password: 'Passw0rd!',
  });
  const group = await groups.create({ owner: other.id, members: [other.id] });
  await messages.create({ owner: other.id, group: group.id, value: 'Not for you' });

  t.same(await groups.findAll({ member: loner.id }), [], 'no groups');
  t.same(await messages.findAll({ member: loner.id }), [], 'and so no messages either');

  await t.rejects(
    async () => users.findAll({ member: loner.id }),
    /has no membership to filter on/,
    'a model nobody can belong to says so rather than answering'
  );
});

t.test('findByIds only returns what exists', async (t) => {
  const { roles } = repos();
  const one = await roles.create({ name: 'one' });
  const two = await roles.create({ name: 'two' });

  t.same((await roles.findByIds([one.id, two.id])).map((r) => r.name), ['one', 'two']);
  t.same(await roles.findByIds([]), []);
  t.same(await roles.findByIds([9999]), []);
});

/**
 * ON DELETE, as the in-memory driver has to imitate it.
 *
 * There are no foreign keys here, so the driver reads the intent back off the
 * models: every reference pointing at a deleted row is either removed with it
 * or blanked, according to that field's onDelete. Postgres does this itself, so
 * the point of testing it is that the two drivers agree — a group deleted on one
 * must not leave behind rows the other would have taken.
 */
t.test('deleting a row takes everything keyed to it', async (t) => {
  const {
    users, user_groups: groups, user_messages: messages,
    user_group_reads: reads, files,
  } = repos();

  const author = await users.create({
    email: 'cascade@example.com', first_name: 'Cas', last_name: 'Cade', password: 'Passw0rd!',
  });
  const group = await groups.create({ owner: author.id, members: [author.id] });
  const elsewhere = await groups.create({ owner: author.id, members: [author.id] });

  const file = await files.create({
    owner: author.id,
    name: 'notes.txt',
    size: 12,
    mime_type: 'text/plain',
    // No object is ever written: this is about the row, and the local provider
    // shrugs at being asked to forget something it never stored.
    provider_name: 'local',
    provider_id: 'cascade/notes.txt',
  });
  const first = await messages.create({
    owner: author.id, group: group.id, value: 'with a file', files: [file.id],
  });
  await messages.create({
    owner: author.id, group: group.id, value: 'a reply', reply_to: first.id,
  });
  const outside = await messages.create({
    owner: author.id, group: elsewhere.id, value: 'somewhere else',
  });
  await reads.create({
    user: author.id, group: group.id, last_read_at: new Date(0).toISOString(),
  });

  t.equal((await messages.findAll()).length, 3);

  t.ok(await groups.remove(group.id), 'the group goes');

  t.same(
    (await messages.findAll()).map((message) => message.id),
    [outside.id],
    'and the messages in it, leaving the ones in other groups alone'
  );
  t.same(await reads.findAll(), [], 'and the read markers for it');
  t.equal(
    await files.findById(file.id),
    null,
    'and the attachment on one of those messages, the message hook having run'
  );
  t.ok(await groups.findById(elsewhere.id), 'the other group is untouched');
});

t.test('a reference that is declared SET NULL is blanked, not followed', async (t) => {
  const { users, user_groups: groups, user_messages: messages } = repos();

  const author = await users.create({
    email: 'reply@example.com', first_name: 'Rep', last_name: 'Ly', password: 'Passw0rd!',
  });
  const group = await groups.create({ owner: author.id, members: [author.id] });

  const original = await messages.create({ owner: author.id, group: group.id, value: 'a claim' });
  const answer = await messages.create({
    owner: author.id, group: group.id, value: 'a rebuttal', reply_to: original.id,
  });

  await messages.remove(original.id);

  const stranded = await messages.findById(answer.id);
  t.ok(stranded, 'a reply outlives what it answered');
  t.equal(stranded.reply_to, null, 'with nothing left to point at');
});

/**
 * The question the attachment collector asks, and the reason it exists: reading
 * every message to find out what points at a file is a scan of the whole table
 * to answer something about three ids.
 */
t.test('linkedTargets answers which targets are still spoken for', async (t) => {
  const { users, user_groups: groups, user_messages: messages, files } = repos();

  const author = await users.create({
    email: 'links@example.com', first_name: 'Lin', last_name: 'Ks', password: 'Passw0rd!',
  });
  const group = await groups.create({ owner: author.id, members: [author.id] });

  const made = [];
  for (const name of ['one.txt', 'two.txt', 'loose.txt']) {
    made.push(await files.create({
      owner: author.id, name, size: 1, provider_name: 'local', provider_id: `k/${name}`,
    }));
  }
  const [one, two, loose] = made;

  const first = await messages.create({
    owner: author.id, group: group.id, value: 'both', files: [one.id, two.id],
  });
  await messages.create({
    owner: author.id, group: group.id, value: 'one of them again', files: [two.id],
  });

  t.same(
    (await messages.linkedTargets('files', [one.id, two.id, loose.id])).sort((a, b) => a - b),
    [one.id, two.id],
    'the uploaded-but-unattached one is not linked to anything'
  );

  await messages.remove(first.id);

  t.same(
    await messages.linkedTargets('files', [one.id, two.id]),
    [two.id],
    'and after the first message goes, only the shared one is still held'
  );
  t.equal(await files.findById(one.id), null, 'so the other went with the message');
  t.ok(await files.findById(two.id), 'while the shared one stayed');

  t.same(await messages.linkedTargets('files', []), [], 'nothing asked, nothing answered');
  t.same(await messages.linkedTargets('files', ['nonsense']), [], 'and no id is no id');

  await t.rejects(
    messages.linkedTargets('owner', [1]),
    /no many-to-many relation "owner"/,
    'a reference field is not a link table'
  );
});

/**
 * The indexes are declared by the models and applied by db/schema.js, so what
 * is testable without Postgres is the declaration: that every query this
 * application makes on a column other than a primary key has one behind it.
 */
t.test('every model declares the indexes its queries need', async (t) => {
  const { modelList } = await import('../../server/db/models/index.js');
  const statements = modelList.flatMap((model) => model.indexes());

  for (const statement of statements) {
    t.match(statement, /^CREATE INDEX IF NOT EXISTS /, `idempotent: ${statement}`);
  }

  const has = (fragment) => t.ok(
    statements.some((statement) => statement.includes(fragment)),
    fragment
  );

  // Foreign keys: Postgres indexes none of them itself, and ON DELETE CASCADE
  // has to find the children of every row it removes.
  has('ON user_messages (group_id)');
  has('ON user_messages (owner_id)');
  has('ON user_messages (reply_to_id)');
  has('ON user_group_reads (group_id)');
  has('ON user_group_reads (user_id)');
  has('ON user_groups (owner_id)');
  has('ON files (owner_id)');

  // Link tables, on the side their primary key does not lead with. The first is
  // "which groups is this user in", asked on every member-scoped request.
  has('ON user_group_users (user_id)');
  has('ON user_message_files (file_id)');
  has('ON user_roles (role_id)');

  // findRawBy compares case insensitively, so the unique btree cannot serve it.
  // This is the lookup behind every sign-in.
  has('ON users (LOWER(email))');

  // Declared by hand: a foreign key in all but name, so no rule can see it.
  has('ON users (logo_file)');

  t.notOk(
    statements.some((statement) => statement.includes('(id)')),
    'nothing indexes a primary key twice over'
  );
  t.notOk(
    statements.some((statement) => statement.includes('ON users (email)')),
    'nor a unique column, which its constraint already indexed'
  );
});
