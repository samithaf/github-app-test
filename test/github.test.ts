/**
 * @fileoverview Tests for JWT signing and API calls against a local mock host.
 */

import {generateKeyPairSync} from 'node:crypto';
import {createServer, type Server} from 'node:http';
import {type AddressInfo} from 'node:net';
import {describe, it} from 'node:test';
import {deepEqual, ok, rejects, strictEqual} from 'node:assert/strict';

import {
  createAppJwt,
  listApiVersions,
  listInstallationRepos,
  type ApiEndpoint,
} from '../src/github.ts';

/** A mock GitHub host serving exactly the route table given in the test. */
async function startMock(handlers: Record<string, (url: URL) => unknown>): Promise<{
  baseUrl: string;
  close: () => Promise<void>;
}> {
  const server: Server = createServer((req, res) => {
    const url = new URL(String(req.url), 'http://127.0.0.1');
    const handler = handlers[url.pathname];
    if (handler === undefined) {
      res.writeHead(404, {'Content-Type': 'application/json'});
      res.end(JSON.stringify({message: 'Not Found'}));
      return;
    }
    res.writeHead(200, {'Content-Type': 'application/json'});
    res.end(JSON.stringify(handler(url)));
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

function endpoint(baseUrl: string, apiVersion = '2026-03-10'): ApiEndpoint {
  return {apiBase: baseUrl, apiVersion, timeoutMs: 5000};
}

async function rsaKey(pkcs1: boolean): Promise<string> {
  const {privateKey} = generateKeyPairSync('rsa', {modulusLength: 2048});
  return privateKey.export({type: pkcs1 ? 'pkcs1' : 'pkcs8', format: 'pem'}).toString();
}

describe('createAppJwt', () => {
  it('signs with a PKCS#8 key and sets the app id as issuer', async () => {
    const jwt = await createAppJwt(await rsaKey(false), '987');
    const payload = JSON.parse(Buffer.from(jwt.split('.')[1] ?? '', 'base64url').toString());
    strictEqual(payload.iss, '987');
    ok(payload.exp > payload.iat, 'expiry should follow issued-at');
  });

  it('also signs with a PKCS#1 key', async () => {
    const jwt = await createAppJwt(await rsaKey(true), '987');
    strictEqual(jwt.split('.').length, 3);
  });
});

describe('listApiVersions', () => {
  it('returns the versions reported by the host', async () => {
    const mock = await startMock({'/versions': () => ['2026-03-10', '2022-11-28']});
    try {
      deepEqual(await listApiVersions(endpoint(mock.baseUrl)), ['2026-03-10', '2022-11-28']);
    } finally {
      await mock.close();
    }
  });

  it('rejects a body that is not a list', async () => {
    const mock = await startMock({'/versions': () => ({message: 'not a list'})});
    try {
      await rejects(listApiVersions(endpoint(mock.baseUrl)), /did not return a list/);
    } finally {
      await mock.close();
    }
  });
});

describe('listInstallationRepos', () => {
  it('collects every page until total_count is reached', async () => {
    const repositories = Array.from({length: 130}, (_, i) => `mock-org/repo-${i + 1}`);
    const mock = await startMock({
      '/installation/repositories': (url) => {
        const page = Number(url.searchParams.get('page') ?? 1);
        const start = (page - 1) * 100;
        return {
          total_count: repositories.length,
          repositories: repositories.slice(start, start + 100).map((full_name) => ({full_name})),
        };
      },
    });
    try {
      const result = await listInstallationRepos(endpoint(mock.baseUrl), 'token');
      strictEqual(result.totalCount, 130);
      strictEqual(result.repositories.length, 130);
      strictEqual(result.repositories[129], 'mock-org/repo-130');
    } finally {
      await mock.close();
    }
  });

  it('stops after an empty first page', async () => {
    const mock = await startMock({
      '/installation/repositories': () => ({total_count: 0, repositories: []}),
    });
    try {
      const result = await listInstallationRepos(endpoint(mock.baseUrl), 'token');
      strictEqual(result.totalCount, 0);
      strictEqual(result.repositories.length, 0);
    } finally {
      await mock.close();
    }
  });
});