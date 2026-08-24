import { ValidationError } from './models/fields.js';
import { permissionKey, parsePermission } from './models/catalog.js';
import { query, withTransaction } from './index.js';

// Deep enough for users -> roles -> permissions. Bumping this only matters if
// a model relates to another model that itself has relations worth eager-loading.
const DEFAULT_DEPTH = 2;

/** Turns a unique-constraint violation into a message a user can act on. */
function asFriendlyError(model, err) {
  if (err.code !== '23505') return err;
  const field = Object.values(model.fields).find(
    (f) => f.unique && String(err.detail || err.constraint || '').includes(f.column)
  );
  return new ValidationError(
    field
      ? `A ${model.label.replace(/s$/, '')} with that ${field.label.toLowerCase()} already exists.`
      : 'That value is already taken.'
  );
}

export function createPgRepository(model, getRepo) {
  const visible = Object.values(model.fields).filter((field) => !field.hidden);
  const selectList = [
    'id',
    'uuid',
    ...visible.map((field) => `${field.column} AS "${field.name}"`),
    'created_at',
    'updated_at',
  ].join(', ');

  async function loadRelation(relation, rows, depth) {
    const ids = rows.map((row) => row.id);
    const grouped = new Map(ids.map((id) => [id, []]));

    if (relation.kind === 'permissionSet') {
      const res = await query(
        `SELECT ${relation.localKey} AS owner_id, model, action, scope
         FROM ${relation.through} WHERE ${relation.localKey} = ANY($1::int[])`,
        [ids]
      );
      for (const link of res.rows) {
        grouped.get(link.owner_id)?.push(permissionKey(link.model, link.action, link.scope));
      }
      for (const row of rows) row[relation.name] = (grouped.get(row.id) || []).sort();
      return;
    }

    const res = await query(
      `SELECT ${relation.localKey} AS owner_id, ${relation.targetKey} AS target_id
       FROM ${relation.through} WHERE ${relation.localKey} = ANY($1::int[])`,
      [ids]
    );
    const targetIds = [...new Set(res.rows.map((link) => link.target_id))];
    const targets = await getRepo(relation.target).findByIds(targetIds, depth - 1);
    const byId = new Map(targets.map((target) => [target.id, target]));

    for (const link of res.rows) {
      const target = byId.get(link.target_id);
      if (target) grouped.get(link.owner_id)?.push(target);
    }
    for (const row of rows) row[relation.name] = grouped.get(row.id) || [];
  }

  async function hydrate(rows, depth) {
    if (rows.length === 0) return rows;

    for (const field of visible) {
      if (!field.serialize) continue;
      for (const row of rows) row[field.name] = field.serialize(row[field.name]);
    }

    for (const relation of Object.values(model.relations)) {
      if (depth > 0) await loadRelation(relation, rows, depth);
      else for (const row of rows) row[relation.name] = [];
    }

    for (const row of rows) model.transform(row);
    return rows;
  }

  async function writeRelations(client, id, relations) {
    for (const [name, values] of Object.entries(relations)) {
      const relation = model.relations[name];

      // Relations are replaced wholesale, so a submitted list is authoritative.
      await query(`DELETE FROM ${relation.through} WHERE ${relation.localKey} = $1`, [id], client);
      if (values.length === 0) continue;

      if (relation.kind === 'permissionSet') {
        const parsed = values.map(parsePermission);
        // $1 is cast explicitly: Postgres cannot infer a parameter's type from
        // a bare SELECT list position.
        await query(
          `INSERT INTO ${relation.through} (${relation.localKey}, model, action, scope)
           SELECT $1::int, * FROM UNNEST($2::text[], $3::text[], $4::text[])`,
          [
            id,
            parsed.map((p) => p.model),
            parsed.map((p) => p.action),
            parsed.map((p) => p.scope),
          ],
          client
        );
      } else {
        await query(
          `INSERT INTO ${relation.through} (${relation.localKey}, ${relation.targetKey})
           SELECT $1::int, UNNEST($2::int[])`,
          [id, values],
          client
        );
      }
    }
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
      const res = await query(
        `SELECT ${relation.localKey} AS id FROM ${relation.through} WHERE ${relation.targetKey} = $1`,
        [userId]
      );
      return { column: 'id', values: res.rows.map((row) => row.id) };
    }

    const via = model.membershipVia;
    if (via) {
      const rows = await getRepo(via.target).findAll({ member: userId }, 0);
      return { column: via.column, values: rows.map((row) => row.id) };
    }

    throw new Error(`Model "${model.name}" has no membership to filter on.`);
  }

  const repository = {
    model,

    /**
     * `owner` restricts the result to rows belonging to that user id, and
     * `member` to the rows they are part of — how the own- and member-scoped
     * permissions are applied. Only a model declaring the one it is asked for
     * can answer.
     */
    async findAll({ search, owner, member } = {}, depth = DEFAULT_DEPTH) {
      const params = [];
      const clauses = [];

      if (search && model.searchable.length > 0) {
        params.push(`%${search}%`);
        const index = params.length;
        const matches = model.searchable.map(
          (name) => `${model.fields[name].column} ILIKE $${index}`
        );
        clauses.push(`(${matches.join(' OR ')})`);
      }

      if (owner !== undefined) {
        if (!model.ownerColumn) throw new Error(`Model "${model.name}" has no owner to filter on.`);
        params.push(owner);
        clauses.push(`${model.ownerColumn} = $${params.length}`);
      }

      if (member !== undefined) {
        const { column, values } = await memberFilter(member);
        // Belonging to nothing is not the same as no filter at all.
        if (values.length === 0) return [];
        params.push(values);
        clauses.push(`${column} = ANY($${params.length}::int[])`);
      }

      const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
      const res = await query(
        `SELECT ${selectList} FROM ${model.table} ${where} ORDER BY id ASC`,
        params
      );
      return hydrate(res.rows, depth);
    },

    async findByIds(ids, depth = DEFAULT_DEPTH) {
      if (ids.length === 0) return [];
      const res = await query(
        `SELECT ${selectList} FROM ${model.table} WHERE id = ANY($1::int[]) ORDER BY id ASC`,
        [ids]
      );
      return hydrate(res.rows, depth);
    },

    /**
     * Raw row including hidden columns, matched on a single field. The only
     * way to reach a password hash — for credential checks and nothing else.
     * Never hand the result to a client.
     */
    async findRawBy(fieldName, value) {
      const field = model.fields[fieldName];
      if (!field) throw new Error(`Model "${model.name}" has no field "${fieldName}".`);

      // Case-insensitive for text, so logging in is not case-sensitive on email.
      const comparison = field.type === 'string' || field.type === 'text'
        ? `LOWER(${field.column}) = LOWER($1)`
        : `${field.column} = $1`;

      const res = await query(
        `SELECT * FROM ${model.table} WHERE ${comparison} LIMIT 1`,
        [value]
      );
      return res.rows[0] || null;
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

      const { column, values } = await memberFilter(userId);
      if (values.length === 0) return false;

      const res = await query(
        `SELECT 1 FROM ${model.table} WHERE id = $1 AND ${column} = ANY($2::int[])`,
        [numericId, values]
      );
      return res.rowCount > 0;
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

      const ids = [...new Set(
        targetIds.map((id) => Number.parseInt(id, 10)).filter((id) => !Number.isNaN(id))
      )];
      if (ids.length === 0) return [];

      // The index behind this is idx_<through>_<targetKey>; the table's primary
      // key leads with the other column and would be no use here. See
      // Model#indexes.
      const res = await query(
        `SELECT DISTINCT ${relation.targetKey} AS id FROM ${relation.through}
         WHERE ${relation.targetKey} = ANY($1::int[])`,
        [ids]
      );
      return res.rows.map((row) => row.id);
    },

    async create(input) {
      const { columns, relations } = await model.parseInput(input);
      // Server-assigned columns (the uuid) go in alongside the declared ones,
      // which also means the insert is never empty.
      const values = { ...model.generatedValues(), ...columns };
      const names = Object.keys(values);
      const placeholders = names.map((_, index) => `$${index + 1}`);

      const insert = `INSERT INTO ${model.table} (${names.join(', ')})
           VALUES (${placeholders.join(', ')}) RETURNING id`;

      try {
        const id = await withTransaction(async (client) => {
          const res = await query(insert, Object.values(values), client);
          const newId = res.rows[0].id;
          await writeRelations(client, newId, relations);
          return newId;
        });
        return repository.findById(id);
      } catch (err) {
        throw asFriendlyError(model, err);
      }
    },

    async update(id, input) {
      const numericId = Number.parseInt(id, 10);
      if (Number.isNaN(numericId)) return null;

      const { columns, relations } = await model.parseInput(input, { partial: true });

      try {
        const updated = await withTransaction(async (client) => {
          if (Object.keys(columns).length > 0) {
            const assignments = Object.keys(columns).map((name, i) => `${name} = $${i + 1}`);
            assignments.push('updated_at = CURRENT_TIMESTAMP');
            const res = await query(
              `UPDATE ${model.table} SET ${assignments.join(', ')}
               WHERE id = $${Object.keys(columns).length + 1} RETURNING id`,
              [...Object.values(columns), numericId],
              client
            );
            if (res.rowCount === 0) return false;
          } else {
            const res = await query(
              `SELECT 1 FROM ${model.table} WHERE id = $1`, [numericId], client
            );
            if (res.rowCount === 0) return false;
          }

          await writeRelations(client, numericId, relations);
          return true;
        });

        return updated ? repository.findById(numericId) : null;
      } catch (err) {
        throw asFriendlyError(model, err);
      }
    },

    async remove(id) {
      const numericId = Number.parseInt(id, 10);
      if (Number.isNaN(numericId)) return false;

      // Hydrated, not bare: afterDelete gets the row as it was, relations and
      // all, which is the only moment a model can still see what it carried.
      const existing = await repository.findById(numericId);
      if (!existing) return false;
      model.beforeDelete(existing);

      // Side-table rows disappear via ON DELETE CASCADE.
      const res = await query(`DELETE FROM ${model.table} WHERE id = $1`, [numericId]);
      if (res.rowCount === 0) return false;

      // After the row is gone, so a model tidying up outside the database
      // cannot leave it half-deleted.
      await model.afterDelete(existing, { getRepo });
      return true;
    },
  };

  return repository;
}
