/**
 * @fileoverview Reads GitHub App credentials from the environment.
 */

import {readFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {resolve} from 'node:path';

import {errorMessage, systemErrorCode} from './errors.ts';
import {DEFAULT_API_VERSION} from './github.ts';

/** Credentials and endpoint settings shared by every check. */
export interface Config {
  host: string;
  apiBase: string;
  apiVersion: string;
  appId: string;
  privateKeyPem: string;
  installationId?: string;
  timeoutMs: number;
}

/** Reports a credential problem found before any request is sent. */
export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) {
    throw new ConfigError(`missing required env var ${name}`);
  }
  return value;
}

function normalizePrivateKey(raw: string): string {
  if (raw.includes('-----BEGIN')) {
    return raw.includes('\\n') ? raw.replace(/\\n/g, '\n') : raw;
  }
  const path = raw.startsWith('~') ? resolve(homedir(), raw.slice(1)) : resolve(raw);
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    const reason = systemErrorCode(error) === 'ENOENT' ? 'no such file' : errorMessage(error);
    throw new ConfigError(
      `GITHUB_APP_PRIVATE_KEY is neither a readable file path nor a PEM block ` +
        `(tried ${path}: ${reason})`,
    );
  }
}

/**
 * Builds the configuration from the environment, or throws `ConfigError`.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const rawHost = (env.GITHUB_HOST?.trim() || 'github.com').replace(/\/+$/, '');
  const scheme = rawHost.startsWith('http://') ? 'http' : 'https';
  const host = rawHost.replace(/^https?:\/\//, '');
  const installationId = env.GITHUB_INSTALLATION_ID?.trim();
  const apiVersion = env.GITHUB_API_VERSION?.trim() || DEFAULT_API_VERSION;

  if (!/^\d{4}-\d{2}-\d{2}$/.test(apiVersion)) {
    throw new ConfigError(
      `GITHUB_API_VERSION must be a date such as ${DEFAULT_API_VERSION} (got ${apiVersion})`,
    );
  }

  const config: Config = {
    host,
    apiBase: host === 'github.com' ? 'https://api.github.com' : `${scheme}://${host}/api/v3`,
    apiVersion,
    appId: required(env, 'GITHUB_APP_ID'),
    privateKeyPem: normalizePrivateKey(required(env, 'GITHUB_APP_PRIVATE_KEY')),
    timeoutMs: Number(env.GITHUB_TIMEOUT_MS?.trim() || 15000),
    ...(installationId ? {installationId} : {}),
  };

  if (!Number.isFinite(config.timeoutMs) || config.timeoutMs <= 0) {
    throw new ConfigError('GITHUB_TIMEOUT_MS must be a positive number');
  }

  return config;
}
