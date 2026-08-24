# 📱 Android app — a wrapper, and a bridge

A plan for shipping JAM.chat to Android as a Flutter host that does one thing:
show the existing web app in a WebView, and lend it the handful of things a
browser cannot do.

No native screens. No second copy of any feature. The app is a window with a
service hatch.

Nothing here is built yet.

---

## 1. The boundary rule

Everything below follows from one decision, so it is worth stating on its own
before anything else:

> **The native side never talks to the server.**
>
> It produces capabilities — a permission, a file, a token, an event — and hands
> them to the page. The page makes every request, because the page is what holds
> the session cookie.

This is what makes "wrapper only" a real architecture rather than a slogan. The
consequences are all good ones:

- **No second authentication path.** The session is an HTTP-only signed cookie
  (`server/plugins/auth.js`). If native code called the API it would need that
  cookie, which means reading it out of the WebView, keeping it in sync, and
  having two places that can be signed in. Instead: zero.
- **No duplicated authorisation.** Who may read an attachment is decided by group
  membership in `server/routes/files.js`. A native downloader would have to be
  told about that. The page already knows.
- **The server API does not grow a mobile dialect.** With one exception it does
  not change at all (§7).
- **One place to debug.** A failing feature is either "the bridge did not hand it
  over" or "the page did the wrong thing with it", and the two are one line apart.

The rest of this document is the bridge, and the work needed either side of it.

---

## 2. The version problem, which is the real design constraint

A wrapper splits the app across two release trains that move at different
speeds:

| | ships when | to whom |
| :--- | :--- | :--- |
| Web client | every deploy, minutes | everyone, at once |
| Wrapper | Play review, days | whoever has updated |

So at any moment a freshly deployed page is running inside a wrapper built
months ago. **The bridge is therefore an API with backwards compatibility, not
an internal detail** — and it is the web side that has to be defensive, because
it is the side that changes.

Three rules fall out of this, and they are not negotiable:

1. **The page must work with no bridge at all.** Every call is guarded. A desktop
   browser is the same case as an old wrapper.
2. **Feature-detect per method, never per version.** `has('saveFile')`, not
   `version >= 3`. A version number tells you what shipped together, not what a
   given user has.
3. **Additive only.** A method's arguments and result may gain optional fields
   and may never lose or repurpose one. Renaming a method means adding one.

---

## 3. The bridge

### Transport

`flutter_inappwebview` provides both directions natively, so there is no
hand-written platform channel:

- **page → native**: `window.flutter_inappwebview.callHandler(name, ...args)`
  returns a `Promise`, answered by `controller.addJavaScriptHandler`.
- **native → page**: `controller.evaluateJavascript` calling a single dispatch
  function the page installs.

The page never touches that plugin API directly. It goes through one shim
(§6) so the plugin is replaceable and the guards live in exactly one file.

### Page → native

Every method resolves, including on refusal — a rejection is reserved for "the
bridge broke", not "the user said no".

| Method | Argument | Resolves with | Replaces |
| :--- | :--- | :--- | :--- |
| `hello` | — | `{ platform, appVersion, methods: [...] }` | feature detection |
| `requestMicrophone` | — | `{ granted: boolean, permanentlyDenied: boolean }` | nothing; browsers do this themselves |
| `pickFiles` | `{ maxCount, extensions }` | `[{ name, mime, size, bytes }]` | the file input that does nothing |
| `saveFile` | `{ url, filename }` | `{ saved: boolean }` | `<a download>` |
| `googleIdToken` | — | `{ token } \| { cancelled: true }` | the blocked OAuth popup |
| `pushToken` | — | `{ token } \| { unavailable: true }` | nothing; no web push in WebView |
| `setBadge` | `{ count }` | — | nothing |
| `keepAwake` | `{ on: boolean }` | — | nothing |

`permanentlyDenied` matters: Android stops showing the dialog after two refusals,
so the page has to offer "open settings" rather than asking again forever.

### Native → page

One dispatch function, one event object, so adding an event never changes a
signature:

```js
window.JamChatNative.emit({ type: 'lifecycle', state: 'resumed' })
```

| Event | Payload | Why the page cares |
| :--- | :--- | :--- |
| `lifecycle` | `{ state: 'resumed' \| 'paused' }` | reconnect the socket on resume; stop timers on pause |
| `back` | — | close a modal instead of the app (§4) |
| `openPath` | `{ path }` | a tapped notification lands on `/chats` with a group selected |
| `pushToken` | `{ token }` | FCM rotates tokens without being asked |
| `connectivity` | `{ online: boolean }` | show the reconnecting state before the socket times out |

### Security

The bridge is a privilege escalation surface: it grants file system and identity
access to whatever is loaded in the WebView. Three defences, all cheap:

1. **Origin check inside every handler.** Compare `controller.getUrl()`'s origin
   to the configured one and refuse otherwise. Not only at injection time — a
   navigation can happen between injection and call.
2. **Off-origin navigation never happens.** `shouldOverrideUrlLoading` sends
   anything not on the origin to the system browser.
3. **Validate arguments.** `maxCount` is clamped to the server's
   `FILE_MAX_PER_MESSAGE`; `saveFile.url` must be same-origin; `extensions` is
   intersected with the server's allow-list. The page is trusted, but a bug in
   the page should not be able to read arbitrary files.

---

## 4. Phase 1 — the wrapper

The whole app, and it is small.

```
android_app/
├── lib/
│   ├── main.dart          # one route, one WebView
│   ├── config.dart        # origin per flavour
│   ├── bridge.dart        # every handler, in one place
│   └── capabilities/      # one file per bridge method
└── android/app/src/main/AndroidManifest.xml
```

1. **Origin per flavour.** `dev` → `http://10.0.2.2:3000` (the emulator's route to
   the host machine's `localhost`, and the only reason a debug build needs a
   cleartext exception — never in release). `prod` → the Render URL.
2. **Cookies must survive a cold start.** The session cookie is good for 30 weeks
   (`sessionMaxAgeSeconds`), so losing it is losing nothing but the user's
   patience. Android flushes lazily: call `CookieManager.flush()` on
   `AppLifecycleState.paused`, and test with a forced process kill rather than a
   back-out.
3. **Back button** → `back` event to the page first. The page has modals — the
   confirm dialog, the invite form — and Android's back should close the top one.
   The page answers whether it handled it; if not, `canGoBack()`, then exit.
4. **A `JamChat/<version>` suffix on the `User-Agent`**, so the page can tell it
   is hosted before the bridge has said hello.
5. **A native offline screen** for the one case the page cannot render: the origin
   is unreachable, so there is no page. Retry button. This is the only native UI
   in the app, and it exists because the alternative is a white rectangle.

**Done when** the app launches, signs in with a password, survives being killed,
and messages arrive live.

---

## 5. Phase 2 — the capabilities, in order of cheapness

Each one is a bridge method plus a guarded call site in the web app. None of them
is a native screen.

**Microphone → calls.** `RECORD_AUDIO` in the manifest; `requestMicrophone`
before the first call rather than when `getUserMedia` asks, because a denied JS
prompt is not retried. `onPermissionRequest` grants `RESOURCE_AUDIO_CAPTURE`, or
the UI reports `call.error.micRefusedCalling` while the OS has in fact said yes.
A **foreground service** for the duration of a call, because Android throttles
audio capture in the background — which is exactly when the phone is against an
ear. `keepAwake` covers the screen.

**File chooser → attachments.** `pickFiles`, multi-select, capped at
`FILE_MAX_PER_MESSAGE` (3) and filtered to the server's extension allow-list, so
the refusal is native and immediate rather than a 415.

**Downloads.** The gotcha worth writing down: handing the URL to Android's
`DownloadManager` fails with a 401, because the download runs outside the WebView
and does not carry the session cookie. `saveFile` therefore reads the cookie from
`CookieManager`, sets it as a request header, transfers the file, and inserts it
into Downloads so it appears in the system UI.

---

## 6. Phase 3 — the web side

The wrapper is useless without this, and this is where most of the code is.

**`src/lib/native.js`** — the only file that knows a bridge exists:

```js
export const native = {
  available: () => Boolean(window.flutter_inappwebview),
  has: (method) => methods.has(method),       // from hello
  call: async (method, args) => { /* guarded, never throws upward */ },
  on: (type, handler) => { /* subscribe to emit() */ },
};
```

Every call site is then `native.has('x') ? native.call('x') : theWebWay()`, and
the web way is what already works today. Nothing in a component ever references
the plugin.

**Also web-side, and worth doing whether or not the app is ever built:**

- **A bug that exists on every phone today.** `.bubble-meta button` is
  `opacity: 0`, revealed by `.bubble:hover` (`src/index.css`). There is no hover
  on a touch screen, so **Reply, Edit and Delete are currently invisible and
  unreachable on mobile.** `:focus-visible` helps a keyboard, not a finger.
- **`100vh` is the wrong unit.** `.messenger` uses `calc(100vh - 13rem)`; on a
  phone `100vh` counts chrome that is occupying the space, and the soft keyboard
  makes it worse. `100dvh` with a fallback.
- **Safe areas** — `env(safe-area-inset-*)` on the composer and navbar, or Send
  sits under the gesture bar.
- **A `theme-color` meta**, so the system bars match the dark UI.

---

## 7. Phase 4 — the two server changes

The only places this repository has to change for the app to work.

**Google sign-in: accept more than one audience.** Google refuses OAuth inside an
embedded WebView (`403 disallowed_useragent`), so the token has to come from the
native `google_sign_in` plugin — which means an **Android** OAuth client, which
is a different `aud` from the web one. `createGoogleVerifier` checks against a
single `clientId` (`server/auth/google.js`). `jose` already accepts
`string | string[]` for `audience`, so this is configuration and not logic:
`GOOGLE_CLIENT_IDS` as a list, keeping the singular name as an alias.

The flow stays inside the boundary rule: native returns a token, the page posts
it to the existing `POST /api/auth/google` with `credentials: 'same-origin'`, and
the `Set-Cookie` lands in the WebView's own jar. No cookie copying, no second
session.

**Push: somewhere to keep device tokens.** A `device_tokens` model — `owner`
(reference to users, `ownedBy: 'owner'`), `token`, `platform`, `last_seen_at` —
which gets its table, permissions and CRUD from the registry for free. The page
registers the token it was handed; native never posts it.

Sending is the interesting half, and it belongs beside the code that already
answers the same question: `server/plugins/realtime.js` decides who may see a
message and pushes to their open sockets. **The push audience is that same set,
minus whoever is actually connected.** FCM credentials get the same subsystem
treatment as the database and the bucket (`server/subsystems.js`) — a push
provider that is down must not take messages down with it.

**A late connection must join a ringing call.** Covered in §8, because it is what
makes a woken app able to answer the call it was woken for — and because it is a
bug on the web today, not only on a phone.

**Ordering constraint worth stating plainly:** until push exists, an incoming
call cannot ring a killed app. `CALL_RING_SECONDS` is 40, and a wrapper with no
process running has nothing listening. Say so in the store listing rather than
letting it be discovered.

---

## 8. Calls: what should be native, and what should not

"Handle calls natively" is three separate questions wearing one coat, and they
have three different answers. Taking them apart is most of the decision.

### 8.1 The media — only if forced

The peer connections themselves could move to `flutter_webrtc`, with the page
keeping the socket, the state machine and the UI, and the bridge exposing the
primitives:

```
rtc.createPeer({ peerId, iceServers })   →  rtc.iceCandidate
rtc.setRemoteDescription({ peerId, sdp })   rtc.connectionState
rtc.createOffer / createAnswer              rtc.track
rtc.addIceCandidate / closePeer
```

This keeps the boundary rule: the page still relays every offer, answer and
candidate over its own socket, so `server/realtime/calls.js` does not change and
the signalling protocol still has exactly one client.

It is also the most expensive bridge in the app. That list is a stateful mirror
of `RTCPeerConnection` across an N-peer mesh, which means peer identity,
lifecycle and cleanup all crossing the boundary — and a missed `closePeer` is a
leaked native peer connection and a microphone that stays hot.

**So: not worth doing unless the spike says it must be.** This is the contingency
that the WebRTC-in-WebView spike exists to decide, and nothing else.

### 8.2 The signalling and the call state — never

Moving these native means opening a second `/ws` connection from Dart, which
means the native side needs the session cookie, which is the one thing §1 says it
must not have. It also gives `server/realtime/calls.js` a second consumer to be
kept in step with, and duplicates a state machine (`src/context/CallContext.jsx`)
and its translated strings.

There is no version of this that is cheaper than leaving it where it is.

### 8.3 Ringing when the app is not running — unavoidably native

This is the real answer to the question, and it has nothing to do with the spike.

**No process means no socket means no ring.** A killed app cannot be told about an
incoming call by any amount of web code, and "the phone rings" is not a nice-to-
have in a messenger. So this part is native whether or not anything else is:

1. A high-priority FCM data message wakes the app.
2. A foreground service starts.
3. A `CallStyle` notification with a full-screen intent — the thing that turns
   the screen on and shows Answer and Decline.

### The reason this does not drag the media with it

`CALL_RING_SECONDS` is **40** (`server/config/env.js`), and the server holds the
room for that whole time — there is a test for it (`test/realtime/ring-timeout`).
Cold-starting Flutter, a WebView, the SPA and the socket is somewhere around two
to five seconds on a mid-range phone.

**Forty seconds is a generous budget for a five-second boot.** So native ringing
does not require native media: the notification is native, and on Answer the app
starts, shows a native "connecting…" while the page loads, and the page joins the
call exactly as it does on a desktop. The architecture survives; only the
doorbell is native.

### The server change this needs, which does not exist yet

There is a gap here regardless of which design is chosen, and it is worth fixing
on its own merits:

`room.ringing` is a set of **connection ids, snapshotted when the call starts**
(`server/realtime/calls.js`), and the `hello` frame carries the user and their
unread counts and nothing about calls (`server/plugins/realtime.js`). So a socket
that appears *after* a call started — which is precisely what a woken app is —
connects and is told nothing. It would answer a call it does not know about.

Two small changes, either of which does it:

- a connection that identifies while a call is ringing for its user is added to
  that room's `ringing` set and sent `call:ringing`, or
- `hello` carries `{ call: { group, from, startedAt } }` when one is pending.

The first is better: it puts the connection in the room, so `call:join` works
without any special case. It is also worth having on the web — a laptop that
sleeps through the first two seconds of a call currently misses it entirely.

### What native genuinely does better, beyond ringing

Worth knowing about, and all independent of where the media lives:

- **Telecom integration** (`ConnectionService`): the call appears in the system
  call log, a Bluetooth headset button answers it, and it interoperates with the
  phone app instead of competing with it.
- **Audio routing** — earpiece, speaker, Bluetooth — and proximity screen-off.
- **Audio focus**, so the call ducks music rather than fighting it.

These are a second phase of call work, not a prerequisite.

### The permission this costs

`USE_FULL_SCREEN_INTENT` is what makes a locked phone light up, and from Android
14 it is granted at install only to apps whose core function is calling or
alarms; everything else has to ask the user. A messenger has a real claim to it,
but it is a Play review conversation and a declaration, not a formality — the
same one as `RECORD_AUDIO`.

### Recommendation

| Part | Where it lives | Why |
| :--- | :--- | :--- |
| Signalling, call state, call UI | **Web**, always | one client for the protocol; no cookie outside the WebView |
| Media (peer connections) | **Web**, unless the spike fails | the bridge for it is the most expensive one in the app |
| Ringing a killed app | **Native**, unavoidably | no process, no socket, no ring |
| Telecom / audio routing | **Native**, later | genuinely better, and not a prerequisite |

Which leaves the app a wrapper with one loud doorbell — and the doorbell needs
push (§7) to exist first, so the ordering below already has it in the right
place.

---

## 9. Risks, most likely first

| Risk | Signal | Response |
| :--- | :--- | :--- |
| WebRTC unreliable in OEM WebViews | the spike | native media (§8.1) — the only reason to build that bridge |
| Session lost on cold start | login on every launch | `flush()` on pause; verify with a forced kill |
| Old wrapper, new page | a feature silently missing | per-method detection (§2) is the whole defence |
| Woken app misses the call it woke for | manual test: kill, call, answer | the server change in §8 |
| Play review on `RECORD_AUDIO` / full-screen intent | review feedback | call UI screenshots, written justification, privacy policy |
| Cold start slower than expected on low-end devices | measure against the 40s window | native "connecting…" screen covers it; only fails if boot approaches the ring timeout |

---

## 10. Order of work

```
WebRTC-in-WebView spike (§8.1)     ← decides only whether the media bridge exists
  └─ §6 web-side: native.js shim + the mobile CSS fixes
       │        (worth shipping alone — the hover bug is live today)
       ├─ §8 server: a late connection joins a ringing room
       │        (worth shipping alone — a sleeping laptop misses calls today)
       └─ §4 wrapper: WebView, cookies, back, offline screen
            ├─ §5 microphone → calls + foreground service
            ├─ §5 pickFiles → attachments
            ├─ §5 saveFile → downloads
            ├─ §7 googleIdToken + audience list        (this repo)
            └─ §7 pushToken + device_tokens + FCM      (this repo, largest)
                 └─ §8.3 ringing: foreground service, CallStyle, full-screen intent
                      └─ release: keystore, then the OAuth client, then Play
```

The keystore comes before the OAuth client, because its SHA-1 is baked into it
and cannot be changed after publishing.

Two items are deliberately outside the app's critical path — the CSS fixes in §6
and the ringing-room fix in §8 — because both are bugs in the web application as
it stands today, and neither needs an Android project to be worth doing.
