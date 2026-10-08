/**
 * @fileoverview Minimal GitHub REST client for authenticating as a GitHub App.
 */

import {createPrivateKey} from 'node:crypto';

import {SignJWT} from 'jose';

import {errorMessage, systemErrorCode} from './errors.ts';

/** The newest REST API version published by GitHub. */
export const DEFAULT_API_VERSION = '2026-03-10';

/** Lifetime of the app JWT in seconds (GitHub's maximum is 10 minutes). */
export const JWT_TTL_SECONDS = 540;

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
  owner: AccountRef | null;
}

/**
 * A GitHub account or enterprise.
 *
 * Ordinary accounts expose `login`; enterprise-owned apps expose the owner as
 * an enterprise object that only has `slug`.
 */
export interface AccountRef {
  login?: string;
  slug?: string;
}

/** The display name of an account, preferring `login` over the enterprise `slug`. */
export function accountName(account: AccountRef | null | undefined): string {
  return account?.login ?? account?.slug ?? '(unknown)';
}

/**
 * An installation as returned by `GET /app/installations`.
 *
 * Field names follow GitHub's JSON payload instead of lowerCamelCase so the
 * response can be read without a mapping layer.
 */
export interface Installation {
  id: number;
  account: AccountRef;
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

/** One page of `GET /installation/repositories`. */
interface InstallationRepos {
  total_count: number;
  repositories: Array<{full_name: string}>;
}

/** The decoded body of a successful API call. */
interface ApiResponse<T> {
  data: T;
}

/** Safety cap so a malfunctioning server cannot page forever. */
const MAX_PAGINATION_PAGES = 1000;

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
 * Both PKCS#8 and PKCS#1 PEM blocks are accepted, and jose signs the node
 * `KeyObject` produced by `createPrivateKey` directly.
 */
export async function createAppJwt(
  privateKeyPem: string,
  appId: string,
  ttlSeconds = JWT_TTL_SECONDS,
): Promise<string> {
  const key = createPrivateKey(privateKeyPem.trim());
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
  return {data: parsed as T};
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
 *
 * Paging continues until `total_count` is collected and fails loudly if a
 * server stops advancing past `MAX_PAGINATION_PAGES` pages.
 */
export async function listInstallationRepos(
  endpoint: ApiEndpoint,
  token: string,
): Promise<RepositoryList> {
  const repositories: string[] = [];
  let totalCount = 0;
  let page = 1;
  for (;;) {
    const {data} = await apiRequest<InstallationRepos>(
      endpoint,
      `/installation/repositories?per_page=100&page=${page}`,
      {token},
    );
    totalCount = data.total_count;
    repositories.push(...data.repositories.map((repository) => repository.full_name));
    if (repositories.length >= totalCount) {
      break;
    }
    page += 1;
    if (page > MAX_PAGINATION_PAGES) {
      throw new Error(
        `pagination did not finish after ${MAX_PAGINATION_PAGES} pages ` +
          `(expected ${totalCount} repositories, got ${repositories.length})`,
      );
    }
  }
  return {repositories, totalCount};
}
