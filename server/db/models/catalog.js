/**
 * The permission vocabulary. Permissions are never written by hand — they are
 * derived as `<model>:<action>` for every model in the registry, so adding or
 * removing a model automatically adds or removes its permissions.
 *
 * A permission also carries a scope, spelled as a suffix on all but the
 * broadest:
 *
 *   user_groups:read          every row
 *   user_groups:read:member   the rows the caller belongs to
 *   user_groups:read:own      the rows the caller owns
 *
 * A scope only exists where the model can answer it: `own` for models that
 * declare an owner, `member` for models that declare what membership of them
 * means. Nothing else can be owned or joined, so there is nothing to grant.
 *
 * This module holds no imports on purpose: both the model kernel (model.js)
 * and the registry (index.js) depend on it, and a dependency in the other
 * direction would create a cycle.
 */

export const CRUD_ACTIONS = Object.freeze(['create', 'read', 'update', 'delete']);

/**
 * Broadest first, which is the order a permission check tries them in: every
 * row, then the ones you are part of, then the ones that are yours alone.
 */
export const SCOPES = Object.freeze(['any', 'member', 'own']);

let catalog = new Set();
let grouped = [];

export function permissionKey(model, action, scope = 'any') {
  return scope === 'any' ? `${model}:${action}` : `${model}:${action}:${scope}`;
}

export function parsePermission(permission) {
  const [model, action, scope] = String(permission).split(':');
  return { model, action, scope: scope || 'any' };
}

/**
 * Called once by the registry after every model definition has loaded.
 *
 * Each model states its own permissions; nothing here derives them. The
 * actions and scopes on a grouped entry are read back out of that list rather
 * than assumed from the model's CRUD surface, so a model that overrides
 * permissions() gets a permission matrix describing what it really grants.
 */
export function buildCatalog(models) {
  // A model that grants nothing is internal bookkeeping — a row of no
  // checkboxes helps nobody choose what a role may do.
  grouped = models.filter((model) => model.permissions().length > 0).map((model) => {
    const permissions = model.permissions();
    const parsed = permissions.map(parsePermission);

    return {
      model: model.name,
      label: model.label,
      actions: [...new Set(parsed.map((permission) => permission.action))],
      scopes: SCOPES.filter((scope) => parsed.some((permission) => permission.scope === scope)),
      /** What the model can be owned through, or null when nothing owns it. */
      ownedBy: model.ownedBy,
      permissions,
    };
  });
  catalog = new Set(grouped.flatMap((entry) => entry.permissions));
  return grouped;
}

export function allPermissions() {
  return [...catalog];
}

/** Catalog grouped by model — what the admin UI renders as a permission matrix. */
export function permissionsByModel() {
  return grouped;
}

export function isValidPermission(permission) {
  return catalog.has(permission);
}
