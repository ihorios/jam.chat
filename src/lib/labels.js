/**
 * Reading a model's own words in the reader's language.
 *
 * /api/models publishes a label for every model and every field, and those come
 * from the model definitions on the server — which are written in English,
 * because that is where the code is written. The dashboard is built out of them:
 * tab names, panel headings, table columns, "Add User", "No user groups yet".
 *
 * So each one is looked up as a key first and falls back to what the server
 * said. That fallback is the whole point: a model registered tomorrow keeps
 * working, in English, until somebody adds the two lines of translation for
 * it — rather than showing `models.widgets.label` to a person who never asked
 * to see a key.
 *
 * The `t` from useTranslation has to be passed in. These are plain functions
 * rather than a hook so they can be called from inside a render loop, and from
 * a callback that already has `t` in scope.
 */

/** A model in the plural, as a heading: "User Groups". */
export function modelLabel(t, model) {
  return t(`models.${model.name}.label`, { defaultValue: model.label });
}

/**
 * One of them, in the singular: "User Group".
 *
 * The English fallback is derived by the caller and passed in, because
 * singularising is the server's rule (db/models/fields.js) and the panels
 * already apply it.
 */
export function itemLabel(t, model, fallback) {
  return t(`models.${model.name}.item`, { defaultValue: fallback });
}

/** A field, as a form label or a column heading: "Email Address". */
export function fieldLabel(t, model, field) {
  return t(`models.${model.name}.fields.${field.name}`, { defaultValue: field.label });
}

/**
 * A relation, same idea. Relations publish no label of their own, so the
 * fallback is the relation's name — which is what the panels showed before.
 */
export function relationLabel(t, model, relation) {
  return t(`models.${model.name}.fields.${relation.name}`, {
    defaultValue: relation.label || relation.name,
  });
}
