// A fake `api.github.com` for the fix flow, on one loopback HTTP server. It knows only the endpoints the API uses and
// answers 404 to anything else (no merge endpoint exists here, so a call to one is recorded and refused).
// The test token is a dummy; the fake never sees a real credential.
import { createServer } from 'node:http';

const SHA = /^[0-9a-f]{40}$/;
const BRANCH = /^(incident|exorcist)\/[a-z0-9]{20,32}$/;

const send = (res, status, body, headers = {}) => {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(body === undefined ? '' : JSON.stringify(body));
};

const readJson = (req, max) =>
  new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size <= max) chunks.push(c);
    });
    req.on('end', () => {
      if (size === 0) return resolve(null);
      try {
        resolve(size > max ? undefined : JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        resolve(undefined);
      }
    });
    req.on('error', () => resolve(undefined));
  });

/**
 * Starts the fake. Options:
 *  - `repo`: `owner/name` (required);
 *  - `token`: the bearer it expects (required, a dummy in tests);
 *  - `canPush`: the `permissions.push` of the repository answer (default true);
 *  - `expires`: a Date for `github-authentication-token-expiration`;
 *  - `syncRefs(refs)`: called before every read of refs, so the test can load the heads of a local bare repository;
 *  - `onDeleteRef(name)`: called when a branch is deleted.
 * State and controls: `refs`, `labels`, `pulls`, `requests`, `merge`, `closeUnmerged`, `setHead`, `rateLimit`,
 * `failNext`, `commitDates`.
 */
export async function startFakeGithub(opts) {
  const { repo, token, canPush = true, expires = null, syncRefs = null, onDeleteRef = null } = opts;
  const refs = new Map(); // branch -> sha
  const labels = new Map(); // name -> { name, color, description }
  const pulls = []; // { number, title, body, head, base, labels, state, merged, mergeSha, mergedBy, headSha, version, createdAt }
  const requests = []; // { method, path, authorized }
  const commitDates = new Map(); // sha -> ISO
  const control = { rateLimit: 0, retryAfter: 0, failNext: [] };
  const prefix = `/repos/${repo}`;

  const pullJson = (p) => ({
    number: p.number,
    html_url: `https://github.com/${repo}/pull/${p.number}`,
    state: p.state,
    title: p.title,
    merged: p.merged,
    merge_commit_sha: p.merged ? p.mergeSha : null,
    // GitHub answers `merged_by: null` when it does not say who merged.
    merged_by: p.merged && p.mergedBy !== null ? { login: p.mergedBy } : null,
    head: { ref: p.head, sha: p.headSha },
    base: { ref: p.base },
  });

  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://fake');
      const method = req.method ?? 'GET';
      const authorized = req.headers.authorization === `Bearer ${token}`;
      requests.push({ method, path: `${url.pathname}${url.search}`, authorized });
      if (control.failNext.length > 0) return send(res, control.failNext.shift(), { message: 'forced' });
      if (control.rateLimit > 0) {
        control.rateLimit--;
        return send(res, 429, { message: 'rate limited' }, control.retryAfter > 0 ? { 'retry-after': String(control.retryAfter) } : { 'x-ratelimit-remaining': '0' });
      }
      if (!authorized) return send(res, 401, { message: 'Bad credentials' });
      if (syncRefs !== null) await syncRefs(refs);
      const path = url.pathname;

      if (method === 'GET' && path === prefix) {
        const headers = expires === null ? {} : { 'github-authentication-token-expiration': expires.toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC') };
        return send(res, 200, { full_name: repo, permissions: { push: canPush, pull: true } }, headers);
      }
      let m = /^\/repos\/[^/]+\/[^/]+\/labels\/(.+)$/.exec(path);
      if (method === 'GET' && m) {
        const found = labels.get(decodeURIComponent(m[1]));
        return found === undefined ? send(res, 404, { message: 'Not Found' }) : send(res, 200, found);
      }
      if (method === 'POST' && path === `${prefix}/labels`) {
        const body = await readJson(req, 4096);
        if (typeof body?.name !== 'string' || labels.has(body.name)) return send(res, 422, { message: 'Validation Failed' });
        labels.set(body.name, { name: body.name, color: body.color, description: body.description });
        return send(res, 201, labels.get(body.name));
      }
      m = /^\/repos\/[^/]+\/[^/]+\/git\/ref\/heads\/(.+)$/.exec(path);
      if (method === 'GET' && m) return refs.has(m[1]) ? send(res, 200, { ref: `refs/heads/${m[1]}`, object: { sha: refs.get(m[1]) } }) : send(res, 404, { message: 'Not Found' });
      m = /^\/repos\/[^/]+\/[^/]+\/git\/matching-refs\/heads\/(.+)$/.exec(path);
      if (method === 'GET' && m) {
        const items = [...refs.entries()].filter(([name]) => name.startsWith(m[1])).map(([name, sha]) => ({ ref: `refs/heads/${name}`, object: { sha } }));
        const page = Number(url.searchParams.get('page') ?? 1);
        const per = Number(url.searchParams.get('per_page') ?? 30);
        return send(res, 200, items.slice((page - 1) * per, page * per));
      }
      m = /^\/repos\/[^/]+\/[^/]+\/git\/refs\/heads\/(.+)$/.exec(path);
      if (method === 'DELETE' && m) {
        if (!refs.has(m[1])) return send(res, 422, { message: 'Reference does not exist' });
        refs.delete(m[1]);
        if (onDeleteRef !== null) await onDeleteRef(m[1]);
        return send(res, 204);
      }
      m = /^\/repos\/[^/]+\/[^/]+\/commits\/([0-9a-f]{40})$/.exec(path);
      if (method === 'GET' && m) {
        const date = commitDates.get(m[1]) ?? new Date().toISOString();
        return send(res, 200, { sha: m[1], commit: { committer: { date } } });
      }
      if (method === 'POST' && path === `${prefix}/pulls`) {
        const body = await readJson(req, 128 * 1024);
        if (typeof body !== 'object' || body === null) return send(res, 422, { message: 'Validation Failed' });
        // Exactly these keys: no reviewers, no assignees, no auto-merge, no draft.
        if (Object.keys(body).sort().join(',') !== 'base,body,draft,head,maintainer_can_modify,title') return send(res, 422, { message: 'Validation Failed: keys' });
        const { title, head, base, body: text, draft, maintainer_can_modify: mcm } = body;
        const valid =
          typeof title === 'string' && title.length > 0 && title.length <= 256 && typeof text === 'string' && text.length <= 65536 && BRANCH.test(head ?? '') && BRANCH.test(base ?? '') && draft === false && mcm === false;
        if (!valid) return send(res, 422, { message: 'Validation Failed' });
        if (!refs.has(head) || !refs.has(base)) return send(res, 422, { message: 'Validation Failed: branch missing' });
        if (pulls.some((p) => p.head === head && p.state === 'open')) return send(res, 422, { message: 'A pull request already exists' });
        const pull = { number: pulls.length + 1, title, body: text, head, base, labels: [], state: 'open', merged: false, mergeSha: null, mergedBy: null, headSha: refs.get(head), version: 1 };
        pulls.push(pull);
        return send(res, 201, pullJson(pull), { etag: `W/"${pull.number}-${pull.version}"` });
      }
      m = /^\/repos\/[^/]+\/[^/]+\/issues\/(\d+)\/labels$/.exec(path);
      if (method === 'POST' && m) {
        const pull = pulls.find((p) => p.number === Number(m[1]));
        const body = await readJson(req, 4096);
        if (pull === undefined) return send(res, 404, { message: 'Not Found' });
        if (!Array.isArray(body?.labels) || !body.labels.every((l) => labels.has(l))) return send(res, 422, { message: 'Validation Failed' });
        pull.labels = [...new Set([...pull.labels, ...body.labels])];
        return send(res, 200, pull.labels.map((name) => ({ name })));
      }
      m = /^\/repos\/[^/]+\/[^/]+\/pulls\/(\d+)$/.exec(path);
      if (method === 'GET' && m) {
        const pull = pulls.find((p) => p.number === Number(m[1]));
        if (pull === undefined) return send(res, 404, { message: 'Not Found' });
        const etag = `W/"${pull.number}-${pull.version}"`;
        if (req.headers['if-none-match'] === etag) {
          res.writeHead(304, { etag });
          return res.end();
        }
        return send(res, 200, pullJson(pull), { etag });
      }
      if (method === 'GET' && path === `${prefix}/pulls`) {
        const open = pulls.filter((p) => p.state === 'open').map(pullJson);
        const page = Number(url.searchParams.get('page') ?? 1);
        const per = Number(url.searchParams.get('per_page') ?? 30);
        return send(res, 200, open.slice((page - 1) * per, page * per));
      }
      return send(res, 404, { message: 'Not Found' });
    })();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const byNumber = (n) => {
    const p = pulls.find((x) => x.number === n);
    if (p === undefined) throw new Error('unknown pull request');
    return p;
  };
  return {
    url: `http://127.0.0.1:${port}`,
    repo,
    refs,
    labels,
    pulls,
    requests,
    commitDates,
    /** A human merges the pull request on GitHub: `mergeSha` is the merge commit, `by` the login (null: GitHub names no one). */
    merge(number, { mergeSha, by = 'octocat' }) {
      if (!SHA.test(mergeSha)) throw new Error('bad merge sha');
      const p = byNumber(number);
      Object.assign(p, { state: 'closed', merged: true, mergeSha, mergedBy: by, version: p.version + 1 });
    },
    closeUnmerged(number) {
      const p = byNumber(number);
      Object.assign(p, { state: 'closed', merged: false, version: p.version + 1 });
    },
    /** Someone pushes to the head branch after the pull request was opened. */
    setHead(number, sha) {
      const p = byNumber(number);
      Object.assign(p, { headSha: sha, version: p.version + 1 });
    },
    /** The next `n` requests answer 429 (with `retry-after` seconds when given). */
    rateLimit(n, retryAfter = 0) {
      control.rateLimit = n;
      control.retryAfter = retryAfter;
    },
    failNext(...statuses) {
      control.failNext.push(...statuses);
    },
    // Cuts kept-alive and leftover connections, so a test that failed midway does not hold `close` for minutes.
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
