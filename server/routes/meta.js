import { modelList, allPermissions, permissionsByModel } from '../db/models/index.js';

/**
 * Describes the registry to the client. The admin UI builds its permission
 * matrix from this, so a newly added model shows up without frontend changes.
 */
export default async function metaRoutes(fastify) {
  // Describes the shape of the system rather than its data, so any signed-in
  // user may read it — the dashboard needs it to know which tabs exist.
  fastify.addHook('preHandler', fastify.authenticate);

  fastify.get('/permissions', async () => ({
    ok: true,
    models: permissionsByModel(),
    permissions: allPermissions(),
  }));

  fastify.get('/meta', async () => ({
    ok: true,
    // Only what a client can actually reach. A model declaring no actions has
    // no routes and no permissions — it exists for the server's own
    // bookkeeping, and describing it here would promise a screen that cannot
    // work.
    models: modelList.filter((model) => model.actions.length > 0).map((model) => ({
      name: model.name,
      label: model.label,
      actions: model.actions,
      searchable: model.searchable,
      // The field naming the owner, when rows can belong to a user — which is
      // also what makes this model's `:own` permissions exist.
      ownedBy: model.ownedBy,
      fields: Object.values(model.fields).map((field) => ({
        name: field.name,
        label: field.label,
        type: field.type,
        required: field.required,
        unique: field.unique,
        hidden: field.hidden,
        // Set once, on create. A client should not offer it for editing.
        immutable: field.immutable,
      })),
      relations: Object.values(model.relations).map((relation) => ({
        name: relation.name,
        kind: relation.kind,
        target: relation.target || null,
      })),
    })),
  }));
}
