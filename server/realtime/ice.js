import { createHmac } from 'node:crypto';

/**
 * The ICE servers a browser is told to use, and the credentials that let it.
 *
 * Two thirds of calls connect on STUN alone: it does nothing but tell a
 * browser what its address looks like from outside, so the two peers can find
 * each other directly. The rest — symmetric NAT, strict corporate firewalls —
 * have no direct path at all, and their audio has to be relayed by a TURN
 * server that both ends can reach.
 *
 * A relay costs bandwidth, which is why TURN credentials are worth stealing
 * and why they are minted here per request rather than configured into the
 * client. With `TURN_SECRET` set, the pair handed out is
 *
 *   username    <expiry unix seconds>:<user id>
 *   credential  base64(HMAC-SHA1(secret, username))
 *
 * which is coturn's `use-auth-secret` scheme (the TURN REST API most managed
 * providers implement). The TURN server verifies it with the same secret and
 * refuses it after the expiry, so a credential scraped out of a browser is
 * worth an hour of somebody else's bandwidth rather than all of it. The secret
 * never leaves this process.
 */

/**
 * `iceServers` as RTCPeerConnection wants them, plus the seconds they are good
 * for. `now` is injectable so the expiry can be asserted rather than guessed.
 */
export function iceServersFor(config, userId, now = Date.now()) {
  const servers = [{ urls: config.stunUrls }];

  if (config.turnUrls.length === 0) return { iceServers: servers, ttl: config.turnTtlSeconds };

  if (config.turnSecret) {
    const expiry = Math.floor(now / 1000) + config.turnTtlSeconds;
    const username = `${expiry}:${userId}`;

    servers.push({
      urls: config.turnUrls,
      username,
      credential: createHmac('sha1', config.turnSecret).update(username).digest('base64'),
    });
  } else if (config.turnUsername && config.turnPassword) {
    // A provider that issues a fixed pair. It works, but every browser that
    // has ever called holds a credential that never expires.
    servers.push({
      urls: config.turnUrls,
      username: config.turnUsername,
      credential: config.turnPassword,
    });
  }

  return { iceServers: servers, ttl: config.turnTtlSeconds };
}
