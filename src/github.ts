/**
 * @fileoverview Minimal GitHub REST client for authenticating as a GitHub App.
 */

import {createPrivateKey} from 'node:crypto';

import {SignJWT, importPKCS8} from 'jose';

import {errorMessage, systemErrorCode} from './errors.ts';

/** The newest REST API version published by GitHub. */
export const DEFAULT_API_VERSION = '2026-03-10';

/** Endpoint details shared by every request. */
export interface ApiEndpoint {
  apiBase: string;
  apiVersion: string;
  timeoutMs: number;
}

/** A request to the GitHub API that did not return a successful status. */
export class GitHubApiError extends Error {
  override readonly name = 'GitHubApiError';
  readonly status: number;
  readonly documentationUrl?: string;

  // Parameter properties are avoided here: Node's TypeScript type stripping
  // does not support them.
  constructor(status: number, message: string, documentationUrl?: string) {
    super(message);
    this.status = status;
    this.documentationUrl = documentationUrl;
  }
}

/** The authenticated app as returned by `GET /app`. */
export interface AppInfo {
  id: number;
  name: string;
  slug: string;
  owner: {login: string};
}

/**
 * An installation as returned by `GET /app/installations`.
 *
 * Field names follow GitHub's JSON payload instead of lowerCamelCase so the
 * response can be read without a mapping layer.
 */
export interface Installation {
  id: number;
  account: {login: string};
  repository_selection: string;
  permissions: Record<string, string>;
}

/**
 * An installation access token as returned by
 * `POST /app/installations/{id}/access_tokens`.
 *
 * Field names follow GitHub's JSON payload instead of lowerCamelCase so the
 * response can be read without a mapping layer.
 */
export interface InstallationToken {
  token: string;
  expires_at: string;
  permissions: Record<string, string>;
  repository_selection: string;
}

/** One page of `GET /installation/repos`. */
interface InstallationRepos {
  total_count: number;
  repositories: Array<{full_name: string}>;
}

/** The decoded body of a successful API call. */
interface ApiResponse<T> {
  data: T;
  headers: Headers;
}

/** Every repository reachable by an installation. */
interface RepositoryList {
  repositories: string[];
  totalCount: number;
}

/** Options accepted by `apiRequest`. */
interface RequestOptions {
  token?: string;
  method?: 'GET' | 'POST';
  body?: unknown;
}

/**
 * Signs an RS256 JWT that authenticates as the app identified by `appId`.
 *
 * Both PKCS#8 and PKCS#1 PEM blocks are accepted.
 */
export async function createAppJwt(
  privateKeyPem: string,
  appId: string,
  ttlSeconds = 540,
): Promise<string> {
  const normalized = createPrivateKey(privateKeyPem.trim())
    .export({type: 'pkcs8', format: 'pem'})
    .toString();
  const key = await importPKCS8(normalized, 'RS256');
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({})
    .setProtectedHeader({alg: 'RS256', typ: 'JWT'})
    .setIssuedAt(now - 60)
    .setExpirationTime(now + ttlSeconds)
    .setIssuer(appId)
    .sign(key);
}

/**
 * Reads `message` from a GitHub error body, falling back to `fallback`.
 *
 * The payload comes from `JSON.parse`, so only the fields this tool prints are
 * narrowed and the rest is left untouched.
 */
function apiErrorMessage(payload: unknown, fallback: string): string {
  if (typeof payload !== 'object' || payload === null) {
    return fallback;
  }
  if ('message' in payload && typeof payload.message === 'string') {
    return payload.message;
  }
  return fallback;
}

/** Reads `documentation_url` from a GitHub error body, when present. */
function apiDocumentationUrl(payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null) {
    return undefined;
  }
  if ('documentation_url' in payload && typeof payload.documentation_url === 'string') {
    return payload.documentation_url;
  }
  return undefined;
}

/**
 * Sends a request to the GitHub API and decodes its JSON body.
 *
 * The `X-GitHub-Api-Version` header is taken from `endpoint.apiVersion`.
 */
export async function apiRequest<T>(
  endpoint: ApiEndpoint,
  path: string,
  {token, method = 'GET', body}: RequestOptions = {},
): Promise<ApiResponse<T>> {
  const headers: Record<string, string> = {
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': endpoint.apiVersion,
    ...(token === undefined ? {} : {'Authorization': `Bearer ${token}`}),
    ...(body === undefined ? {} : {'Content-Type': 'application/json'}),
  };

  let response: Response;
  try {
    response = await fetch(`${endpoint.apiBase}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(endpoint.timeoutMs),
    });
  } catch (error) {
    const cause = error instanceof Error && error.cause instanceof Error ? error.cause : undefined;
    const detail = errorMessage(cause ?? error);
    const code = systemErrorCode(cause) ?? systemErrorCode(error);
    throw new GitHubApiError(0, `request to ${path} failed: ${detail}${code ? ` (${code})` : ''}`);
  }

  const text = await response.text();
  let parsed: unknown = undefined;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }

  if (!response.ok) {
    throw new GitHubApiError(
      response.status,
      apiErrorMessage(parsed, text || response.statusText),
      apiDocumentationUrl(parsed),
    );
  }

  // The endpoint contract is expressed by the caller's type argument; the body
  // itself is unvalidated JSON, so no runtime check can confirm it beyond the
  // status code check above.
  return {data: parsed as T, headers: response.headers};
}

/**
 * Lists the API versions supported by the host, from `GET /versions`.
 *
 * The request is sent without credentials: the endpoint is public on
 * github.com, and an unauthenticated call still reports the versions a host
 * offers when the app credentials are wrong.
 */
export async function listApiVersions(endpoint: ApiEndpoint): Promise<string[]> {
  const {data} = await apiRequest<unknown>(endpoint, '/versions');
  if (!Array.isArray(data)) {
    throw new Error('GET /versions did not return a list of API versions');
  }
  return data.filter((entry): entry is string => typeof entry === 'string');
}

/**
 * Lists every repository an installation can access, following pagination.
 */
export async function listInstallationRepos(
  endpoint: ApiEndpoint,
  token: string,
): Promise<RepositoryList> {
  const repositories: string[] = [];
  let totalCount = 0;
  for (let page = 1; page <= 1000; page += 1) {
    const {data} = await apiRequest<InstallationRepos>(
      endpoint,
      `/installation/repos?per_page=100&page=${page}`,
      {token},
    );
    totalCount = data.total_count;
    repositories.push(...data.repositories.map((repository) => repository.full_name));
    if (data.repositories.length < 100 || repositories.length >= totalCount) {
      break;
    }
  }
  return {repositories, totalCount};
}
