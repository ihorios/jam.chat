import { SCOPES } from '../db/models/catalog.js';
import { singular } from '../db/models/fields.js';

function notFound(label) {
  const error = new Error(`${label} not found`);
  error.statusCode = 404;
  return error;
}

/**
 * Builds the REST surface for a model from its definition. Only the actions a
 * model declares get routes, so a read-only model simply never exposes writes.
 *
 * Every route is gated on the permission its own model generates, so a newly
 * registered model is protected the moment it exists. A caller holding only
 * the `:own` form of that permission sees a version of the model containing
 * nothing but their own rows — including for lookups by id, where a row
 * belonging to somebody else is reported as missing rather than forbidden, so
 * the response says nothing about what exists outside their scope.
 *
 * Errors thrown here (including ValidationError from the model layer) are
 * turned into responses by plugins/error-handler.js.
 */
export function crudRoutes(model) {
  const listKey = model.name;
  const itemKey = singular(model.name);
  const label = singular(model.label);

  return async function routes(fastify) {
    const repository = fastify.models[model.name];
    // Declared as a route, and grantable to somebody: a model that publishes
    // no permission for an action has no way to let anyone through it.
    const can = (action) => model.actions.includes(action) && model.scopesFor(action).length > 0;
    const guard = (action) => ({ preHandler: fastify.authorize(model, action) });

    /**
     * The scope a read is answered at.
     *
     * `authorize` has already worked out the broadest one the caller holds.
     * `?scope=` lets them ask to be answered at a narrower one instead — which
     * is what the messenger uses: /chats is somebody's own conversations, and
     * an administrator opening it wants their own, not everybody's. The
     * dashboard asks for nothing and so still sees the whole model.
     *
     * Narrowing only, and clamped rather than refused: a scope broader than the
     * one granted falls back to the grant, so this can never become a way to
     * read past a permission. An unknown one is a mistake in the caller and is
     * said so, because answering it with everything would be the worst of both.
     */
    const readScope = (request) => {
      const asked = request.query?.scope;
      if (!asked || asked === request.scope) return request.scope;

      if (!model.scopesFor('read').includes(asked)) {
        const error = new Error(
          `"${asked}" is not a scope ${model.name} can be read at.`
        );
        error.statusCode = 400;
        throw error;
      }

      // SCOPES is broadest first, so a later index is the narrower scope.
      return SCOPES.indexOf(asked) > SCOPES.indexOf(request.scope) ? asked : request.scope;
    };

    /** The row, or nothing at all if this request has no business with it. */
    const findInScope = async (request, scope = request.scope) => {
      const row = await repository.findById(request.params.id);
      if (!row) return null;
      if (scope === 'own' && !model.ownedByUser(row, request.user.id)) return null;
      if (scope === 'member' && !(await repository.isMemberOf(row.id, request.user.id))) {
        return null;
      }
      return row;
    };

    /**
     * A scoped write is about the caller's own corner of the model, so what
     * puts it there is imposed rather than taken from the body — otherwise the
     * permission would let anyone create rows for, or hand rows to, somebody
     * else. Both scopes pin the owner; membership is checked separately,
     * because where a row goes is a claim to verify rather than one to fix.
     */
    const withOwnership = (request) => {
      const body = { ...(request.body || {}) };
      if (model.ownedBy && (request.scope === 'own' || request.scope === 'member')) {
        body[model.ownedBy] = request.user.id;
      }

      /*
       * Fields that decide how much authority a row carries are for a caller
       * who already has authority over the whole model. Without this, granting
       * users:update:own would be granting self-promotion: a PUT of your own
       * row carrying `roles: [<admin>]` is a permission check that passes and
       * an escalation that succeeds.
       *
       * Dropped rather than refused, for the same reason the owner above is
       * imposed rather than validated — and because a client sending a whole
       * row back should save the parts it was allowed to change, not fail
       * wholesale over the parts it was never offered.
       */
      if (request.scope !== 'any') {
        for (const key of model.privilegedKeys()) delete body[key];
      }

      return body;
    };

    /**
     * A member-scoped create has to land somewhere the caller belongs. Where
     * that is comes from the row it points at — a message joins its group — so
     * the reference in the body is checked against the same membership the
     * read scope would use. A model that decides membership for itself has
     * nothing to check: a row that does not exist yet has no members.
     */
    const assertCreateInScope = async (request, body) => {
      if (request.scope !== 'member') return;

      const via = model.membershipVia;
      if (!via) return;

      const target = fastify.models[via.target];
      if (!(await target.isMemberOf(body[via.name], request.user.id))) {
        const error = new Error(
          `You can only add ${model.label.toLowerCase()} to a ${
            singular(target.model.label).toLowerCase()} you belong to`
        );
        error.statusCode = 403;
        throw error;
      }
    };

    /**
     * A row may only be linked to rows the caller is entitled to hand out.
     *
     * Today that means attachments. Reading a file follows the message it is
     * attached to, so `files: [7]` without this check is a way to publish
     * somebody else's upload to a group — and to read it, since being able to
     * see the message is the whole permission.
     *
     * Applies to any many-to-many whose target has an owner, and only to a
     * scoped caller: an unscoped one is trusted with the model entire, here as
     * everywhere else.
     */
    const assertLinksInScope = async (request, body) => {
      if (request.scope === 'any') return;

      for (const relation of Object.values(model.relations)) {
        if (relation.kind !== 'manyToMany') continue;

        const target = fastify.models[relation.target];
        if (!target?.model.ownedBy) continue;

        const wanted = [...new Set(
          (Array.isArray(body[relation.name]) ? body[relation.name] : [])
            .map((id) => Number.parseInt(id, 10))
            .filter((id) => !Number.isNaN(id))
        )];
        if (wanted.length === 0) continue;

        const rows = await target.findByIds(wanted, 0);
        const mine = rows.filter((row) => target.model.ownedByUser(row, request.user.id));

        if (mine.length !== wanted.length) {
          const error = new Error(
            `You can only attach your own ${target.model.label.toLowerCase()}`
          );
          error.statusCode = 403;
          throw error;
        }
      }
    };

    if (can('read')) {
      fastify.get('/', guard('read'), async (request) => {
        const scope = readScope(request);
        const rows = await repository.findAll({
          search: request.query.search,
          ...(scope === 'own' ? { owner: request.user.id } : {}),
          ...(scope === 'member' ? { member: request.user.id } : {}),
        });
        return { ok: true, count: rows.length, [listKey]: rows };
      });

      fastify.get('/:id', guard('read'), async (request) => {
        const row = await findInScope(request, readScope(request));
        if (!row) throw notFound(label);
        return { ok: true, [itemKey]: row };
      });
    }

    if (can('create')) {
      fastify.post('/', guard('create'), async (request, reply) => {
        const body = withOwnership(request);
        await assertCreateInScope(request, body);
        await assertLinksInScope(request, body);

        const row = await repository.create(body);
        // Every write is announced; the realtime layer decides which events
        // matter and who is allowed to hear about them.
        await fastify.realtime?.publish({ type: 'created', model: model.name, row });
        return reply.status(201).send({ ok: true, [itemKey]: row });
      });
    }

    if (can('update')) {
      fastify.put('/:id', guard('update'), async (request) => {
        // Checked before the write, not after: an own-scoped caller must not
        // be able to change a row they are not allowed to see.
        const previous = await findInScope(request);
        if (!previous) throw notFound(label);

        const body = withOwnership(request);
        await assertLinksInScope(request, body);

        const row = await repository.update(request.params.id, body);
        if (!row) throw notFound(label);

        // The row as it was travels with the event, because an update can take
        // something away as well as give it: whoever was dropped from a group's
        // members is only visible by comparing the two, and they are exactly
        // the people the change most needs to reach.
        await fastify.realtime?.publish({
          type: 'updated', model: model.name, row, previous,
        });
        return { ok: true, [itemKey]: row };
      });
    }

    if (can('delete')) {
      fastify.delete('/:id', guard('delete'), async (request) => {
        // Kept: it is the last copy of the row, and the only thing that can
        // tell the realtime layer who was entitled to see it.
        const row = await findInScope(request);
        if (!row) throw notFound(label);

        const removed = await repository.remove(request.params.id);
        if (!removed) throw notFound(label);

        await fastify.realtime?.publish({ type: 'deleted', model: model.name, row });
        return { ok: true, message: `${label} deleted successfully` };
      });
    }
  };
}
