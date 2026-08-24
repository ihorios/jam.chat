import React from 'react';
import { useTranslation } from 'react-i18next';

import Icon from './Icon';

/**
 * The footer of a dashboard list: how many rows are shown, how many there are,
 * and the way to the rest of them.
 *
 * Takes the object usePagination returns, so a panel wires it in one line and
 * every list in the dashboard behaves identically. Hidden entirely when there
 * is nothing to page through — a control offering page 1 of 1 is furniture.
 */
export default function Pagination({ state }) {
  const { t } = useTranslation();
  const { page, pages, perPage, total, from, to, setPage, choosePerPage } = state;

  // Nothing to say about an empty list; the table itself says it is empty.
  if (total === 0) return null;

  return (
    <div className="pagination">
      <span className="pagination-count">
        {t('panels.pagination.showing', { from, to, total })}
      </span>

      <label className="pagination-size">
        {t('panels.pagination.perPage')}
        <select
          value={perPage}
          onChange={(e) => choosePerPage(Number(e.target.value))}
          className="role-select"
        >
          {/* The sizes come from the hook, so a panel cannot offer a different
              set from the one it pages by. */}
          {state.sizes.map((size) => (
            <option key={size} value={size}>{size}</option>
          ))}
        </select>
      </label>

      {pages > 1 && (
        <div className="pagination-pages">
          <button
            type="button"
            className="btn-action"
            onClick={() => setPage(page - 1)}
            disabled={page === 1}
            aria-label={t('panels.pagination.previous')}
            title={t('panels.pagination.previous')}
          >
            <Icon name="chevron_left" />
          </button>

          <span className="pagination-position">
            {t('panels.pagination.page', { page, pages })}
          </span>

          <button
            type="button"
            className="btn-action"
            onClick={() => setPage(page + 1)}
            disabled={page === pages}
            aria-label={t('panels.pagination.next')}
            title={t('panels.pagination.next')}
          >
            <Icon name="chevron_right" />
          </button>
        </div>
      )}
    </div>
  );
}
