// Express `trust proxy` from TRUST_PROXY: how many proxies in front of the backend append to
// X-Forwarded-For, so req.ip (the sign-in rate limit, the auth log) is the client's address and
// not a proxy's.
//
//   1  docker-compose.yml alone: nginx in the frontend container is the only proxy.
//   2  deploy/compose.prod.yml and docker-compose.https.yml: an edge (Caddy, or cloudflared for
//      the Cloudflare host) in front of that nginx. Caddy sets X-Forwarded-For to the address it
//      saw; Cloudflare appends the visitor's address to whatever the visitor sent, so its
//      rightmost entry is the one CF-Connecting-IP carries
//      (https://developers.cloudflare.com/fundamentals/reference/http-headers/). Two hops therefore
//      give the real client through either edge. CF-Connecting-IP itself is not read: in the
//      `both` mode the same nginx also serves the Caddy host, where a visitor can send that header
//      and nothing removes it.
//
// Too high a number trusts an address the visitor wrote, so a missing or unusable value falls
// back to 1, the safe value for the plain compose file. A list of proxy addresses or subnets
// (Express syntax, e.g. "loopback, 172.16.0.0/12") is accepted as well; `true` (trust everyone)
// is not.
export const DEFAULT_TRUST_PROXY = 1;
const MAX_HOPS = 10;
const ADDRESS_LIST = /^[A-Za-z0-9.:/,\s]+$/;

export function parseTrustProxy(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return DEFAULT_TRUST_PROXY;
  if (/^\d+$/.test(raw)) {
    const hops = Number(raw);
    return hops <= MAX_HOPS ? hops : DEFAULT_TRUST_PROXY;
  }
  if (/^(true|false)$/i.test(raw) || !ADDRESS_LIST.test(raw)) return DEFAULT_TRUST_PROXY;
  return raw.split(',').map((part) => part.trim()).filter(Boolean);
}
