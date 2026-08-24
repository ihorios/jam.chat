import fs from 'node:fs';
import path from 'node:path';

import t from 'tap';

import { PAGE_SIZES } from '../../src/lib/pagination.js';

/**
 * Every list in the dashboard is paged, and paged the same way.
 *
 * There are five panels and there will be more — the generic one exists so that
 * registering a model gives it a screen for free. A panel that renders a table
 * and forgets the footer is not broken in any way a person would notice until
 * the table is long, which is exactly when it matters and much later than now.
 *
 * Checked in the source rather than in a browser for the same reason
 * icons.test.js is: the mistake is structural, and finding it does not need the
 * thing to be running.
 */

const ROOT = path.join(import.meta.dirname, '..', '..');
const PANELS = path.join(ROOT, 'src', 'panels');

const panels = fs.readdirSync(PANELS)
  .filter((name) => name.endsWith('.jsx'))
  .map((name) => ({ name, source: fs.readFileSync(path.join(PANELS, name), 'utf8') }));

t.test('the sizes on offer are 10, 20 and 50, in that order', async (t) => {
  t.same([...PAGE_SIZES], [10, 20, 50]);
  t.equal(PAGE_SIZES[0], 10, 'and ten is the default, being first');
  t.throws(() => { PAGE_SIZES.push(100); }, 'the list is frozen');
});

t.test('every panel with a table pages it', async (t) => {
  t.ok(panels.length >= 5, `${panels.length} panels found`);

  for (const { name, source } of panels) {
    // The one thing that makes a panel a list: a table of rows.
    if (!source.includes('<table className="users-table">')) {
      t.pass(`${name} renders no list`);
      continue;
    }

    t.match(source, /usePagination\(/, `${name} pages its rows`);
    t.match(source, /<Pagination state=\{page\} \/>/, `${name} renders the control`);
    t.match(source, /page\.visible\.map\(/, `${name} renders the page, not the whole list`);
  }
});

t.test('the empty row counts the filtered list, not the page', async (t) => {
  /*
   * `page.visible.length === 0` would be true of page two of a list that has
   * just been filtered down to one page — and would replace the rows with "no
   * matches" while the list plainly has some. The count has to come from the
   * filtered rows, which is also what the pager itself is built from.
   */
  for (const { name, source } of panels) {
    if (!source.includes('<table className="users-table">')) continue;

    t.notMatch(
      source,
      /page\.visible\.length === 0/,
      `${name} does not decide emptiness from one page`
    );
    t.match(
      source,
      /(filtered|visible)\w*\.length === 0/,
      `${name} decides it from the filtered rows`
    );
  }
});

t.test('every panel offers something to narrow the list by', async (t) => {
  // A pager without filters is a way to walk a long list, not a way to find
  // anything in it. Each panel carries at least a search box.
  for (const { name, source } of panels) {
    if (!source.includes('<table className="users-table">')) continue;

    t.match(source, /className="filters-bar"/, `${name} has a filter bar`);
    t.match(source, /className="search-input"/, `${name} can be searched`);
  }
});
