/**
 * @fileoverview Checks a GitHub App credential set one step at a time.
 */

import {pathToFileURL} from 'node:url';

import {ConfigError, loadConfig, type Config} from './config.ts';
import {errorMessage} from './errors.ts';
import {
  GitHubApiError,
  JWT_TTL_SECONDS,
  accountName,
  apiRequest,
  createAppJwt,
  listApiVersions,
  listInstallationRepos,
  type AppInfo,
  type Installation,
  type InstallationToken,
} from './github.ts';

type Status = 'ok' | 'fail' | 'warn' | 'skip';

/** Produces a hint for a failed check. */
export type HintFn = (error: unknown, config: Config) => string;

/** Options controlling how a step is run and reported. */
interface StepOptions {
  hint?: HintFn;
  required?: boolean;
}

/** The outcome recorded for a single check. */
export interface CheckResult {
  name: string;
  status: Status;
  detail: string;
  lines?: string[];
}

/** What a check reports: a printable summary plus the value to keep. */
interface StepOutput<T> {
  detail: string;
  value: T;
  lines?: string[];
}

/** A check that ran and produced a value. */
interface StepSuccess<T> {
  ok: true;
  value: T;
}

/** A check that failed or was skipped. */
interface StepFailure {
  ok: false;
}

type StepResult<T> = StepSuccess<T> | StepFailure;

/** Formats a caught value, including HTTP details for API failures. */
function describe(error: unknown): string {
  if (error instanceof GitHubApiError && error.status > 0) {
    const docs = error.documentationUrl === undefined ? '' : ` (${error.documentationUrl})`;
    return `HTTP ${error.status}: ${error.message}${docs}`;
  }
  return errorMessage(error);
}

/** Formats a permissions map as `name=value` pairs. */
export function formatPermissions(permissions: Record<string, string>): string {
  const pairs = Object.entries(permissions).map(([key, value]) => `${key}=${value}`);
  return pairs.length > 0 ? pairs.join(', ') : '(none)';
}

/** Describes an installation, including its granted permissions. */
export function describeInstallation(entry: Installation): string {
  return (
    `installation ${entry.id} on ${accountName(entry.account)}, ` +
    `selection=${entry.repository_selection}, perms: ${formatPermissions(entry.permissions)}`
  );
}

/** Explains how to fix a failed check. */
export function hintFor(error: unknown, config: Config): string {
  if (error instanceof GitHubApiError) {
    switch (error.status) {
      case 0:
        return `network problem reaching ${config.apiBase} - check GITHUB_HOST, DNS, VPN and TLS`;
      case 400:
        return `bad request - ${error.message}. On GHES an unsupported GITHUB_API_VERSION is a common cause; run with --json or check GET /versions`;
      case 401:
        return `the JWT was rejected - check the clock skew (iat must not be in the future) and that the .pem is a valid PKCS#8/RSA private key`;
      case 403:
        return `forbidden - ${error.message}. Check the app's permissions and whether SAML SSO requires this app to be authorized`;
      case 404:
        return `not found on ${config.host} - wrong id, or the app is not installed here. For GHES check GITHUB_HOST and the /api/v3 mount point; GHE.com data-residency hosts answer on api.<host>`;
      case 410:
        return `the app was deleted, or GITHUB_API_VERSION=${config.apiVersion} is no longer supported - check GET /versions for the supported set`;
      default:
        return `unexpected HTTP ${error.status}`;
    }
  }
  if (error instanceof ConfigError) {
    return 'configuration problem - see .env.example';
  }
  return errorMessage(error);
}

/** Hints for failures while signing the app JWT. */
export function jwtHint(): string {
  return `the private key could not be parsed as a PKCS#8/RSA PEM - include the full -----BEGIN/END----- block, un-escape any \\n, and check the file was not truncated`;
}

/** Hints for failures while authenticating as the app. */
export function appHint(error: unknown, config: Config): string {
  if (error instanceof GitHubApiError && error.status === 404) {
    return `GITHUB_APP_ID and the private key are not a recognised pair - confirm the app id and that this .pem is the key GitHub generated for this exact app (regenerate the key if unsure)`;
  }
  return hintFor(error, config);
}

/** Hints for the optional `GET /versions` check. */
export function versionsHint(error: unknown, config: Config): string {
  if (error instanceof GitHubApiError && error.status === 404) {
    return `this host does not expose GET /versions (normal on some GHES versions) - check the GHES release notes for which REST API versions it supports`;
  }
  return hintFor(error, config);
}

/**
 * Runs every check, returning the process exit code.
 *
 * `argv` holds the process arguments including the program name, so the module
 * stays importable (the `--json` flag is read here, not at module load).
 */
export async function main(argv: string[]): Promise<number> {
  const jsonOutput = argv.includes('--json');
  const print = (line: string): void => {
    if (jsonOutput) return;
    console.log(line);
  };

  let config: Config;
  try {
    config = loadConfig();
  } catch (error) {
    console.error(`config error: ${errorMessage(error)}`);
    console.error('see .env.example for the expected variables');
    return 2;
  }

  const results: CheckResult[] = [];
  let failed = false;

  async function step<T>(
    name: string,
    fn: () => Promise<StepOutput<T>>,
    options: StepOptions = {},
  ): Promise<StepResult<T>> {
    const {hint = hintFor, required = true} = options;
    if (failed) {
      results.push({name, status: 'skip', detail: 'skipped because a previous step failed'});
      print(`  -   ${name} (skipped)`);
      return {ok: false};
    }
    try {
      const {detail, value, lines} = await fn();
      results.push({name, status: 'ok', detail, lines});
      print(`  ok  ${name}`);
      print(`        ${detail}`);
      for (const line of lines ?? []) {
        print(`        ${line}`);
      }
      return {ok: true, value};
    } catch (error) {
      if (required) {
        failed = true;
      }
      const detail = describe(error);
      results.push({name, status: required ? 'fail' : 'warn', detail});
      print(`  ${required ? 'FAIL' : 'warn'} ${name}`);
      print(`        ${detail}`);
      print(`        hint: ${hint(error, config)}`);
      return {ok: false};
    }
  }

  print('GitHub App credential check');
  print(`  host          ${config.host}`);
  print(`  api           ${config.apiBase}`);
  print(`  api version   ${config.apiVersion}`);
  print(`  app id        ${config.appId}`);
  print(`  installation  ${config.installationId ?? '(auto-detect)'}`);
  print('');

  const jwt = await step(
    'create app JWT (validates private key)',
    async () => {
      const token = await createAppJwt(config.privateKeyPem, config.appId);
      return {detail: `RS256 JWT minted, iss=${config.appId}, ttl=${JWT_TTL_SECONDS / 60}m`, value: token};
    },
    {hint: jwtHint},
  );
  if (!jwt.ok) {
    return finish(config, results, failed, jsonOutput);
  }

  await step(
    'check supported API versions (GET /versions)',
    async () => {
      const versions = await listApiVersions(config);
      if (!versions.includes(config.apiVersion)) {
        throw new Error(
          `GITHUB_API_VERSION=${config.apiVersion} is not supported by this host ` +
            `(supported: ${versions.join(', ') || 'none reported'})`,
        );
      }
      return {
        detail: `host supports: ${versions.join(', ') || '(none reported)'}`,
        value: versions,
      };
    },
    {required: false, hint: versionsHint},
  );

  const app = await step(
    'authenticate app (GET /app)',
    async () => {
      const {data} = await apiRequest<AppInfo>(config, '/app', {
        token: jwt.value,
      });
      return {
        detail: `name=${data.name} slug=${data.slug} owner=${accountName(data.owner)} id=${data.id}`,
        value: data.id,
      };
    },
    {hint: appHint},
  );
  if (!app.ok) {
    return finish(config, results, failed, jsonOutput);
  }

  const installation = await step('resolve installation', async () => {
    if (config.installationId) {
      const {data} = await apiRequest<Installation>(
        config,
        `/app/installations/${config.installationId}`,
        {token: jwt.value},
      );
      return {
        detail: `${describeInstallation(data)} (from GITHUB_INSTALLATION_ID)`,
        value: data.id,
      };
    }
    const {data} = await apiRequest<{installations: Installation[]}>(
      config,
      '/app/installations?per_page=100',
      {token: jwt.value},
    );
    const installations = data.installations ?? [];
    const [chosen, ...remaining] = installations;
    if (chosen === undefined) {
      throw new GitHubApiError(404, 'the app has no installations on this host');
    }
    const others = remaining.map((entry) => `${entry.id}@${accountName(entry.account)}`);
    const suffix = others.length > 0 ? ` (other installations: ${others.join(', ')})` : '';
    return {
      detail: `${describeInstallation(chosen)}${suffix} - set GITHUB_INSTALLATION_ID to pick another`,
      value: chosen.id,
    };
  });
  if (!installation.ok) {
    return finish(config, results, failed, jsonOutput);
  }

  const token = await step('mint installation token', async () => {
    const {data} = await apiRequest<InstallationToken>(
      config,
      `/app/installations/${installation.value}/access_tokens`,
      {token: jwt.value, method: 'POST'},
    );
    return {
      detail: `token expires ${data.expires_at}, selection=${data.repository_selection}, perms: ${formatPermissions(data.permissions)}`,
      value: data.token,
    };
  });
  if (!token.ok) {
    return finish(config, results, failed, jsonOutput);
  }

  await step('use installation token (GET /installation/repositories)', async () => {
    const {repositories, totalCount} = await listInstallationRepos(config, token.value);
    const listed = repositories.length !== totalCount ? ` (${repositories.length} listed)` : '';
    return {
      detail: `${totalCount} repositories visible${listed}`,
      lines: repositories,
      value: repositories.length,
    };
  });

  return finish(config, results, failed, jsonOutput);
}

/** Prints the final summary and returns the process exit code. */
export function finish(
  config: Config,
  results: CheckResult[],
  failed: boolean,
  jsonOutput: boolean,
): number {
  const ok = !failed;
  const warnings = results.filter((result) => result.status === 'warn').length;
  if (jsonOutput) {
    console.log(
      JSON.stringify(
        {
          ok,
          host: config.host,
          apiVersion: config.apiVersion,
          appId: config.appId,
          installationId: config.installationId ?? null,
          checks: results,
        },
        null,
        2,
      ),
    );
  } else {
    const summary = ok
      ? warnings > 0
        ? `all checks passed, ${warnings} warning${warnings === 1 ? '' : 's'}`
        : 'all checks passed'
      : 'one or more checks failed';
    console.log('');
    console.log(summary);
  }
  return ok ? 0 : 1;
}

const isEntryPoint =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntryPoint) {
  process.exitCode = await main(process.argv);
}