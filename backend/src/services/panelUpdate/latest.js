// Which build the promoted `latest` channel points at, and how the running build compares with it,
// for updating the panel from the admin UI.
//
// The git tag `latest` in the repository is force-moved by the manual promote workflow. The backend
// reads it from GitHub's API anonymously (host-pinned URLs, no user input in them, via safeFetch),
// then asks GitHub to compare the running build (BUILD_SHA) with it. The answer is cached for 6 h,
// a failure is retried no sooner than 15 min (the last good answer is kept meanwhile), a rate limit
// is waited out until its reset, and an admin can force a refresh at most once a minute.
// UPDATE_CHECK_DISABLED turns it off, as for the release banner (services/updateCheck.js).
import { safeFetch } from '../safeFetch.js';

const TTL_MS = 6 * 60 * 60 * 1000;
const FAIL_BACKOFF_MS = 15 * 60 * 1000;
const FORCE_MIN_INTERVAL_MS = 60 * 1000;
const REQUEST_TIMEOUT_MS = 5000;

const SHA_RE = /^[0-9a-f]{40}$/;
const COMPARE_STATUSES = new Set(['ahead', 'behind', 'identical', 'diverged']);

export const versionOf = (sha) => `sha-${sha.slice(0, 12)}`;

const isDisabled = (env) => /^(1|true|yes|on)$/i.test(env.UPDATE_CHECK_DISABLED || '');

// The commit this panel runs (BUILD_SHA, set by the image build), or nulls on a build without one.
export function currentOf(env = process.env) {
  const sha = String(env.BUILD_SHA || '').trim().toLowerCase();
  return SHA_RE.test(sha) ? { sha, version: versionOf(sha) } : { sha: null, version: null };
}

const EMPTY_COMPARE = Object.freeze({ status: null, aheadBy: null, url: null });

class CheckError extends Error {
  constructor(code, retryAt = null) {
    super(code);
    this.code = code;
    this.retryAt = retryAt;
  }
}

export function createLatestCheck({ fetch = safeFetch, env = process.env, now = () => Date.now() } = {}) {
  const repo = String(env.UPDATE_CHECK_REPO || 'wyrtensi/MailExpert').replace(/[^\w./-]/g, '');
  const api = `https://api.github.com/repos/${repo}`;
  const disabled = isDisabled(env);
  const current = currentOf(env);

  let cache = null;          // { latest, compare } of the last good check
  let checkError = null;     // 'rate_limited' | 'unavailable' | null, of the last check
  let nextCheck = 0;         // no request to GitHub before this time
  let rateLimitedUntil = 0;  // not even a forced one before this time
  let lastForced = -Infinity;
  let inflight = null;

  async function get(path) {
    const res = await fetch(`${api}${path}`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'MailExpert-update-check' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if ((res.status === 403 || res.status === 429) && res.headers.get('x-ratelimit-remaining') === '0') {
      const reset = Number(res.headers.get('x-ratelimit-reset'));
      const t = now();
      const at = Number.isFinite(reset) ? reset * 1000 : t + FAIL_BACKOFF_MS;
      throw new CheckError('rate_limited', Math.min(Math.max(at, t + FAIL_BACKOFF_MS), t + TTL_MS));
    }
    if (res.status === 404) return null;
    if (!res.ok) throw new CheckError('unavailable');
    try {
      return await res.json();
    } catch {
      throw new CheckError('unavailable');
    }
  }

  // The commit the tag `latest` names, or null when there is no such tag yet.
  async function latestCommit() {
    const ref = await get('/git/ref/tags/latest');
    if (ref === null) return null;
    let { type, sha } = ref?.object ?? {};
    if (type === 'tag' && SHA_RE.test(sha)) {
      const tag = await get(`/git/tags/${sha}`);
      ({ type, sha } = tag?.object ?? {});
    }
    if (type !== 'commit' || !SHA_RE.test(sha)) throw new CheckError('unavailable');
    return sha;
  }

  async function compareWith(latestSha) {
    if (!current.sha) return EMPTY_COMPARE;
    const range = `${current.sha}...${latestSha}`;
    const data = await get(`/compare/${range}?per_page=1`);
    // GitHub does not know the running build (a fork's or a local image): nothing to compare.
    if (data === null) return EMPTY_COMPARE;
    const aheadBy = data?.ahead_by;
    if (!COMPARE_STATUSES.has(data?.status) || !Number.isSafeInteger(aheadBy) || aheadBy < 0) {
      throw new CheckError('unavailable');
    }
    return { status: data.status, aheadBy, url: `https://github.com/${repo}/compare/${range}` };
  }

  async function refresh() {
    const start = now();
    nextCheck = start + TTL_MS; // reserve the window first
    try {
      const sha = await latestCommit();
      const latest = sha ? { version: versionOf(sha), sha, checkedAt: new Date(start).toISOString() } : null;
      const compare = sha ? await compareWith(sha) : EMPTY_COMPARE;
      cache = { latest, compare };
      checkError = null;
    } catch (err) {
      checkError = err instanceof CheckError && err.code === 'rate_limited' ? 'rate_limited' : 'unavailable';
      nextCheck = err instanceof CheckError && err.retryAt ? err.retryAt : start + FAIL_BACKOFF_MS;
      if (checkError === 'rate_limited') rateLimitedUntil = nextCheck;
    }
  }

  async function getStatus({ refresh: force = false } = {}) {
    if (disabled) {
      return { current, latest: null, compare: EMPTY_COMPARE, updateAvailable: false, disabled: true, checkError: null };
    }
    const t = now();
    let due = t >= nextCheck;
    if (!due && force && t - lastForced >= FORCE_MIN_INTERVAL_MS && t >= rateLimitedUntil) {
      lastForced = t;
      due = true;
    }
    if (due && !inflight) {
      inflight = refresh().finally(() => { inflight = null; });
    }
    if (inflight) await inflight;
    const compare = cache?.compare ?? EMPTY_COMPARE;
    return {
      current,
      latest: cache?.latest ?? null,
      compare,
      updateAvailable: compare.status === 'ahead',
      disabled: false,
      checkError,
    };
  }

  return { getStatus };
}

let defaultCheck = null;

// The process-wide check, made on first use so it reads the environment as the server runs.
export function getLatestStatus(opts) {
  defaultCheck ??= createLatestCheck();
  return defaultCheck.getStatus(opts);
}
