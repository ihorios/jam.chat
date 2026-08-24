import { useEffect, useMemo, useState } from 'react';

/**
 * How many rows a dashboard list shows at once.
 *
 * Ten by default, because a table is read rather than scrolled: the point of
 * the filters above it is that the row somebody wants should be on the first
 * page. The larger sizes are for the times that fails and scanning is quicker
 * than narrowing.
 */
export const PAGE_SIZES = Object.freeze([10, 20, 50]);

/**
 * One page of `rows`, and the state to move around them.
 *
 * Paged in the browser rather than by the server, which is a deliberate limit
 * worth naming: the panel has already fetched every row it is filtering, so
 * this makes a long list readable but not cheap. It matches how the rest of the
 * application works — the messenger holds every message it may read — and the
 * day that stops being true, the fix is `?limit=&offset=` on the CRUD routes
 * and this hook keeping its shape.
 *
 * `rows` is expected to be the *filtered* list, so that narrowing a search
 * renumbers the pages rather than paging through matches it has excluded.
 */
export function usePagination(rows) {
  const [perPage, setPerPage] = useState(PAGE_SIZES[0]);
  const [page, setPage] = useState(1);

  const total = rows.length;
  const pages = Math.max(1, Math.ceil(total / perPage));

  /*
   * A filter that shortens the list can leave the reader on a page past the end
   * of it — type one more letter into a search on page 4 and there is no page 4
   * any more. Clamped on the way out so the render is always of a real page,
   * and corrected in state afterwards so the controls agree with it.
   */
  const current = Math.min(page, pages);
  useEffect(() => {
    if (page !== current) setPage(current);
  }, [page, current]);

  const visible = useMemo(
    () => rows.slice((current - 1) * perPage, current * perPage),
    [rows, current, perPage]
  );

  return {
    /** The rows to render. */
    visible,
    /** The choices a panel may offer, so it cannot offer one it cannot honour. */
    sizes: PAGE_SIZES,
    page: current,
    pages,
    perPage,
    total,
    /** Index of the first and last visible row, 1-based, for "11–20 of 34". */
    from: total === 0 ? 0 : (current - 1) * perPage + 1,
    to: Math.min(current * perPage, total),
    setPage,
    /** Changing the size starts again from the top rather than guessing. */
    choosePerPage(size) {
      setPerPage(size);
      setPage(1);
    },
  };
}
