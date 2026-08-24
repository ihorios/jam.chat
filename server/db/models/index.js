import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { buildCatalog } from './catalog.js';
import { Model } from './model.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Every .js file in this directory that default-exports a Model instance is
 * registered automatically. Adding a model means adding one file here —
 * nothing else in the server needs editing. Removing the file removes its
 * tables, permissions and routes.
 *
 * Files that export something else (the kernel, this registry) are skipped.
 */
const loaded = [];
for (const file of fs.readdirSync(__dirname).sort()) {
  if (!file.endsWith('.js') || file === path.basename(__filename)) continue;
  const module = await import(pathToFileURL(path.join(__dirname, file)).href);
  if (module.default instanceof Model) loaded.push(module.default);
}

/**
 * Orders models so that everything a model `requires` comes before it. Schema
 * creation and seeding both walk the result in order, which is what lets a
 * foreign key assume its target table already exists.
 */
function sortByDependency(models) {
  const byName = new Map(models.map((model) => [model.name, model]));
  const state = new Map();
  const ordered = [];

  function visit(model, trail) {
    const status = state.get(model.name);
    if (status === 'done') return;
    if (status === 'visiting') {
      throw new Error(`Circular model dependency: ${[...trail, model.name].join(' -> ')}`);
    }

    state.set(model.name, 'visiting');
    for (const name of model.requires) {
      const required = byName.get(name);
      if (!required) {
        throw new Error(`Model "${model.name}" requires unknown model "${name}".`);
      }
      visit(required, [...trail, model.name]);
    }
    state.set(model.name, 'done');
    ordered.push(model);
  }

  // Alphabetical input, so the order is stable for models that do not
  // constrain each other.
  for (const model of models) visit(model, []);
  return ordered;
}

const ordered = sortByDependency(loaded);

export const modelList = Object.freeze(ordered);
export const models = Object.freeze(
  Object.fromEntries(ordered.map((model) => [model.name, model]))
);

// Foreign keys can only be resolved once every model is known.
for (const model of ordered) model.link(models);

// Permissions exist only because models do, so the catalog is built from the
// registry rather than maintained by hand.
buildCatalog(ordered);

export function getModel(name) {
  const model = models[name];
  if (!model) throw new Error(`Unknown model "${name}".`);
  return model;
}

export { Model } from './model.js';
export { ValidationError, PASSWORD_RULES, singular } from './fields.js';
export {
  CRUD_ACTIONS,
  allPermissions,
  permissionsByModel,
  isValidPermission,
  permissionKey,
  parsePermission,
} from './catalog.js';
