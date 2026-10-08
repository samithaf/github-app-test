/**
 * @fileoverview Tests for hint selection and the end-to-end CLI flow.
 */

import {generateKeyPairSync} from 'node:crypto';
import {createServer, type Server} from 'node:http';
import {type AddressInfo} from 'node:net';
import {afterEach, describe, it} from 'node:test';
import {ok, strictEqual} from 'node:assert/strict';

import {ConfigError} from '../src/config.ts';
import {GitHubApiError} from '../src/github.ts';
import {appHint, finish, hintFor, main, versionsHint} from '../src/index.ts';
import type {Config} from '../src/config.ts';
import type {CheckResult} from '../src/index.ts';

const CONFIG: Config = {
  host: 'github.acme.com',
  apiBase: 'https://github.acme.com/api/v3',
  apiVersion: '2026-03-10',
  appId: '1',
  privateKeyPem: 'unused',
  timeoutMs: 1000,
};

/** A GitHubApiError carrying the status but a distinct message, for clarity. */
function apiError(status: number): GitHubApiError {
  return new GitHubApiError(status, 'some message');
}

describe('hintFor', () => {
  it('explains 401 as a rejected JWT', () => {
    ok(hintFor(apiError(401), CONFIG).includes('JWT was rejected'));
  });

  it('explains 404 and mentions both GHES mounts', () => {
    const hint = hintFor(apiError(404), CONFIG);
    ok(hint.includes('GITHUB_HOST'));
    ok(hint.includes('/api/v3'));
  });

  it('recognises configuration problems', () => {
    strictEqual(
      hintFor(new ConfigError('x'), CONFIG),
      'configuration problem - see .env.example',
    );
  });

  it('matches step-specific 404 hints before the generic one', () => {
    ok(appHint(apiError(404), CONFIG).includes('not a recognised pair'));
    ok(versionsHint(apiError(404), CONFIG).includes('does not expose GET /versions'));
  });
});

describe('finish', () => {
  function captureLog(fn: () => void): string[] {
    const logs: string[] = [];
    const original = console.log;
    console.log = (line: unknown) => logs.push(String(line));
    try {
      fn();
    } finally {
      console.log = original;
    }
    return logs;
  }

  it('returns 0 when nothing failed', () => {
    const code = finish(CONFIG, [], false, false);
    strictEqual(code, 0);
  });

  it('returns 1 when a step failed', () => {
    const code = finish(CONFIG, [], true, false);
    strictEqual(code, 1);
  });

  it('counts warnings in the human summary', () => {
    const results: CheckResult[] = [
      {name: 'versions', status: 'warn', detail: 'x'},
      {name: 'app', status: 'ok', detail: 'y'},
    ];
    const logs = captureLog(() => finish(CONFIG, results, false, false));
    ok(logs.join('\n').includes('all checks passed, 1 warning'));
  });

  it('emits machine-readable JSON with --json', () => {
    const logs = captureLog(() => finish(CONFIG, [], false, true));
    const parsed = JSON.parse(logs.join('\n'));
    strictEqual(parsed.ok, true);
    strictEqual(parsed.host, 'github.acme.com');
  });
});

async function startFullMock(): Promise<{baseUrl: string; close: () => Promise<void>}> {
  const routes: Record<string, (url: URL) => unknown> = {
    '/versions': () => ['2026-03-10', '2022-11-28'],
    '/app': () => ({id: 123, name: 'mock-app', slug: 'mock-app', owner: {login: 'mock-org'}}),
    '/app/installations': () => ({
      installations: [
        {id: 1, account: {login: 'mock-org'}, repository_selection: 'all', permissions: {contents: 'read'}},
      ],
    }),
    '/installation/repositories': () => ({
      total_count: 1,
      repositories: [{full_name: 'mock-org/repo-001'}],
    }),
  };
  const server: Server = createServer((req, res) => {
    const path = new URL(String(req.url), 'http://127.0.0.1').pathname.replace(/^\/api\/v3/, '');
    const handler = path === '/app/installations/1/access_tokens'
      ? () => ({
          token: 'mock-token',
          expires_at: '2030-01-01T00:00:00Z',
          permissions: {contents: 'read'},
          repository_selection: 'all',
        })
      : routes[path];
    if (handler === undefined) {
      res.writeHead(404, {'Content-Type': 'application/json'});
      res.end(JSON.stringify({message: 'Not Found'}));
      return;
    }
    res.writeHead(200, {'Content-Type': 'application/json'});
    res.end(JSON.stringify(handler(new URL(String(req.url), 'http://127.0.0.1'))));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const {port} = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

describe('main end to end', () => {
  let mock: Awaited<ReturnType<typeof startFullMock>> | undefined;
  const savedEnv = {...process.env};

  afterEach(async () => {
    process.env = savedEnv;
    if (mock) {
      await mock.close();
      mock = undefined;
    }
  });

  it('passes every step and reports JSON', async () => {
    mock = await startFullMock();
    const {privateKey} = generateKeyPairSync('rsa', {modulusLength: 2048});
    process.env = {
      ...savedEnv,
      GITHUB_APP_ID: '123',
      GITHUB_HOST: mock.baseUrl,
      GITHUB_APP_PRIVATE_KEY: privateKey.export({type: 'pkcs8', format: 'pem'}).toString(),
    };

    const logs: string[] = [];
    const original = console.log;
    console.log = (line: unknown) => logs.push(String(line));
    let code: number;
    try {
      code = await main(['node', 'src/index.ts', '--json']);
    } finally {
      console.log = original;
    }

    strictEqual(code, 0);
    const report = JSON.parse(logs.join('\n'));
    strictEqual(report.ok, true);
    const statuses = (report.checks as Array<{status: string}>).map((check) => check.status);
    ok(statuses.every((status) => status === 'ok'), `expected all ok, got ${statuses.join(',')}`);
  });
});