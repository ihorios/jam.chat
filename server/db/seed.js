import { modelList } from './models/index.js';

/**
 * Gives every model the chance to write its default rows, in the same
 * dependency order the schema is created in — so a model may assume everything
 * it requires has already seeded.
 *
 * Each model's seed() is idempotent and runs on every boot, not just the first
 * one: it is what keeps derived defaults (the admin role's permissions, say)
 * in step with the registry as models come and go.
 */
export async function seed(repositories, log) {
  for (const model of modelList) {
    if (!repositories[model.name]) continue;
    await model.seed(repositories, log);
  }
}
