import express from 'express';
import { requireAuth } from './auth.js';
import { composeJson } from './composeBody.js';

// The routes that accept a body over the global 1 MB limit, and their parsers. Attachments of
// the composer travel as base64 (middleware/composeBody.js). A pet-import body carries a base64
// spritesheet (~33% larger than the 5 MB sheet cap enforced after decode in gtdPet.importPet).
export const LARGE_BODY_PARSERS = Object.freeze({
  '/api/mail/send': composeJson,
  '/api/mail/draft': composeJson,
  '/api/gtd/pet/import': () => express.json({ limit: '8mb' }),
});

// The routers behind these larger limits require a signed-in user, but only once the body has
// been parsed, so without checks in front of the parsers anyone could make the server read,
// inflate and parse up to 45 MB per request. Each path first loads the session and runs what
// every signed-in /api request passes later anyway: the identity gate (google sign-in mode),
// the CSRF header check, and a sign-in check. index.js mounts this before its own session
// middleware and global parser; express-session skips a request whose session is already
// loaded, and the global parser skips a body already read. After the body is in, the session is
// read again, and the identity gate, CSRF check, screen lock and the router's requireAuth run
// on it as on any other request.
export function mountBodyParsers(app, { sessionMiddleware, identityGate, csrf }) {
  const beforeParsing = [
    loadSessionBeforeParsing(sessionMiddleware),
    answerAfterBody(identityGate),
    answerAfterBody(csrf),
    requireSignInBeforeParsing,
    saveSessionBeforeParsing,
  ];
  for (const [path, parser] of Object.entries(LARGE_BODY_PARSERS)) {
    app.use(path, beforeParsing, parser(), reloadSession);
  }
}

// Reads off and discards the rest of the body, then calls back, as body-parser does before it
// reports an error. nginx sends Connection: close, and Node closing such a socket with body data
// still unread resets the connection, which can lose the answer before the client reads it.
function discardBody(req, callback) {
  if (req.readableEnded || req.destroyed || req.complete) return callback();
  req.once('end', callback);
  req.resume();
}

// A check that answers by itself (res.json) gets its answer sent only after the body has been
// read off; one that fails (next(err)) gets the error passed on after it too.
function answerAfterBody(check) {
  return (req, res, next) => {
    const end = res.end;
    res.end = function endAfterBody(...args) {
      res.end = end;
      discardBody(req, () => end.apply(res, args));
      return res;
    };
    check(req, res, (err) => {
      res.end = end;
      if (err) return discardBody(req, () => next(err));
      next();
    });
  };
}

// A session store that fails (Redis restarting, say) gets its error answered after the body too.
function loadSessionBeforeParsing(sessionMiddleware) {
  return (req, res, next) => sessionMiddleware(req, res, (err) => (err ? discardBody(req, () => next(err)) : next()));
}

// A signed-out request gets requireAuth's 401 without its body being buffered, inflated or
// parsed. A signed-in request goes on to the parser unchecked here: the router's requireAuth
// looks up its account once the body has been read, so a 401 for an account deleted since
// sign-in is not lost either.
function requireSignInBeforeParsing(req, res, next) {
  if (req.session?.userId) return next();
  discardBody(req, () => requireAuth(req, res, next));
}

// The identity gate may have just bound a new session (a Cloudflare Access token with no session
// yet), which the store holds only once saved. Saving it now lets reloadSession tell a session
// that ended during the upload from one that was never stored.
function saveSessionBeforeParsing(req, res, next) {
  req.session.save((err) => (err ? discardBody(req, () => next(err)) : next()));
}

// The session was read before the upload, so it is read again now that the body is in: a
// sign-out, a screen lock or a password reset during a long upload still stops the request, as it
// did when these paths read the session after parsing. This is what req.session.reload() does,
// except that a session which has ended is told apart from a store error.
function reloadSession(req, res, next) {
  req.sessionStore.get(req.sessionID, (err, sess) => {
    if (err) return next(err);
    if (sess) {
      req.sessionStore.createSession(req, sess);
      return next();
    }
    // Drop the ended session, as req.session.destroy() does, so no cookie goes out for it, and
    // answer as for any signed-out request.
    delete req.session;
    requireAuth(req, res, next);
  });
}
