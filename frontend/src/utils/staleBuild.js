// A tab opened before a server update keeps running the old app. Vite names each lazily loaded
// file (Settings, Contacts, the composer) by a hash of its contents, and after an update the server
// has only the new set, so the first of those screens the old app opens fails with the browser's
// dynamic-import error. A reload picks up the new app: index.html is served no-store.
//
// Dependency-free on purpose: ErrorBoundary uses it, and the boundary must not import anything
// that could itself be what failed.

// Firefox, Chromium and Safari word the failure differently; Vite adds its own for CSS.
const STALE_BUILD_MESSAGES = [
  /error loading dynamically imported module/i,
  /failed to fetch dynamically imported module/i,
  /importing a module script failed/i,
  /unable to preload css/i,
];

export function isStaleBuildError(error) {
  const message = String(error?.message ?? error ?? '');
  return STALE_BUILD_MESSAGES.some(re => re.test(message));
}

// The build the server runs now: the sha GET /api/version answers (backend index.js; the same
// image sha the frontend is built with as VITE_BUILD_SHA), or null when there is no such answer.
// The edge's maintenance page while the panel updates answers HTML, often with 200: that is not a
// server that is up, so only a JSON body with a sha counts.
export async function fetchServerBuild(fetchImpl = globalThis.fetch) {
  try {
    const res = await fetchImpl('/api/version', { cache: 'no-store', credentials: 'same-origin' });
    if (!res?.ok || !/application\/json/i.test(res.headers?.get?.('content-type') ?? '')) return null;
    const body = await res.json();
    return typeof body?.sha === 'string' && body.sha ? body.sha : null;
  } catch {
    return null;
  }
}

const RELOADED_INTO_KEY = 'mailexpert_stale_build_reloaded_into';

// Records an automatic reload into the server's build `target` and answers whether one may happen
// now: once per build. Should the reload not bring the new app up (a startup file that is really
// missing, an index.html some cache still serves old), the next failure finds that build already
// tried and leaves the reload to the user instead of looping. Without session storage (some
// private modes throw) a loop could not be stopped, so it answers no and the user reloads.
export function claimReloadInto(storage, target) {
  if (!target) return false;
  try {
    if (storage.getItem(RELOADED_INTO_KEY) === target) return false;
    storage.setItem(RELOADED_INTO_KEY, target);
    return true;
  } catch {
    return false;
  }
}
