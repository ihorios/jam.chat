# React

React 19, built by Vite 8, served as static files by the same Fastify process
that serves the API. No SSR, no framework — `src/main.jsx` mounts a
`<BrowserRouter>` and that is the whole of the bootstrap.

---

## 1. Layout

```
src/
├── main.jsx          mount; imports ./i18n for its side effect
├── App.jsx           providers, routes, chrome
├── pages/            login, messenger, dashboard, profile
├── panels/           one per model; GenericModelPanel covers the rest
├── components/       navbar, avatar, dialogs, emoji, icons…
├── context/          auth, realtime, calls — each split in two (see §3)
├── lib/              api, socket, webrtc, permissions, pagination, format…
└── i18n/             index.js, en.json, uk.json
```

`vite.config.js` sets `root: 'src'`, so `src/index.html` is the entry and
`index.html` stays out of the project root. `publicDir` points back out at
`../public`, and `envDir` at `..` so a single `.env` configures both halves.

---

## 2. Routing

```jsx
<AuthProvider>
  <RealtimeProvider>
    <CallProvider>
      <Navbar />
      <IncomingCallDialog />
      <CallPanel />
      <main className="main-content"><Routes>…</Routes></main>
      <footer />
```

The nesting order is deliberate and commented in place:

- `RealtimeProvider` **inside** `AuthProvider` — the socket is reopened when the
  identity changes, and the header needs the unread count on every page.
- `CallProvider` inside the socket provider and **outside the routes** — a call
  has to ring wherever the person is, and survive them navigating.

| Path | Element |
| :--- | :--- |
| `/login` | `LoginPage` |
| `/` | `RequireAuth` → `Home` |
| `/chats` | `RequireAuth` → `MessengerPage` |
| `/dashboard`, `/dashboard/:model` | `RequireAuth administrative` → `DashboardPage` |
| `/profile` | `RequireAuth` → `ProfilePage` |
| `/admin/users`, `/admin/roles` | redirects, from before the dashboard existed |
| `*` | redirect to `/` |

`/` is not a page. It is a component, because the answer is not known until the
session is:

```jsx
function Home() {
  const { homePath } = useAuth();
  return <Navigate to={homePath} replace />;
}
```

`homePath` is `/dashboard` for anyone with something to administer and `/chats`
otherwise. The dashboard routes then check **again**, so an ordinary account
typing the address is turned away rather than shown a page with nothing on it.
Hiding the header link is only half of an access rule — and the server guards
every route behind it independently.

---

## 3. Contexts, split in two

Each context is two files:

```
context/auth.js          createContext + useAuth hook
context/AuthContext.jsx  the provider component
```

This is not decoration. A module that exports both components and plain
functions breaks Fast Refresh, so the hook and the context object live in the
`.js` and only the component lives in the `.jsx`. `src/lib/permissions.js` says
the same thing about itself.

### `AuthContext`

Holds `user` and `loading`. The two are distinct on purpose: `loading`
distinguishes *"not signed in"* from *"we do not know yet"*, so the app does not
flash the login page while `GET /api/auth/me` is in flight.

| Exposed | Does |
| :--- | :--- |
| `login` / `register` / `loginWithGoogle` / `logout` | session lifecycle |
| `updateProfile` | `PUT /api/users/:id` — the ordinary model route, using `users:update:own` |
| `setLanguage` | changes i18next, then persists to the account |
| `adoptUser` | takes a user the server just handed back (a picture upload) |
| `can(permission)` | `scopeOf(...) !== null` |
| `scope(permission)` | `'any' \| 'member' \| 'own' \| null` |
| `canAdminister`, `homePath` | see [permissions §8](permissions.md#8-the-client-mirror) |

`logout` clears the local identity in a `finally`, even if the request failed —
the alternative is a UI that still claims to be signed in.

`setLanguage` swallows a failed save: the page is already in the new language and
`localStorage` has it. A failure means it will not follow them to another device,
which is not a reason to snap the interface back to a language they just left.

### `RealtimeContext`

One socket for the whole application. Covered in
[WebSockets §7](websocket.md#7-the-client).

### `CallContext`

One call at a time, for the whole tab. Covered in [Calls](calls.md).

---

## 4. `lib/api.js`

A thin `fetch` wrapper. The session is an HTTP-only cookie, so there is no token
to attach — the browser sends it and JavaScript cannot read it.

Every failure arrives as a **thrown `Error` carrying the server's message**, so
callers need one `catch`:

```js
if (!res.ok || data.ok === false) {
  throw Object.assign(new Error(data.error || i18n.t('errors.request', { status: res.status })),
                      { status: res.status });
}
```

Note `data.ok === false` — the API's envelope is honoured even on HTTP 200. A
network failure becomes `status: 0` with a translated message.

`uploadFiles` and `uploadPicture` are separate functions rather than options,
because a multipart body is not JSON: the browser has to set its own
`Content-Type` with the boundary, so those two deliberately send **no header at
all**.

---

## 5. The dashboard builds itself

`DashboardPage` fetches `/api/meta` and renders a tab per model. The panel is
chosen by lookup with a fallback:

```js
const PANELS = { users: UsersPanel, roles: RolesPanel,
                 user_groups: UserGroupsPanel, user_messages: UserMessagesPanel };
```

Anything without an entry gets `GenericModelPanel`, which builds a table, a form
and a permission matrix **entirely from the model's `/api/meta` description**.
A model added on the server is manageable here immediately — it just gets a
plainer screen until somebody writes it one. `TAB_ICONS` falls back the same way.

`/api/meta` deliberately omits models with no actions: describing one would
promise a screen that cannot work. No registered model is in that position
today, but the filter is what lets one be added without appearing here.

For each field the meta carries `type`, `required`, `unique`, `hidden` and
`immutable`, which is enough to build an input, validate it, and know not to
offer it for editing. Relations carry `kind` and `target`.

---

## 6. Icons and logos

`components/Icon.jsx` renders a **font ligature**, not an SVG:
`<span className="icon">edit</span>` draws a pencil. The font is Material
Symbols Rounded, subsetted to only the icons this app names — 33 KB, served
same-origin.

Two consequences, both handled in `src/index.css`:

- Until the font arrives, a ligature is still ordinary text, so a page loading it
  over the network would show the words `space_dashboard` and `rocket_launch`
  where its icons belong. Serving it from the same origin is what makes it
  present for the first paint.
- `font-display: block` is the second half: if the file is somehow slow, the
  browser draws nothing rather than the name.

An icon missing from the subset renders as its own name, silently. That is what
`test/ui/icons.test.js` guards — see
[Translation](translation.md#7-the-icon-subset).

---

## 7. Styling

Plain CSS in `src/index.css` (~2,570 lines), one stylesheet imported by
`main.jsx`. No CSS modules, no runtime CSS-in-JS. Colours, radii and fonts are
custom properties on `:root`.

`src/App.css` exists but **is imported by nothing** — its selectors
(`#next-steps`, `#docs`, `#center`) are Vite starter-template leftovers and
appear in no component. It is dead code.

### The unread badge

`.chat-badge`, `.chat-item-bottom` and `.chat-item.unread` were rendered by the
JSX long before anything styled them, so there was no circle — only unstyled
text. They are styled now; the reasoning behind the colour, the shape and the
double signal is in [Messages §10](messages.md#10-in-the-interface).

### One breakpoint

```css
@custom-media --mobile (max-width: 768px);

@media (--mobile) { … }
```

`@custom-media` is Media Queries Level 5 and no browser implements it; Lightning
CSS inlines it at build time. This is why `vite.config.js` declares
`css.transformer: 'lightningcss'` with `drafts.customMedia` **and** a `targets`
value — without targets, Lightning CSS passes the at-rule through unresolved and
every mobile block silently stops applying.

It cannot be a custom property: media queries are resolved before custom
properties, so `(max-width: var(--x))` never matches.

---

## 8. Conventions worth knowing

**Every user-visible string is a translation key.** A string written into JSX
cannot be translated and nothing complains — so a test fails the build. See
[Translation](translation.md).

**The chats page narrows its own reads.** `MessengerPage` requests
`?scope=member`, so `/chats` is somebody's own conversations whatever
permissions they hold. The dashboard asks for nothing and still sees everything.

**And loads them lazily.** The sidebar needs no messages — the `unread` frame
carries a count and a preview line for every group — so the first visit costs
one list of groups, and a conversation is fetched when it is opened
(`?group=<id>`). Only the open conversation is held in state; a `message` frame
for any other group is ignored, because the `unread` frame that accompanies it
is what moves that group's badge.

**Optimistic updates, then reconcile.** The messenger refetches after sending
rather than waiting for its own message to come back over the socket: *a sender
should never be left waiting on the network to see their own words.* Unread
counts clear locally before the round trip.

**Confirmations are data, not `window.confirm`.** `setConfirming({ title,
message, confirmLabel, destructive, run })` — the question waiting to be
answered, or `null`.

**Lazy where it is worth it.** The emoji picker is `lazy()`-loaded: the library
carries every emoji Unicode defines along with names and search terms, which is
a great deal of data to hand to somebody who came to read a message. It is
307 KB of the build, in its own chunk.

Related: [WebSockets](websocket.md) · [Translation](translation.md) ·
[Users, roles and permissions](permissions.md)
