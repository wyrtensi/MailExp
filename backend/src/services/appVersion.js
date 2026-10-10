// The MailExpert version this backend is: x.y.z shared by every shipped package
// (scripts/ci/release-version.sh). APP_VERSION in the environment wins, then build-meta.json the
// image build writes, then package.json. A leading "v" is dropped.
import { readFileSync } from 'fs';

const RELEASE_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

// isRelease <v>: whether <v> is a plain x.y.z version.
export const isRelease = (v) => typeof v === 'string' && RELEASE_RE.test(v);

function readJson(url) {
  try {
    return JSON.parse(readFileSync(url, 'utf-8'));
  } catch {
    // Local dev runs may not have build metadata yet.
    return {};
  }
}

export function appVersionOf({ env = process.env, buildMeta = {}, packageMeta = {} } = {}) {
  return String(env.APP_VERSION || buildMeta.version || packageMeta.version || '0.0.0').replace(/^v[.]?/, '');
}

export const APP_VERSION = appVersionOf({
  buildMeta: readJson(new URL('../../build-meta.json', import.meta.url)),
  packageMeta: readJson(new URL('../../package.json', import.meta.url)),
});
