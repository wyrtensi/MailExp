import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import { DEFAULT_TRUST_PROXY, parseTrustProxy } from './trustProxy.js';

describe('parseTrustProxy', () => {
  it('falls back to one hop when unset, blank or unusable', () => {
    for (const value of [undefined, '', '   ', 'true', 'TRUE', 'false', '11', '1; rm', '-1']) {
      expect(parseTrustProxy(value)).toBe(DEFAULT_TRUST_PROXY);
    }
    expect(DEFAULT_TRUST_PROXY).toBe(1);
  });

  it('takes a hop count', () => {
    expect(parseTrustProxy('2')).toBe(2);
    expect(parseTrustProxy(' 0 ')).toBe(0);
  });

  it('takes a list of proxy addresses and subnets', () => {
    expect(parseTrustProxy('loopback, 172.16.0.0/12')).toEqual(['loopback', '172.16.0.0/12']);
  });
});

// What req.ip becomes through the production chain: an edge in front of nginx in front of the
// backend. nginx appends the address it saw (the edge, via the Docker port) to X-Forwarded-For.
describe('req.ip behind the proxies', () => {
  let servers = [];
  async function ipFor(trust, forwardedFor) {
    const app = express();
    app.set('trust proxy', parseTrustProxy(trust));
    app.get('/', (req, res) => res.json({ ip: req.ip }));
    const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    servers.push(server);
    const res = await fetch(`http://127.0.0.1:${server.address().port}/`, { headers: { 'X-Forwarded-For': forwardedFor } });
    return (await res.json()).ip;
  }
  beforeAll(() => { servers = []; });
  afterAll(async () => { await Promise.all(servers.map((s) => new Promise((resolve) => s.close(resolve)))); });

  it('gives the client behind Caddy and nginx with two hops', async () => {
    // Caddy: "<client>"; nginx appends the Docker gateway it saw Caddy come from.
    expect(await ipFor('2', '203.0.113.7, 172.18.0.1')).toBe('203.0.113.7');
  });

  it('gives the client behind Cloudflare and nginx with two hops, whatever the visitor sent', async () => {
    // Cloudflare appends the visitor's address to a header the visitor forged.
    expect(await ipFor('2', '198.51.100.99, 203.0.113.7, 172.18.0.1')).toBe('203.0.113.7');
  });

  it('gave every client the same address with one hop in that chain', async () => {
    expect(await ipFor('1', '203.0.113.7, 172.18.0.1')).toBe('172.18.0.1');
    expect(await ipFor('1', '203.0.113.8, 172.18.0.1')).toBe('172.18.0.1');
  });

  it('does not trust a forged address with one hop behind nginx alone', async () => {
    expect(await ipFor(undefined, '198.51.100.99, 203.0.113.7')).toBe('203.0.113.7');
  });
});
