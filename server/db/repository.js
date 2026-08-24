import { modelList } from './models/index.js';
import { isPostgres } from './index.js';
import { createPgRepository } from './pg-repository.js';
import { createMemoryRepository } from './memory-repository.js';

/**
 * Builds one repository per registered model, on whichever driver is live.
 * Repositories are created lazily-linked via `getRepo` so relations can point
 * at models that have not been constructed yet.
 */
export function createRepositories() {
  const repositories = {};
  const getRepo = (name) => {
    const repository = repositories[name];
    if (!repository) throw new Error(`No repository registered for model "${name}".`);
    return repository;
  };

  const create = isPostgres() ? createPgRepository : createMemoryRepository;
  for (const model of modelList) {
    repositories[model.name] = create(model, getRepo);
  }

  return repositories;
}
