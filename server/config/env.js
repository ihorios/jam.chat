import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Project root — the directory holding package.json, .env and dist/. */
export const rootDir = path.resolve(__dirname, '..', '..');

// Load .env before anything reads process.env. Every module that needs an
// environment variable imports `config` from here, so the import graph
// guarantees this runs first — no reliance on import declaration order.
// Variables already set in the real environment take precedence over the
// file, so hosted deploys (Render, etc.) are unaffected.
const envPath = path.join(rootDir, '.env');

if (fs.existsSync(envPath)) {
  try {
    process.loadEnvFile(envPath);
    console.log('🔑 Loaded environment variables from .env');
  } catch (err) {
    console.warn('⚠️ Failed to parse .env:', err.message);
  }
}

const nodeEnv = process.env.NODE_ENV || 'development';

// Signs the session cookie. Without a stable value every restart invalidates
// all sessions — fine locally, but it also means multiple instances cannot
// validate each other's cookies, so a real deployment must set this.
const sessionSecret = process.env.SESSION_SECRET || randomBytes(32).toString('hex');
if (!process.env.SESSION_SECRET) {
  console.warn(
    nodeEnv === 'production'
      ? '⚠️ SESSION_SECRET is not set. Using a random per-process secret: every restart logs all users out, and multiple instances will reject each other\'s sessions.'
      : 'ℹ️ SESSION_SECRET not set. Using a random per-process secret (sessions end on restart).'
  );
}

/** A comma-separated environment variable as a list, blanks dropped. */
const list = (value) => String(value || '')
  .split(',')
  .map((entry) => entry.trim())
  .filter(Boolean);

/**
 * Public STUN, which only tells a browser its own address from outside. Enough
 * for most home and mobile networks; the rest need a TURN relay, which is
 * somebody's server to run and therefore configured rather than defaulted.
 */
const DEFAULT_STUN = ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'];

/**
 * One rate-limit policy, overridable per name:
 * LOGIN_RATE_LIMIT_MAX / LOGIN_RATE_LIMIT_WINDOW_SECONDS, and so on.
 */
const limitFrom = (name, limit, windowSeconds) => Object.freeze({
  limit: parseInt(process.env[`${name}_RATE_LIMIT_MAX`] || String(limit), 10),
  windowSeconds: parseInt(
    process.env[`${name}_RATE_LIMIT_WINDOW_SECONDS`] || String(windowSeconds),
    10
  ),
});

export const config = Object.freeze({
  nodeEnv,
  isProduction: nodeEnv === 'production',
  // The only directory served over HTTP. It is the Vite build output and
  // nothing else — never the project root, which holds .env and the source.
  staticDir: process.env.STATIC_DIR || path.join(rootDir, 'dist'),
  sessionSecret,
  // Session 30 days.
  sessionMaxAgeSeconds: 60 * 60 * 24 * 7 * 30,
  port: parseInt(process.env.PORT || '3000', 10),
  /*
   * How long a Fastify plugin may take to come up.
   *
   * avvio allows 10 seconds by default, which is a sensible guard against a
   * plugin that has forgotten to resolve and a poor fit for one whose work is
   * network-bound. The db plugin creates the schema, and every statement is a
   * round trip: at 150ms to a managed database that budget is spent while
   * everything is working correctly, and the failure it produces —
   * "Plugin did not start in time: 'db'" — reads like a bug in the plugin
   * rather than a slow link.
   */
  pluginTimeoutMs: parseInt(process.env.PLUGIN_TIMEOUT_MS || '30000', 10),
  /*
   * How long the data layer gets to come up before the boot gives up on it and
   * carries on without it.
   *
   * Deliberately well inside pluginTimeoutMs: whichever of the two fires first
   * decides what the failure looks like, and this one produces a running server
   * that says what is wrong, while the other produces no server at all.
   */
  dbBootTimeoutMs: parseInt(process.env.DB_BOOT_TIMEOUT_MS || '15000', 10),
  /** The same bound for settling where attachments go. See plugins/files.js. */
  fileBootTimeoutMs: parseInt(process.env.FILE_BOOT_TIMEOUT_MS || '15000', 10),
  /*
   * How long a shutdown gets before the process stops waiting for it.
   *
   * The bound on the way out, as the two above are on the way in. `close()`
   * lets in-flight requests finish and releases the pool; what it must never do
   * is hold the port while a wedged query or a socket that will not die keeps it
   * open, because the instance replacing this one needs that port. See
   * server/index.js.
   *
   * Configurable because the right number is a property of the deployment
   * rather than of the code: it wants to be comfortably under whatever the
   * platform allows between SIGTERM and SIGKILL, and platforms disagree about
   * that. Render allows 30 seconds; five is a wide margin inside it.
   */
  shutdownTimeoutMs: parseInt(process.env.SHUTDOWN_TIMEOUT_MS || '5000', 10),
  host: process.env.HOST || '0.0.0.0',

  /**
   * How many proxies sit in front of this server, for working out who a
   * request actually came from.
   *
   * It matters more than it looks: behind Render's load balancer every request
   * arrives from the same address, so without this the rate limiter would put
   * every user in one bucket and lock them all out together. One hop rather
   * than `true`, because trusting the whole X-Forwarded-For chain lets a
   * client prepend an address of its choosing and pick its own bucket.
   */
  trustProxy: process.env.TRUST_PROXY
    ? (Number.parseInt(process.env.TRUST_PROXY, 10) || 0)
    : (nodeEnv === 'production' ? 1 : false),
  // Postgres connection string; when absent the app falls back to an
  // in-memory user store (see server/db/index.js).
  connectionString: process.env.DB_STRING || process.env.DATABASE_URL || null,

  /**
   * The first account, written by the users model's seed when the address is
   * free — a fresh database otherwise has no way in, because the one write an
   * anonymous caller may perform is self-registration and that grants no roles.
   *
   * Entirely configuration: with no ADMIN_EMAIL and ADMIN_PASSWORD nothing is
   * seeded. No credential is defaulted in code on purpose — a password in the
   * repository is a password every deployment ships with, and one that has to
   * be set is one somebody chose. The name is not a credential, so it falls
   * back rather than blocking the seed.
   *
   * The password still has to satisfy PASSWORD_RULES (db/models/fields.js):
   * the seed goes through the model like every other write, and is refused if
   * it does not.
   */
  admin: Object.freeze({
    email: process.env.ADMIN_EMAIL || null,
    firstName: process.env.ADMIN_NAME || 'Admin',
    password: process.env.ADMIN_PASSWORD || null,
  }),

  /* Sign in with Google ------------------------------------------------------
   *
   * Google is the identity provider; the accounts, roles and session cookie
   * remain this application's. The browser signs in with Google, receives an
   * ID token, and hands it to POST /api/auth/google, which verifies it against
   * Google's published keys before starting a session of its own.
   *
   * One OAuth client id, from the Google Cloud console. With it unset the
   * route is never mounted, so an installation that does not want Google
   * sign-in does not have an unused way in.
   *
   * The client half is configured separately, as VITE_GOOGLE_CLIENT_ID — it is
   * baked into the bundle at build time and so cannot be read from here. It is
   * the same value; a client id is public, and is published to every browser
   * that loads the sign-in button.
   */
  googleClientId: process.env.GOOGLE_CLIENT_ID || null,

  /* Calls ------------------------------------------------------------------
   *
   * TURN is configured two ways, because providers offer two:
   *
   *   TURN_SECRET      a shared secret, from which the server mints a
   *                    username/password pair that expires (coturn's
   *                    `use-auth-secret`, and what most managed TURN speaks)
   *   TURN_USERNAME    a fixed pair, for a provider that issues one
   *   TURN_PASSWORD
   *
   * The secret is much the better of the two: nothing long-lived ever reaches
   * a browser, so a credential scraped out of one stops working within the
   * hour. A static pair in a client bundle is an open relay with a delay.
   *
   * The secret itself must never be sent to a client, and is not — see
   * server/realtime/ice.js, the only file that reads it.
   */
  stunUrls: list(process.env.STUN_URLS).length > 0 ? list(process.env.STUN_URLS) : DEFAULT_STUN,
  turnUrls: list(process.env.TURN_URLS),
  turnSecret: process.env.TURN_SECRET || null,
  turnUsername: process.env.TURN_USERNAME || null,
  turnPassword: process.env.TURN_PASSWORD || null,
  turnTtlSeconds: parseInt(process.env.TURN_TTL_SECONDS || '3600', 10),

  /** How long an unanswered call rings before it gives up. */
  callRingSeconds: parseInt(process.env.CALL_RING_SECONDS || '40', 10),

  /* Flood control ---------------------------------------------------------
   *
   * One policy per thing worth protecting, because the right number is not
   * the same for all of them: a hundred requests in five minutes is nothing
   * for somebody using the app and a great deal for somebody guessing
   * passwords.
   *
   * Each is `<attempts> per <window>`, counted per caller — by address where
   * there is no session yet, and by session where there is, since an address
   * is shared by everyone behind one office router.
   */
  rateLimitEnabled: process.env.RATE_LIMIT_ENABLED !== 'false',
  rateLimits: Object.freeze({
    /** Password guessing. Deliberately the tightest: each attempt costs bcrypt. */
    login: limitFrom('LOGIN', 10, 300),
    /** Public, and it creates rows. */
    register: limitFrom('REGISTER', 5, 3600),
    /** Per session: 3 files of 5MB each is a lot of bandwidth to repeat. */
    upload: limitFrom('UPLOAD', 30, 300),
    /** Per socket. Offers and candidates arrive in bursts, so this is generous. */
    signal: limitFrom('SIGNAL', 600, 60),
    /** The catch-all flood guard over /api, per address. */
    api: limitFrom('API', 600, 300),
  }),

  /* Attachments -----------------------------------------------------------
   *
   * Bytes live in object storage, never in Postgres. The variables are the
   * AWS-standard ones so that the AWS CLI, the SDKs and this server can all be
   * pointed at the same bucket from the same .env — which is what makes the
   * smoke test in docs/file.md prove anything about the app.
   *
   * With no endpoint or keys configured the provider falls back to an
   * in-process store, exactly as the database falls back to an in-memory one:
   * the app boots, uploads work, and nothing survives a restart.
   */
  s3: Object.freeze({
    endpoint: process.env.AWS_ENDPOINT_URL_S3 || null,
    region: process.env.AWS_REGION || 'us-east-1',
    bucket: process.env.S3_BUCKET || process.env.AWS_S3_BUCKET || null,
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || null,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || null,
    // <endpoint>/<bucket>/<key>, which is what most S3-compatible services
    // outside AWS want. Set to 'false' for virtual-host addressing.
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE !== 'false',
    /*
     * How long any one request to the bucket may take.
     *
     * Generous enough for the largest attachment this server accepts over a
     * poor connection, and short enough that a blackholed endpoint fails as an
     * error rather than as a hang. `fetch` has no default of its own — without
     * this the boot check and every upload wait on the operating system.
     */
    timeoutMs: parseInt(process.env.S3_TIMEOUT_MS || '20000', 10),
  }),

  /** 's3', 'local', or unset to decide from whether a bucket is configured. */
  fileProvider: process.env.FILE_PROVIDER || null,
  /**
   * Where the local provider keeps its objects. Never inside dist/ or the
   * project root proper: nothing here is served as a static file, and the only
   * way to read one is through the download route and its membership check.
   */
  fileDir: process.env.FILE_DIR || path.join(rootDir, '.files'),
  fileMaxBytes: parseInt(process.env.FILE_MAX_BYTES || String(5 * 1024 * 1024), 10),
  fileMaxPerMessage: parseInt(process.env.FILE_MAX_PER_MESSAGE || '3', 10),
  /**
   * How long a file may exist attached to nothing before the sweep collects
   * it. Long enough that a file uploaded into a half-written message is never
   * taken out from under its author.
   */
  fileSweepGraceSeconds: parseInt(process.env.FILE_SWEEP_GRACE_SECONDS || '3600', 10),
  /** Lower-case, no dots. Empty means anything is allowed. */
  fileAllowedExtensions: list(process.env.FILE_ALLOWED_EXTENSIONS)
    .map((entry) => entry.replace(/^\./, '').toLowerCase()),
});
