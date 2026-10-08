/**
 * @fileoverview Tests for environment parsing and key-path handling.
 */

import { ok, strictEqual, throws } from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  type Config,
  ConfigError,
  expandTilde,
  loadConfig,
} from '../src/config.ts';
import { DEFAULT_API_VERSION } from '../src/github.ts';

const VALID_PEM = '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----';

function baseEnv(): NodeJS.ProcessEnv {
  return {
    GITHUB_APP_ID: '123',
    GITHUB_APP_PRIVATE_KEY: VALID_PEM,
  };
}

function assertApiBase(env: NodeJS.ProcessEnv, expected: string): void {
  const config: Config = loadConfig({ ...baseEnv(), ...env });
  strictEqual(config.apiBase, expected);
}

describe('loadConfig', () => {
  it('defaults to api.github.com and the latest API version', () => {
    const config = loadConfig(baseEnv());
    strictEqual(config.host, 'github.com');
    strictEqual(config.apiBase, 'https://api.github.com');
    strictEqual(config.apiVersion, DEFAULT_API_VERSION);
  });

  it('maps a GHES host to the /api/v3 prefix', () => {
    assertApiBase(
      { GITHUB_HOST: 'github.acme.com' },
      'https://github.acme.com/api/v3',
    );
  });

  it('maps a GHE.com data-residency host to an api. subdomain without /api/v3', () => {
    assertApiBase(
      { GITHUB_HOST: 'octocorp.ghe.com' },
      'https://api.octocorp.ghe.com',
    );
  });

  it('honours an explicit http:// scheme for local hosts', () => {
    assertApiBase(
      { GITHUB_HOST: 'http://127.0.0.1:4199' },
      'http://127.0.0.1:4199/api/v3',
    );
  });

  it('rejects a host that already contains a path', () => {
    throws(
      () => loadConfig({ ...baseEnv(), GITHUB_HOST: 'github.acme.com/api/v3' }),
      ConfigError,
    );
  });

  it('rejects a malformed GITHUB_API_VERSION', () => {
    throws(
      () => loadConfig({ ...baseEnv(), GITHUB_API_VERSION: 'nonsense' }),
      ConfigError,
    );
  });

  it('accepts a GITHUB_API_VERSION override in date form', () => {
    const config = loadConfig({
      ...baseEnv(),
      GITHUB_API_VERSION: '2022-11-28',
    });
    strictEqual(config.apiVersion, '2022-11-28');
  });

  it('rejects a missing GITHUB_APP_ID', () => {
    throws(
      () => loadConfig({ GITHUB_APP_PRIVATE_KEY: VALID_PEM }),
      ConfigError,
    );
  });

  it('rejects a non-positive or non-numeric GITHUB_TIMEOUT_MS', () => {
    throws(
      () => loadConfig({ ...baseEnv(), GITHUB_TIMEOUT_MS: '0' }),
      ConfigError,
    );
    throws(
      () => loadConfig({ ...baseEnv(), GITHUB_TIMEOUT_MS: 'abc' }),
      ConfigError,
    );
  });
});

describe('expandTilde', () => {
  it('resolves ~ alone to the home directory', () => {
    strictEqual(expandTilde('~'), homedir());
  });

  it('resolves a leading ~/ to a path inside the home directory', () => {
    const expanded = expandTilde('~/key.pem');
    strictEqual(expanded, join(homedir(), 'key.pem'));
  });

  it('rejects other-user ~name forms', () => {
    throws(() => expandTilde('~someone/key.pem'), ConfigError);
  });

  it('leaves ordinary paths untouched', () => {
    strictEqual(expandTilde('/etc/key.pem'), '/etc/key.pem');
  });
});

describe('private key loading', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'github-app-test-'));
  });

  afterEach(() => {
    // Files live in the OS temp directory and need no cleanup here.
    void dir;
  });

  it('reads a key from an absolute path', () => {
    const file = join(dir, 'key.pem');
    writeFileSync(file, VALID_PEM);
    const config = loadConfig({
      GITHUB_APP_ID: '123',
      GITHUB_APP_PRIVATE_KEY: file,
    });
    ok(config.privateKeyPem.includes('BEGIN PRIVATE KEY'));
  });

  it('accepts an inline PEM block', () => {
    const config = loadConfig(baseEnv());
    strictEqual(config.privateKeyPem, VALID_PEM);
  });

  it('reports the attempted path when the key file is missing', () => {
    const missing = join(dir, 'nope.pem');
    throws(
      () =>
        loadConfig({ GITHUB_APP_ID: '123', GITHUB_APP_PRIVATE_KEY: missing }),
      (error: unknown) =>
        error instanceof ConfigError && error.message.includes(missing),
    );
  });
});
