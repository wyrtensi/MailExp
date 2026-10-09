import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { EventEmitter, once } from 'node:events';
import express from 'express';
import session from 'express-session';
import { buildSessionOptions } from './sessionConfig.js';
import { guardedSessionStore } from './sessionStore.js';

// express-session saves the whole session when a request that changed it ends. A request that
// read the session, then waits (on IMAP, SMTP, an IdP) and changes it would put back the copy it
// read over a lock, an unlock or a sign-out that another request made in the meantime. Drives the
// real middleware with the options the server uses, so the store they configure is what is tested.
const handling = new EventEmitter();
let heldHandler = null;
let store;
let server;
let base;

beforeAll(async () => {
  store = new session.MemoryStore();
  const app = express();
  app.use(session(buildSessionOptions(store, 'test-secret-'.padEnd(40, 'x'))));
  app.get('/login', (req, res) => req.session.regenerate(() => {
    req.session.userId = 'u1';
    res.json({ ok: true });
  }));
  app.get('/lock', (req, res) => { req.session.locked = true; res.json({ ok: true }); });
  app.get('/unlock', (req, res) => { req.session.locked = false; res.json({ ok: true }); });
  app.get('/logout', (req, res) => req.session.destroy(() => res.json({ ok: true })));
  app.get('/session', (req, res) => res.json({
    userId: req.session.userId ?? null, locked: !!req.session.locked, note: req.session.note ?? null, step: req.session.step ?? null,
  }));
  // A request that changes the session and then waits before it answers, as an OAuth connect
  // that stores its state does.
  app.get('/slow-write', async (req, res) => {
    req.session.note = req.query.note;
    handling.emit('handling');
    await heldHandler;
    res.json({ ok: true });
  });
  // Saves part way and changes the session again before it answers.
  app.get('/save-twice', (req, res) => {
    req.session.step = 'first';
    req.session.save(() => {
      req.session.step = 'second';
      res.json({ ok: true });
    });
  });
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

const cookieFrom = (res) => (res.headers.get('set-cookie') || '').split(';')[0];
const get = async (path, cookie) => {
  const res = await fetch(`${base}${path}`, { headers: cookie ? { cookie } : {} });
  await res.clone().arrayBuffer();
  return res;
};
const signIn = async () => cookieFrom(await get('/login'));
const sessionOf = async (cookie) => (await get('/session', cookie)).json();
const storedCount = () => new Promise((resolve) => store.length((_err, n) => resolve(n)));

// Runs `meanwhile` while /slow-write, which has already changed the session, is waiting.
async function whileWriting(cookie, meanwhile, note = 'slow') {
  let release;
  heldHandler = new Promise((resolve) => { release = resolve; });
  try {
    const started = once(handling, 'handling');
    const request = get(`/slow-write?note=${note}`, cookie);
    await started;
    await meanwhile();
    release();
    return (await request).status;
  } finally {
    release();
    heldHandler = null;
  }
}

describe('concurrent session writes', () => {
  it('keeps a lock that lands while another request that changed the session is working', async () => {
    const cookie = await signIn();
    expect(await whileWriting(cookie, () => get('/lock', cookie))).toBe(200);
    // The slow request's own change is kept too.
    expect(await sessionOf(cookie)).toEqual({ userId: 'u1', locked: true, note: 'slow', step: null });
  });

  it('keeps an unlock that lands while another request that changed the session is working', async () => {
    const cookie = await signIn();
    await get('/lock', cookie);
    expect(await whileWriting(cookie, () => get('/unlock', cookie))).toBe(200);
    expect(await sessionOf(cookie)).toEqual({ userId: 'u1', locked: false, note: 'slow', step: null });
  });

  it('does not bring back a session that signed out while another request was working', async () => {
    const cookie = await signIn();
    const before = await storedCount();
    expect(await whileWriting(cookie, () => get('/logout', cookie))).toBe(200);
    expect(await sessionOf(cookie)).toEqual({ userId: null, locked: false, note: null, step: null });
    expect(await storedCount()).toBe(before - 1);
  });

  it('keeps the change of each of two requests that overlap', async () => {
    const cookie = await signIn();
    // The second one also saves part way, and still gets its last change saved when it ends.
    expect(await whileWriting(cookie, () => get('/save-twice', cookie))).toBe(200);
    expect(await sessionOf(cookie)).toEqual({ userId: 'u1', locked: false, note: 'slow', step: 'second' });
  });

  it('still saves a new sign-in, and the session of a client that had none', async () => {
    const cookie = await signIn();
    await get('/lock', cookie);
    // Signing in again regenerates the session, so the new one starts unlocked.
    const again = cookieFrom(await get('/login', cookie));
    expect(again).not.toBe(cookie);
    expect(await sessionOf(again)).toEqual({ userId: 'u1', locked: false, note: null, step: null });

    const fresh = cookieFrom(await get('/slow-write?note=first-visit'));
    expect(await sessionOf(fresh)).toEqual({ userId: null, locked: false, note: 'first-visit', step: null });
  });
});

// The guarded store on its own, in front of a store whose calls a test sees and can hold back.
describe('guarded session store', () => {
  const cookie = () => ({ originalMaxAge: 60_000, expires: new Date(Date.now() + 60_000).toISOString() });
  function innerStore() {
    const inner = {
      data: new Map(), sets: [], touches: [], getError: null, holdSets: false, heldSets: [],
      get(sid, callback) {
        setImmediate(() => callback(inner.getError, inner.data.has(sid) ? JSON.parse(inner.data.get(sid)) : undefined));
      },
      set(sid, sess, callback) {
        inner.data.set(sid, JSON.stringify(sess));
        inner.sets.push(JSON.parse(JSON.stringify(sess)));
        if (inner.holdSets) inner.heldSets.push(callback);
        else setImmediate(callback);
      },
      touch(sid, _sess, callback) { inner.touches.push(sid); setImmediate(callback); },
      destroy(sid, callback) { inner.data.delete(sid); setImmediate(callback); },
    };
    return inner;
  }
  // A session read from the store, as express-session's load builds it.
  function load(store, inner, sid) {
    return store.createSession({ sessionID: sid, sessionStore: store }, JSON.parse(inner.data.get(sid)));
  }
  const save = (sess) => new Promise((resolve, reject) => sess.save((err) => (err ? reject(err) : resolve())));
  const stored = (inner, sid) => {
    const fields = JSON.parse(inner.data.get(sid));
    delete fields.cookie;
    return fields;
  };
  const until = (check) => new Promise((resolve) => {
    const wait = () => (check() ? resolve() : setImmediate(wait));
    wait();
  });

  it('saves a change made while its previous write was under way', async () => {
    const inner = innerStore();
    const store = guardedSessionStore(inner);
    inner.data.set('s1', JSON.stringify({ cookie: cookie(), userId: 'u1' }));
    const sess = load(store, inner, 's1');
    sess.note = 'first';
    inner.holdSets = true;
    const saving = save(sess);
    // The write has reached the store but not been answered yet.
    await until(() => inner.heldSets.length);
    sess.note = 'second';
    inner.holdSets = false;
    inner.heldSets.pop()();
    await saving;
    expect(stored(inner, 's1')).toEqual({ userId: 'u1', note: 'first' });
    await save(sess);
    expect(stored(inner, 's1')).toEqual({ userId: 'u1', note: 'second' });
  });

  it('removes a field the request deleted and keeps one another request changed meanwhile', async () => {
    const inner = innerStore();
    const store = guardedSessionStore(inner);
    inner.data.set('s1', JSON.stringify({ cookie: cookie(), userId: 'u1', oauthNonce: 'n', locked: false }));
    const sess = load(store, inner, 's1');
    delete sess.oauthNonce;
    const other = load(store, inner, 's1');
    other.locked = true;
    await save(other);
    await save(sess);
    expect(stored(inner, 's1')).toEqual({ userId: 'u1', locked: true });
  });

  it('only refreshes the expiry when the request changed nothing', async () => {
    const inner = innerStore();
    const store = guardedSessionStore(inner);
    inner.data.set('s1', JSON.stringify({ cookie: cookie(), userId: 'u1' }));
    await save(load(store, inner, 's1'));
    expect(inner.sets).toEqual([]);
    expect(inner.touches).toEqual(['s1']);
  });

  it('passes on a store failure while reading before a write', async () => {
    const inner = innerStore();
    const store = guardedSessionStore(inner);
    inner.data.set('s1', JSON.stringify({ cookie: cookie(), userId: 'u1' }));
    const sess = load(store, inner, 's1');
    sess.note = 'x';
    inner.getError = new Error('store unavailable');
    await expect(save(sess)).rejects.toThrow('store unavailable');
    expect(inner.sets).toEqual([]);
  });
});
