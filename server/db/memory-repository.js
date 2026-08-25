import { ValidationError } from './models/fields.js';
import { modelList } from './models/index.js';

const DEFAULT_DEPTH = 2;

/**
 * Array-backed driver used when no database is reachable, so the app still
 * boots and the admin UI still works. Mirrors the Postgres driver's interface
 * exactly — nothing above this layer knows which one it is talking to.
 */
export function createMemoryRepository(model, getRepo) {
  const visible = Object.values(model.fields).filter((field) => !field.hidden);
  const rows = [];
  // relationName -> Map(ownerId -> values)
  const links = new Map(Object.keys(model.relations).map((name) => [name, new Map()]));

  /*
   * What a link row carries beyond the two keys, for the relations that carry
   * anything: relationName -> Map("<owner>:<target>" -> { column: value }).
   *
   * Kept beside `links` rather than folded into it so that hydration, the
   * membership filter and linkedTargets go on reading the plain list of ids
   * they always did. Postgres puts these values in columns on the link table;
   * here they are a second map keyed by the same pair.
   */
  const payloads = new Map(
    Object.values(model.relations)
      .filter((relation) => relation.carriesPayload)
      .map((relation) => [relation.name, new Map()])
  );

  const pairKey = (owner, target) => `${Number(owner)}:${Number(target)}`;

  /**
   * Applies a new member list to a payload-carrying relation, keeping what the
   * surviving pairs were holding — the counterpart of the reconciling branch
   * in the Postgres driver's writeRelations, and for the same reason: a
   * membership change must not reset everybody else's read position.
   */
  const reconcile = (relation, ownerId, values) => {
    const carried = payloads.get(relation.name);
    const kept = new Set(values.map(Number));

    for (const key of [...carried.keys()]) {
      const [owner, target] = key.split(':').map(Number);
      if (owner === Number(ownerId) && !kept.has(target)) carried.delete(key);
    }
  };
  let nextId = 1;

  function assertUnique(input, ignoreId = null) {
    for (const field of Object.values(model.fields)) {
      if (!field.unique) continue;
      const value = input[field.column];
      if (value === undefined || value === null) continue;

      const clash = rows.some(
        (row) =>
          row.id !== ignoreId &&
          String(row[field.column]).toLowerCase() === String(value).toLowerCase()
      );
      if (clash) {
        throw new ValidationError(
          `A ${model.label.replace(/s$/, '')} with that ${field.label.toLowerCase()} already exists.`
        );
      }
    }
  }

  async function hydrate(sourceRows, depth) {
    const result = [];

    for (const source of sourceRows) {
      const row = {
        id: source.id,
        uuid: source.uuid,
        created_at: source.created_at,
        updated_at: source.updated_at,
      };
      for (const field of visible) {
        const stored = field.serialize
          ? field.serialize(source[field.column])
          : source[field.column];
        // An optional column that was never set is absent from the object here,
        // but NULL in Postgres. Normalise to null so both drivers hand a client
        // the same shape — otherwise `undefined` silently vanishes in JSON and
        // the key disappears entirely.
        row[field.name] = stored ?? null;
      }

      for (const relation of Object.values(model.relations)) {
        const values = links.get(relation.name).get(source.id) || [];
        if (depth <= 0) {
          row[relation.name] = [];
        } else if (relation.kind === 'permissionSet') {
          row[relation.name] = [...values].sort();
        } else {
          row[relation.name] = await getRepo(relation.target).findByIds(values, depth - 1);
        }
      }

      model.transform(row);
      result.push(row);
    }

    return result;
  }

  /**
   * The filter a member-scoped request adds: rows whose `column` is one of
   * `values`. A model that decides membership itself matches on its own id; a
   * model that defers to another (a message to its group) matches on the key
   * pointing there, over the ids that model would show the same member.
   */
  async function memberFilter(userId) {
    const relation = model.membershipRelation;
    if (relation) {
      const held = links.get(relation.name);
      const ids = [...held.entries()]
        .filter(([, members]) => members.some((id) => Number(id) === Number(userId)))
        .map(([rowId]) => rowId);
      return { column: 'id', values: ids };
    }

    const via = model.membershipVia;
    if (via) {
      const rows = await getRepo(via.target).findAll({ member: userId }, 0);
      return { column: via.column, values: rows.map((row) => row.id) };
    }

    throw new Error(`Model "${model.name}" has no membership to filter on.`);
  }

  /**
   * Every foreign key in the application that points at this model, as
   * [model name, field] pairs.
   *
   * Read off the registry rather than declared anywhere: a model states what it
   * points at, so what points at it is the same information looked at from the
   * other end. Computed once per repository, since the registry is complete and
   * frozen before any of them is built.
   */
  const referrers = modelList.flatMap((other) =>
    Object.values(other.fields)
      .filter((field) => field.type === 'reference' && field.target === model.name)
      .map((field) => [other.name, field])
  );

  /**
   * ON DELETE, with no database to enforce it.
   *
   * Postgres removes or blanks every row whose foreign key pointed at the one
   * just deleted, and nothing above the driver has to know it happened. This
   * one has no keys at all, so it reads the same intent back off the models and
   * does it by hand — otherwise a deleted group would leave its messages, and
   * their read markers, pointing at an id that is not there any more.
   *
   * Each referring row goes through its own repository rather than being spliced
   * out of an array, which is what makes the cascade recursive and what runs the
   * models' own afterDelete hooks on the way down: deleting a group removes the
   * messages in it, and removing a message takes its attachments — rows and
   * bytes both — with it.
   *
   * One difference from Postgres worth knowing, and it is not this function's
   * doing: there, the database performs the cascade itself, so those hooks never
   * run and an orphaned attachment waits for the sweep in plugins/files.js
   * instead. This driver collects it immediately.
   */
  async function cascade(deletedId) {
    for (const [name, field] of referrers) {
      const referrer = getRepo(name);
      // Depth 0: only the key matters, and hydrating rows that are about to be
      // deleted would walk every model they point at for nothing.
      const pointing = (await referrer.findAll({}, 0))
        .filter((row) => Number(row[field.name]) === Number(deletedId));

      for (const row of pointing) {
        if (field.onDelete === 'SET NULL') {
          await referrer.update(row.id, { [field.name]: null });
        } else {
          await referrer.remove(row.id);
        }
      }
    }
  }

  const repository = {
    model,

    async findAll({ search, owner, member, match } = {}, depth = DEFAULT_DEPTH) {
      let matched = rows;

      // Narrowing by a foreign key; see the Postgres driver for what it is for.
      for (const [column, value] of Object.entries(match || {})) {
        matched = matched.filter((row) => Number(row[column]) === Number(value));
      }
      if (search && model.searchable.length > 0) {
        const needle = search.toLowerCase();
        matched = matched.filter((row) =>
          model.searchable.some((name) =>
            String(row[model.fields[name].column] ?? '').toLowerCase().includes(needle)
          )
        );
      }
      if (owner !== undefined) {
        if (!model.ownerColumn) throw new Error(`Model "${model.name}" has no owner to filter on.`);
        matched = matched.filter((row) => Number(row[model.ownerColumn]) === Number(owner));
      }
      if (member !== undefined) {
        const { column, values } = await memberFilter(member);
        matched = matched.filter((row) => values.some((id) => Number(id) === Number(row[column])));
      }
      return hydrate(matched, depth);
    },

    async findByIds(ids, depth = DEFAULT_DEPTH) {
      const wanted = new Set(ids);
      return hydrate(rows.filter((row) => wanted.has(row.id)), depth);
    },

    /**
     * Raw row including hidden columns, matched on a single field. The only
     * way to reach a password hash — for credential checks and nothing else.
     * Never hand the result to a client.
     */
    async findRawBy(fieldName, value) {
      const field = model.fields[fieldName];
      if (!field) throw new Error(`Model "${model.name}" has no field "${fieldName}".`);

      const matches = (row) =>
        field.type === 'string' || field.type === 'text'
          ? String(row[field.column]).toLowerCase() === String(value).toLowerCase()
          : row[field.column] === value;

      return rows.find(matches) || null;
    },

    async findById(id, depth = DEFAULT_DEPTH) {
      const numericId = Number.parseInt(id, 10);
      if (Number.isNaN(numericId)) return null;
      const [row] = await repository.findByIds([numericId], depth);
      return row || null;
    },

    /** Is this row one of the ones that member is entitled to? */
    async isMemberOf(id, userId) {
      const numericId = Number.parseInt(id, 10);
      if (Number.isNaN(numericId)) return false;

      const row = rows.find((candidate) => candidate.id === numericId);
      if (!row) return false;

      const { column, values } = await memberFilter(userId);
      return values.some((value) => Number(value) === Number(row[column]));
    },


    /**
     * Which of `targetIds` are still linked to a row of this model through
     * `relationName`.
     *
     * The one question a many-to-many cannot be asked from the owning side: not
     * "what does this row point at" but "is anything else still pointing at
     * these". It is put to the link table directly, because the alternative is
     * reading every row of this model and hydrating what each one points at —
     * a scan of the whole table to answer a question about three ids.
     *
     * user_messages' afterDelete is the caller: an attachment goes when the last
     * message carrying it does, and this is how it knows it was the last.
     */
    async linkedTargets(relationName, targetIds) {
      const relation = model.relations[relationName];
      if (relation?.kind !== 'manyToMany') {
        throw new Error(`Model "${model.name}" has no many-to-many relation "${relationName}".`);
      }

      const wanted = new Set(
        targetIds.map((id) => Number.parseInt(id, 10)).filter((id) => !Number.isNaN(id))
      );
      if (wanted.size === 0) return [];

      const found = new Set();
      for (const values of links.get(relationName).values()) {
        for (const value of values) {
          if (wanted.has(Number(value))) found.add(Number(value));
        }
      }
      return [...found];
    },

    /** The link rows of a payload-carrying relation, by either end. */
    async readLinks(relationName, { owner, target } = {}) {
      const relation = model.relations[relationName];
      if (relation?.kind !== 'manyToMany') {
        throw new Error(`Model "${model.name}" has no many-to-many relation "${relationName}".`);
      }

      const carried = payloads.get(relationName);
      const found = [];

      for (const [ownerId, values] of links.get(relationName)) {
        if (owner !== undefined && Number(ownerId) !== Number(owner)) continue;

        for (const targetId of values) {
          if (target !== undefined && Number(targetId) !== Number(target)) continue;

          const held = carried?.get(pairKey(ownerId, targetId)) || {};
          const link = { owner: Number(ownerId), target: Number(targetId) };
          for (const field of Object.values(relation.columns)) {
            const value = held[field.name] ?? null;
            link[field.name] = value !== null && field.serialize ? field.serialize(value) : value;
          }
          found.push(link);
        }
      }
      return found;
    },

    /** Writes payload onto one existing link row; false when there is none. */
    async writeLink(relationName, owner, target, values = {}) {
      const relation = model.relations[relationName];
      if (relation?.kind !== 'manyToMany') {
        throw new Error(`Model "${model.name}" has no many-to-many relation "${relationName}".`);
      }

      const held = links.get(relationName).get(Number(owner)) || [];
      if (!held.some((id) => Number(id) === Number(target))) return false;

      const carried = payloads.get(relationName);
      const parsed = { ...(carried.get(pairKey(owner, target)) || {}) };

      for (const [name, value] of Object.entries(values)) {
        const field = relation.columns[name];
        if (!field) {
          throw new Error(`Relation "${relationName}" has no link column "${name}".`);
        }
        parsed[name] = value === null || value === '' ? null : await field.parse(value);
      }

      carried.set(pairKey(owner, target), parsed);
      return true;
    },

    /** The same summary the Postgres driver aggregates; see it for what and why. */
    async countNewer(fieldName, buckets, { notOwnedBy } = {}) {
      const field = model.fields[fieldName];
      if (field?.type !== 'reference') {
        throw new Error(`Model "${model.name}" has no reference field "${fieldName}".`);
      }
      if (notOwnedBy !== undefined && !model.ownerColumn) {
        throw new Error(`Model "${model.name}" has no owner to exclude.`);
      }

      return buckets.map((bucket) => {
        const pointing = rows.filter(
          (row) => Number(row[field.column]) === Number(bucket.id)
        );
        const since = bucket.since === null || bucket.since === undefined
          ? null
          : Date.parse(bucket.since);

        let newer = 0;
        let latest = null;
        for (const row of pointing) {
          if (latest === null || row.id > latest) latest = row.id;

          if (notOwnedBy !== undefined
            && Number(row[model.ownerColumn]) === Number(notOwnedBy)) continue;
          if (since !== null && Date.parse(row.created_at) <= since) continue;
          newer += 1;
        }

        return { id: Number(bucket.id), newer, latest };
      });
    },

    async create(input) {
      const { columns, relations } = await model.parseInput(input);
      assertUnique(columns);

      const now = new Date().toISOString();
      const row = {
        id: nextId++,
        ...model.generatedValues(),
        ...columns,
        created_at: now,
        updated_at: now,
      };
      rows.push(row);

      for (const [name, values] of Object.entries(relations)) {
        if (model.relations[name].carriesPayload) reconcile(model.relations[name], row.id, values);
        links.get(name).set(row.id, values);
      }
      return repository.findById(row.id);
    },

    async update(id, input) {
      const numericId = Number.parseInt(id, 10);
      const row = rows.find((candidate) => candidate.id === numericId);
      if (!row) return null;

      const { columns, relations } = await model.parseInput(input, { partial: true });
      assertUnique(columns, numericId);

      Object.assign(row, columns, { updated_at: new Date().toISOString() });
      for (const [name, values] of Object.entries(relations)) {
        if (model.relations[name].carriesPayload) {
          reconcile(model.relations[name], numericId, values);
        }
        links.get(name).set(numericId, values);
      }
      return repository.findById(numericId);
    },

    async remove(id) {
      const numericId = Number.parseInt(id, 10);
      const index = rows.findIndex((row) => row.id === numericId);
      if (index === -1) return false;

      // Hydrated, not bare: afterDelete gets the row as it was, relations and
      // all, which is the only moment a model can still see what it carried.
      const existing = await repository.findById(numericId);
      await model.beforeDelete(existing);

      rows.splice(index, 1);
      for (const relationLinks of links.values()) relationLinks.delete(numericId);
      // The link rows cascade, and what they carried goes with them.
      for (const carried of payloads.values()) {
        for (const key of [...carried.keys()]) {
          if (Number(key.split(':')[0]) === numericId) carried.delete(key);
        }
      }

      // What the foreign keys would have done, before the model is told: a
      // hook tidying up should see the same world Postgres would have left it.
      await cascade(numericId);

      // After the row is gone, so a model tidying up outside the database
      // cannot leave it half-deleted.
      await model.afterDelete(existing, { getRepo });
      return true;
    },
  };

  return repository;
}
