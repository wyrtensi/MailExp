import { describe, expect, it, vi } from 'vitest';
import { createLatestCheck, updateNotice } from './latest.js';

const CUR = 'a'.repeat(40);
const LATEST = '0123456789abcdef0123456789abcdef01234567';
const TAG_OBJ = 'f'.repeat(40);
const API = 'https://api.github.com/repos/wyrtensi/MailExpert';

const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers });

// A fake GitHub: routes keyed by the URL path after /repos/<repo>.
function github(routes) {
  return vi.fn(async (url) => {
    const path = url.startsWith(API) ? url.slice(API.length) : url;
    const route = routes[path.split('?')[0]];
    if (!route) return json({ message: 'Not Found' }, 404);
    return typeof route === 'function' ? route(url) : route;
  });
}

const commitRef = { ref: 'refs/tags/latest', object: { type: 'commit', sha: LATEST } };
const compareOf = (status, aheadBy) => json({ status, ahead_by: aheadBy, behind_by: 0, commits: [] });
const packageAt = (version) => json({
  type: 'file', encoding: 'base64', content: Buffer.from(JSON.stringify({ name: 'mailexpert-backend', version })).toString('base64'),
});

function setup({ routes, env = {}, start = 1_000_000 } = {}) {
  let t = start;
  const fetch = github(routes);
  const check = createLatestCheck({ fetch, env: { BUILD_SHA: CUR, ...env }, now: () => t, appVersion: '1.0.0' });
  return { fetch, check, advance: (ms) => { t += ms; }, at: () => t };
}

describe('latest check', () => {
  it('follows a lightweight tag and compares the running build with it', async () => {
    const { fetch, check } = setup({ routes: {
      '/git/ref/tags/latest': json(commitRef),
      [`/compare/${CUR}...${LATEST}`]: compareOf('ahead', 3),
      '/contents/backend/package.json': packageAt('1.0.1'),
    } });

    const s = await check.getStatus();

    expect(s).toEqual({
      current: { sha: CUR, version: 'sha-aaaaaaaaaaaa', release: '1.0.0' },
      latest: { version: 'sha-0123456789ab', sha: LATEST, release: '1.0.1', checkedAt: new Date(1_000_000).toISOString() },
      compare: { status: 'ahead', aheadBy: 3, url: `https://github.com/wyrtensi/MailExpert/compare/${CUR}...${LATEST}` },
      updateAvailable: true,
      disabled: false,
      checkError: null,
    });
    const [url, opts] = fetch.mock.calls[0];
    expect(url).toBe(`${API}/git/ref/tags/latest`);
    expect(opts.headers['User-Agent']).toBeTruthy();
    expect(opts.headers.Authorization).toBeUndefined();
    expect(opts.signal).toBeInstanceOf(AbortSignal);
    expect(fetch.mock.calls[1][0]).toBe(`${API}/compare/${CUR}...${LATEST}?per_page=1`);
    expect(fetch.mock.calls[2][0]).toBe(`${API}/contents/backend/package.json?ref=${LATEST}`);
  });

  it('a commit without a release version, or one GitHub cannot read, is offered by its sha alone', async () => {
    for (const contents of [json({}, 404), packageAt('3.3'), json({ encoding: 'base64', content: '!!' }), json({}, 502)]) {
      const { check } = setup({ routes: {
        '/git/ref/tags/latest': json(commitRef),
        [`/compare/${CUR}...${LATEST}`]: compareOf('ahead', 1),
        '/contents/backend/package.json': contents,
      } });
      const s = await check.getStatus();
      expect(s.latest).toMatchObject({ version: 'sha-0123456789ab', release: null });
      expect(s.checkError).toBeNull();
      expect(s.updateAvailable).toBe(true);
    }
  });

  it('reads a commit\'s release once, and again only after a failed read', async () => {
    let contents = json({}, 502);
    const { fetch, check, advance } = setup({ routes: {
      '/git/ref/tags/latest': () => json(commitRef),
      [`/compare/${CUR}...${LATEST}`]: () => compareOf('ahead', 3),
      '/contents/backend/package.json': () => contents,
    } });
    expect((await check.getStatus()).latest.release).toBeNull();
    contents = packageAt('1.0.1');
    advance(6 * 3600_000);
    expect((await check.getStatus()).latest.release).toBe('1.0.1');
    advance(6 * 3600_000);
    expect((await check.getStatus()).latest.release).toBe('1.0.1');
    expect(fetch.mock.calls.filter(([url]) => url.includes('/contents/'))).toHaveLength(2);
  });

  it('the running release is APP_VERSION when it is x.y.z', async () => {
    const fetch = github({});
    for (const [appVersion, release] of [['1.2.3', '1.2.3'], ['dev', null], ['', null]]) {
      const check = createLatestCheck({ fetch, env: { BUILD_SHA: CUR }, now: () => 0, appVersion });
      expect((await check.getStatus()).current).toEqual({ sha: CUR, version: 'sha-aaaaaaaaaaaa', release });
    }
  });

  it('updateNotice: the releases, else the shas, and the card\'s verdict', () => {
    const status = {
      current: { sha: CUR, version: 'sha-aaaaaaaaaaaa', release: '1.0.0' },
      latest: { sha: LATEST, version: 'sha-0123456789ab', release: '1.0.1' },
      compare: { status: 'ahead', aheadBy: 1, url: null }, updateAvailable: true, disabled: false, checkError: null,
    };
    expect(updateNotice(status)).toEqual({ current: '1.0.0', latest: '1.0.1', updateAvailable: true, disabled: false });
    expect(updateNotice({ ...status, latest: { ...status.latest, release: null }, updateAvailable: false }))
      .toEqual({ current: '1.0.0', latest: 'sha-0123456789ab', updateAvailable: false, disabled: false });
    expect(updateNotice({ ...status, latest: null, updateAvailable: false, disabled: true }))
      .toEqual({ current: '1.0.0', latest: null, updateAvailable: false, disabled: true });
  });

  it('dereferences an annotated tag', async () => {
    const { check } = setup({ routes: {
      '/git/ref/tags/latest': json({ object: { type: 'tag', sha: TAG_OBJ } }),
      [`/git/tags/${TAG_OBJ}`]: json({ object: { type: 'commit', sha: LATEST } }),
      [`/compare/${CUR}...${LATEST}`]: compareOf('ahead', 1),
    } });
    const s = await check.getStatus();
    expect(s.latest.sha).toBe(LATEST);
    expect(s.updateAvailable).toBe(true);
  });

  it('refuses a tag that points at another tag', async () => {
    const { check } = setup({ routes: {
      '/git/ref/tags/latest': json({ object: { type: 'tag', sha: TAG_OBJ } }),
      [`/git/tags/${TAG_OBJ}`]: json({ object: { type: 'tag', sha: LATEST } }),
    } });
    const s = await check.getStatus();
    expect(s.latest).toBeNull();
    expect(s.checkError).toBe('unavailable');
  });

  it.each([
    ['identical', 0],
    ['behind', 0],
    ['diverged', 2],
  ])('reports no update when the build is %s', async (status, aheadBy) => {
    const { check } = setup({ routes: {
      '/git/ref/tags/latest': json(commitRef),
      [`/compare/${CUR}...${LATEST}`]: compareOf(status, aheadBy),
    } });
    const s = await check.getStatus();
    expect(s.compare.status).toBe(status);
    expect(s.compare.aheadBy).toBe(aheadBy);
    expect(s.updateAvailable).toBe(false);
  });

  it('rejects malformed data from GitHub', async () => {
    const { check } = setup({ routes: {
      '/git/ref/tags/latest': json({ object: { type: 'commit', sha: 'ABC; rm -rf /' } }),
    } });
    const s = await check.getStatus();
    expect(s.latest).toBeNull();
    expect(s.checkError).toBe('unavailable');
  });

  it('rejects an unknown compare status', async () => {
    const { check } = setup({ routes: {
      '/git/ref/tags/latest': json(commitRef),
      [`/compare/${CUR}...${LATEST}`]: compareOf('sideways', 1),
    } });
    const s = await check.getStatus();
    expect(s.checkError).toBe('unavailable');
    expect(s.updateAvailable).toBe(false);
  });

  it('a dev build has no current version and is never compared', async () => {
    const { fetch, check } = setup({ env: { BUILD_SHA: 'dev' }, routes: { '/git/ref/tags/latest': json(commitRef) } });
    const s = await check.getStatus();
    expect(s.current).toEqual({ sha: null, version: null, release: '1.0.0' });
    expect(s.latest.version).toBe('sha-0123456789ab');
    expect(s.compare).toEqual({ status: null, aheadBy: null, url: null });
    expect(s.updateAvailable).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(2); // the tag and the release at it, no compare
  });

  it('a missing BUILD_SHA counts as a dev build', async () => {
    const fetch = github({ '/git/ref/tags/latest': json(commitRef) });
    const check = createLatestCheck({ fetch, env: {}, now: () => 0, appVersion: '1.0.0' });
    expect((await check.getStatus()).current).toEqual({ sha: null, version: null, release: '1.0.0' });
  });

  it('no promoted tag yet means no latest and no error', async () => {
    const { check } = setup({ routes: {} });
    const s = await check.getStatus();
    expect(s.latest).toBeNull();
    expect(s.checkError).toBeNull();
    expect(s.updateAvailable).toBe(false);
  });

  it('a build GitHub does not know (404 on compare) keeps latest with an empty compare', async () => {
    const { check } = setup({ routes: { '/git/ref/tags/latest': json(commitRef) } });
    const s = await check.getStatus();
    expect(s.latest.sha).toBe(LATEST);
    expect(s.compare).toEqual({ status: null, aheadBy: null, url: null });
    expect(s.checkError).toBeNull();
    expect(s.updateAvailable).toBe(false);
  });

  it('caches for 6 hours', async () => {
    const { fetch, check, advance } = setup({ routes: {
      '/git/ref/tags/latest': () => json(commitRef),
      [`/compare/${CUR}...${LATEST}`]: () => compareOf('ahead', 3),
    } });
    await check.getStatus();
    advance(6 * 3600_000 - 1);
    await check.getStatus();
    expect(fetch).toHaveBeenCalledTimes(3);
    advance(1);
    await check.getStatus();
    expect(fetch).toHaveBeenCalledTimes(5); // the release of the same commit is not read again
  });

  it('shares one request between concurrent callers', async () => {
    const { fetch, check } = setup({ routes: {
      '/git/ref/tags/latest': () => json(commitRef),
      [`/compare/${CUR}...${LATEST}`]: () => compareOf('ahead', 3),
    } });
    const [a, b] = await Promise.all([check.getStatus(), check.getStatus()]);
    expect(a.latest).toEqual(b.latest);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('keeps the last good result on failure and retries after 15 minutes', async () => {
    let fail = false;
    const { fetch, check, advance } = setup({ routes: {
      '/git/ref/tags/latest': () => (fail ? json({}, 502) : json(commitRef)),
      [`/compare/${CUR}...${LATEST}`]: () => compareOf('ahead', 3),
    } });
    const good = await check.getStatus();
    fail = true;
    advance(6 * 3600_000);
    const s = await check.getStatus();
    expect(s.latest).toEqual(good.latest);
    expect(s.updateAvailable).toBe(true);
    expect(s.checkError).toBe('unavailable');
    const calls = fetch.mock.calls.length;

    advance(15 * 60_000 - 1);
    await check.getStatus();
    expect(fetch.mock.calls.length).toBe(calls);
    fail = false;
    advance(1);
    const again = await check.getStatus();
    expect(fetch.mock.calls.length).toBe(calls + 2);
    expect(again.checkError).toBeNull();
  });

  it('a network error counts as unavailable', async () => {
    const fetch = vi.fn(async () => { throw new Error('ECONNRESET'); });
    const check = createLatestCheck({ fetch, env: { BUILD_SHA: CUR }, now: () => 0 });
    const s = await check.getStatus();
    expect(s.checkError).toBe('unavailable');
    expect(s.latest).toBeNull();
  });

  it.each([403, 429])('waits for the rate limit reset after a %i', async (code) => {
    const start = 1_000_000;
    const reset = Math.floor(start / 1000) + 3600; // in one hour
    let limited = true;
    const { fetch, check, advance } = setup({ start, routes: {
      '/git/ref/tags/latest': () => (limited
        ? json({ message: 'API rate limit exceeded' }, code, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) })
        : json(commitRef)),
      [`/compare/${CUR}...${LATEST}`]: () => compareOf('ahead', 3),
    } });
    const s = await check.getStatus();
    expect(s.checkError).toBe('rate_limited');
    limited = false;

    advance(30 * 60_000); // past the ordinary backoff, before the reset
    await check.getStatus();
    expect(await check.getStatus({ refresh: true })).toMatchObject({ checkError: 'rate_limited' });
    expect(fetch).toHaveBeenCalledTimes(1);

    advance(30 * 60_000);
    const ok = await check.getStatus();
    expect(ok.checkError).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it('bounds a far-off rate limit reset to the 6 hour TTL', async () => {
    const start = 1_000_000;
    const { fetch, check, advance } = setup({ start, routes: {
      '/git/ref/tags/latest': () => json({}, 403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(9_999_999_999) }),
    } });
    await check.getStatus();
    advance(6 * 3600_000);
    await check.getStatus();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('a 403 that is not a rate limit is unavailable', async () => {
    const { check } = setup({ routes: { '/git/ref/tags/latest': json({}, 403, { 'x-ratelimit-remaining': '42' }) } });
    expect((await check.getStatus()).checkError).toBe('unavailable');
  });

  it('a forced refresh skips the cache at most once per minute', async () => {
    const { fetch, check, advance } = setup({ routes: {
      '/git/ref/tags/latest': () => json(commitRef),
      [`/compare/${CUR}...${LATEST}`]: () => compareOf('ahead', 3),
    } });
    await check.getStatus();
    expect(fetch).toHaveBeenCalledTimes(3);
    await check.getStatus({ refresh: true });
    expect(fetch).toHaveBeenCalledTimes(5);
    advance(59_999);
    await check.getStatus({ refresh: true });
    expect(fetch).toHaveBeenCalledTimes(5);
    advance(1);
    await check.getStatus({ refresh: true });
    expect(fetch).toHaveBeenCalledTimes(7);
  });

  it('UPDATE_CHECK_DISABLED turns the check off', async () => {
    const { fetch, check } = setup({ env: { UPDATE_CHECK_DISABLED: 'true' }, routes: {} });
    const s = await check.getStatus({ refresh: true });
    expect(s).toEqual({
      current: { sha: CUR, version: 'sha-aaaaaaaaaaaa', release: '1.0.0' },
      latest: null,
      compare: { status: null, aheadBy: null, url: null },
      updateAvailable: false,
      disabled: true,
      checkError: null,
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('UPDATE_CHECK_REPO picks the repository', async () => {
    const fetch = vi.fn(async () => json({}, 404));
    const check = createLatestCheck({ fetch, env: { BUILD_SHA: CUR, UPDATE_CHECK_REPO: 'someone/fork' }, now: () => 0 });
    await check.getStatus();
    expect(fetch.mock.calls[0][0]).toBe('https://api.github.com/repos/someone/fork/git/ref/tags/latest');
  });
});
