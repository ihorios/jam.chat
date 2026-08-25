import t from 'tap';

import {
  conversationOf,
  isShowing,
  isThreadLoading,
  previewOf,
} from '../../src/lib/thread.js';

/**
 * Swapping one conversation for another, one render at a time.
 *
 * The messenger holds a single loaded conversation, and for one render after a
 * group is selected the thread it holds is still the previous group's: React
 * re-renders when `selectedId` changes, and the fetch — and anything an effect
 * would clear — is scheduled behind that render.
 *
 * That window was visible. The new group was drawn with the old group's
 * messages under its header and the old group's last line beside its name,
 * until the fetch landed and overwrote both. These walk the exact sequence, so
 * the middle step is the one that matters.
 */

const A = 1;
const B = 2;

const inA = { group: A, items: [{ id: 10, group: A, value: 'said in A' }] };
const inB = { group: B, items: [{ id: 20, group: B, value: 'said in B' }] };
const nothingLoaded = { group: null, items: [] };

/** What the unread frame carries for every group, loaded or not. */
const latest = {
  [A]: { id: 10, value: 'said in A' },
  [B]: { id: 20, value: 'said in B' },
};

t.test('selecting a group never shows the previous one', async (t) => {
  // 1. A is open and loaded.
  t.same(conversationOf(inA, A).map((m) => m.value), ['said in A'], 'A is on screen');

  // 2. B is selected. The fetch has not run: the thread is still A's.
  t.same(
    conversationOf(inA, B), [],
    'B shows nothing rather than A\u2019s messages under B\u2019s header'
  );
  t.equal(
    previewOf(inA, latest, B).value, 'said in B',
    'and B\u2019s row says what was said in B, not what was said in A'
  );
  t.ok(isThreadLoading(inA, B), 'the thread reads as loading, not as empty');

  // 3. B lands.
  t.same(conversationOf(inB, B).map((m) => m.value), ['said in B'], 'B is on screen');
  t.notOk(isThreadLoading(inB, B), 'and no longer loading');
});

t.test('the preview is keyed on the loaded group, not the selected one', async (t) => {
  // The open conversation supplies its own last line, which is what keeps it
  // current the moment somebody sends something.
  t.equal(previewOf(inA, latest, A).value, 'said in A', 'from the thread when it is that group\u2019s');

  // Every other group falls back to the unread frame.
  t.equal(previewOf(inA, latest, B).value, 'said in B', 'from the unread frame otherwise');

  // A conversation loaded and genuinely empty must not report the frame's
  // stale line as though it were still there.
  const emptied = { group: A, items: [] };
  t.equal(
    previewOf(emptied, {}, A), null,
    'a group with nothing in it has no last line'
  );

  t.equal(previewOf(nothingLoaded, {}, A), null, 'and neither has one nobody has opened');
});

t.test('nothing is showing when nothing is selected', async (t) => {
  t.notOk(isShowing(inA, null), 'no selection is not a match, whatever is loaded');
  t.same(conversationOf(inA, null), [], 'so there is nothing to draw');
  t.notOk(isThreadLoading(inA, null), 'and nothing to wait for');
});

t.test('a failed load stops waiting', async (t) => {
  t.ok(isThreadLoading(inA, B, false), 'still arriving');
  t.notOk(
    isThreadLoading(inA, B, true),
    'until it fails, when the error is what the reader should be shown instead'
  );
});
