/**
 * Helpers for rendering the permission catalog published by /api/permissions.
 *
 * Kept out of the panels so both the roles screen and the generic one draw
 * their matrix the same way — and because a module exporting components and
 * plain functions together breaks Fast Refresh.
 */

/**
 * One catalog entry's permissions at one scope, as {action, permission} pairs.
 *
 * Filtered against the list the server published rather than drawn as a full
 * action × scope grid: each model states its own permissions, so it may well
 * not offer every action at every scope.
 */
export function scopedPermissions(entry, scope) {
  return entry.actions
    .map((action) => ({
      action,
      permission: scope === 'own' ? `${entry.model}:${action}:own` : `${entry.model}:${action}`,
    }))
    .filter(({ permission }) => entry.permissions.includes(permission));
}

/**
 * The scope a set of held permissions grants over one `<model>:<action>`, or
 * null for none. Mirrors the server's authorize(): the unscoped permission is
 * the broader of the two and wins when both are held.
 *
 * Panels use it to match the form to the caller — an own-scoped author cannot
 * file a message under somebody else, so they should not be offered the choice
 * only to have the server overrule them.
 */
export function scopeOf(permissions, permission) {
  // Broadest first, exactly as the server tries them.
  if (permissions?.includes(permission)) return 'any';
  if (permissions?.includes(`${permission}:member`)) return 'member';
  if (permissions?.includes(`${permission}:own`)) return 'own';
  return null;
}

/**
 * Whether a set of permissions reaches past the holder's own corner of the app.
 *
 * That is the line the dashboard sits on: it exists to manage rows somebody else
 * owns, so the accounts that belong there are the ones holding a permission with
 * no scope on it — `users:update` rather than `users:update:own`.
 *
 * `users:read` is the one unscoped permission that is not administrative. Every
 * account holds it so the messenger can name the people in a conversation, and
 * knowing who exists is not the same as administering them.
 */
export function hasAdministrativePermission(permissions) {
  return (permissions || []).some((permission) => {
    const parts = permission.split(':');
    // Three parts means `:own` or `:member` — by definition their own corner.
    if (parts.length !== 2) return false;
    const [model, action] = parts;
    return !(model === 'users' && action === 'read');
  });
}

/**
 * Caption for a scope line, or null when the entry has only one scope.
 *
 * `t` is passed in rather than taken from a hook: this module exports plain
 * functions on purpose (a module mixing them with components breaks Fast
 * Refresh), and the callers are inside a render loop that already has it.
 *
 * A scope this build has never heard of falls back to its own name, which is
 * the same rule the rest of the catalog follows — better a word in English than
 * a blank where a caption belongs.
 */
export function scopeCaption(t, entry, scope) {
  if (entry.scopes.length < 2) return null;
  if (scope === 'own' && entry.ownedBy) {
    return t('panels.scope.ownField', { field: entry.ownedBy });
  }
  return t(`panels.scope.${scope}`, { defaultValue: scope });
}
