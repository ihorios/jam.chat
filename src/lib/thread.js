/**
 * What the messenger shows while one conversation is being swapped for another.
 *
 * The page holds a single loaded conversation — lazy loading, so opening a group
 * is a round trip — and for one render after a group is selected, the thread it
 * holds is still the previous group's. React re-renders the moment `selectedId`
 * changes; the fetch is scheduled behind that render, and so is anything an
 * effect would clear.
 *
 * That window is short and it was visible: the new group was drawn with the old
 * group's messages under its header and the old group's last line beside its
 * name in the sidebar, until the fetch landed and overwrote both.
 *
 * The fix is not to make the window smaller but to stop guessing what is in it.
 * A loaded thread is `{ group, items }` — it knows which conversation it is —
 * and every question below is answered from that rather than from an assumption
 * that it matches whatever is selected.
 *
 * Plain functions, and in lib/ rather than in the component, because that is
 * what makes the render sequence testable without rendering anything.
 */

/** Is the thread we are holding the one being looked at? */
export function isShowing(thread, selectedId) {
  return selectedId !== null && selectedId !== undefined && thread.group === selectedId;
}

/**
 * The messages to draw, which is none of them while another conversation is
 * still loading. Never the previous group's: those belong to a conversation
 * nobody is looking at any more.
 */
export function conversationOf(thread, selectedId) {
  return isShowing(thread, selectedId) ? thread.items : [];
}

/**
 * The line under a group's name in the sidebar.
 *
 * The open conversation supplies its own, which keeps it current the instant
 * somebody sends something. Every other group — and the open one while it is
 * still arriving — takes it from the unread frame, which the server sends
 * whenever anything is said anywhere.
 *
 * Keyed on the group the messages actually belong to, never on which group is
 * selected. That distinction is the whole of it: selecting B while holding A's
 * messages used to hand A's last line to B.
 */
export function previewOf(thread, latest, groupId) {
  if (thread.group === groupId && thread.items.length > 0) {
    return thread.items[thread.items.length - 1];
  }
  return latest?.[groupId] || null;
}

/**
 * Whether the thread is still on its way.
 *
 * Derived rather than flagged. A `setLoading(true)` in an effect is a render too
 * late — the same window — so the empty state would flash "say something" at a
 * conversation that is merely still arriving.
 */
export function isThreadLoading(thread, selectedId, failed = false) {
  return selectedId !== null && selectedId !== undefined && !isShowing(thread, selectedId) && !failed;
}
