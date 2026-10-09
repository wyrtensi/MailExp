import session from 'express-session';

// express-session saves the whole session object when a request that changed it ends. A request
// holds the copy it read for as long as it runs (a mail send waits on SMTP, an OAuth connect on
// the provider), so saving that copy would undo whatever another request did to the session
// meanwhile: a screen lock or unlock, a sign-out, a password reset that ended every session of
// the account. This store sits in front of the real one and writes only what the request itself
// changed:
//  - A session read from the store and written back is merged into the one stored now: the
//    fields this request changed since it read (or last wrote) the session take its values, every
//    other field keeps what the store holds. A write that changed nothing only refreshes the expiry.
//  - A session read from the store that the store no longer holds has ended (signed out, reset,
//    expired) and is not written back.
//  - A session this request created (a new visitor, a sign-in, which regenerates the session under
//    a new id) is written as it is.
// Reading and writing are two store calls, so a change landing between them is still lost; that
// leaves a window of one store round trip, where saving the copy read left the whole request.

// The fields of each session as it was read from the store or last written, by Session object.
// express-session's own load, req.session.reload() and middleware/bodyParsers.js's reloadSession
// all build the session through createSession.
const baseOf = new WeakMap();

// A session's fields as JSON text, by name. The cookie is the request's to set, and is left out
// as express-session leaves it out when telling whether a session changed.
function fieldsOf(sess) {
  const fields = new Map();
  for (const [key, value] of Object.entries(sess)) {
    if (key !== 'cookie') fields.set(key, JSON.stringify(value));
  }
  return fields;
}

class GuardedStore extends session.Store {
  constructor(inner) {
    super();
    this.inner = inner;
  }

  createSession(req, sess) {
    const base = fieldsOf(sess);
    const created = super.createSession(req, sess);
    baseOf.set(created, base);
    return created;
  }

  // The inner store's methods are looked up on each call, so one replaced on it later still runs.
  get(sid, callback) { this.inner.get(sid, callback); }

  destroy(sid, callback) { this.inner.destroy(sid, callback); }

  touch(sid, sess, callback) {
    if (typeof this.inner.touch === 'function') return this.inner.touch(sid, sess, callback);
    callback?.();
  }

  set(sid, sess, callback = () => {}) {
    const written = (err) => {
      if (!err) baseOf.set(sess, fieldsOf(sess));
      callback(err);
    };
    const base = baseOf.get(sess);
    if (!base) return this.inner.set(sid, sess, written);
    this.inner.get(sid, (err, stored) => {
      if (err) return callback(err);
      // Ended since this request read it. Nothing to write; not an error to the request either.
      if (!stored) return callback();
      const mine = fieldsOf(sess);
      const changed = [...new Set([...base.keys(), ...mine.keys()])].filter((key) => base.get(key) !== mine.get(key));
      if (!changed.length) return this.touch(sid, sess, callback);
      for (const key of changed) {
        if (mine.has(key)) stored[key] = sess[key];
        else delete stored[key];
      }
      stored.cookie = sess.cookie;
      this.inner.set(sid, stored, written);
    });
  }
}

export function guardedSessionStore(inner) {
  return new GuardedStore(inner);
}
