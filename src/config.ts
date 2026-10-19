import { readFileSync, statSync } from 'node:fs';
import { isIP } from 'node:net';
import path from 'node:path';
import { z } from 'zod';

const modeSchema = z.enum(['local-full', 'http-demo']);
const logLevelSchema = z.enum(['silent', 'error', 'warn', 'info', 'debug']);

// Select only application-owned keys: process.env normally contains unrelated values.
const environmentSchema = z.strictObject({
  SECUREOPS_MODE: modeSchema.default('local-full'),
  SECUREOPS_DB_PATH: z.string().optional(),
  SECUREOPS_LOG_LEVEL: logLevelSchema.default('info'),
  SECUREOPS_HTTP_HOST: z.string().default('127.0.0.1'),
  SECUREOPS_HTTP_PORT: z
    .string()
    .regex(/^[1-9]\d{0,4}$/)
    .transform(Number)
    .pipe(z.int().min(1).max(65535))
    .default(3000),
  SECUREOPS_HTTP_ALLOW_PUBLIC_BIND: z.enum(['true', 'false']).default('false'),
  SECUREOPS_HTTP_ALLOWED_ORIGINS: z.string().optional(),
  SECUREOPS_HTTP_AUTH_TOKEN: z.string().optional(),
  SECUREOPS_HTTP_AUTH_TOKEN_FILE: z.string().optional(),
});

const defaultDatabasePath = path.join('data', 'secureops.db');
const databaseExtensions = new Set(['.db', '.sqlite', '.sqlite3']);
const bearerTokenPattern = /^[A-Za-z0-9._~-]{32,512}$/;
// eslint-disable-next-line no-control-regex -- Reject control characters in untrusted text.
const invalidPathComponent = /[<>:"|?*\\\x00-\x1f]/;
const reservedWindowsDevice = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

export type LogLevel = z.infer<typeof logLevelSchema>;

/** Read only the validated diagnostic setting; command handlers still validate full config. */
export function diagnosticLogLevel(environment: NodeJS.ProcessEnv): LogLevel | null {
  const parsed = logLevelSchema.safeParse(environment.SECUREOPS_LOG_LEVEL ?? 'info');
  return parsed.success ? parsed.data : null;
}

export interface LocalFullConfig {
  readonly mode: 'local-full';
  readonly transport: 'stdio';
  readonly database: {
    readonly path: string;
    readonly readOnly: false;
  };
  readonly logLevel: LogLevel;
}

export interface HttpDemoConfig {
  readonly mode: 'http-demo';
  readonly transport: 'streamable-http';
  readonly database: {
    readonly path: string;
    readonly readOnly: true;
  };
  readonly logLevel: LogLevel;
  readonly http: {
    readonly host: string;
    readonly port: number;
    readonly allowPublicBind: boolean;
    readonly allowedOrigins: readonly string[];
    readonly auth: {
      readonly token: string;
      readonly source:
        | { readonly kind: 'environment'; readonly variable: 'SECUREOPS_HTTP_AUTH_TOKEN' }
        | { readonly kind: 'file' };
    };
  };
}

export type AppConfig = LocalFullConfig | HttpDemoConfig;

// Keep a private record of configurations produced by validation. A plain
// object with a claimed mode must not be enough to mint an MCP actor.
const loadedConfigModes = new WeakMap<AppConfig, AppConfig['mode']>();

function rememberLoadedConfig(config: AppConfig): AppConfig {
  Object.freeze(config.database);
  if (config.mode === 'http-demo') {
    Object.freeze(config.http.allowedOrigins);
    Object.freeze(config.http.auth.source);
    Object.freeze(config.http.auth);
    Object.freeze(config.http);
  }
  Object.freeze(config);
  loadedConfigModes.set(config, config.mode);
  return config;
}

export function modeOfLoadedConfig(value: unknown): AppConfig['mode'] | null {
  if (typeof value !== 'object' || value === null) return null;
  return loadedConfigModes.get(value as AppConfig) ?? null;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

function resolveDatabasePath(configuredPath: string, workingDirectory: string): string {
  if (configuredPath.length === 0 || configuredPath.trim() !== configuredPath) {
    throw new ConfigError(
      'SECUREOPS_DB_PATH must be a nonempty path without surrounding whitespace.',
    );
  }

  const resolvedPath = path.resolve(workingDirectory, configuredPath);
  const relativeToRoot = path.relative(path.parse(resolvedPath).root, resolvedPath);
  const components = relativeToRoot.split(path.sep);

  // Keep paths portable and prevent special SQLite targets such as :memory:.
  if (
    configuredPath.length > 4096 ||
    relativeToRoot.length === 0 ||
    components.some(
      (component) =>
        invalidPathComponent.test(component) ||
        reservedWindowsDevice.test(component) ||
        component.endsWith('.') ||
        component.endsWith(' '),
    ) ||
    !databaseExtensions.has(path.extname(resolvedPath).toLowerCase())
  ) {
    throw new ConfigError('SECUREOPS_DB_PATH must identify a .db, .sqlite, or .sqlite3 file.');
  }

  return resolvedPath;
}

function isLoopbackAddress(address: string): boolean {
  return address === '::1' || (isIP(address) === 4 && address.startsWith('127.'));
}

function resolveAllowedOrigins(rawOrigins: string | undefined): readonly string[] {
  if (rawOrigins === undefined || rawOrigins.length > 8192) {
    throw new ConfigError('SECUREOPS_HTTP_ALLOWED_ORIGINS is required in http-demo mode.');
  }

  const origins = rawOrigins.split(',').map((origin) => origin.trim());
  if (
    origins.length === 0 ||
    origins.length > 16 ||
    origins.some((origin) => origin.length === 0)
  ) {
    throw new ConfigError('SECUREOPS_HTTP_ALLOWED_ORIGINS must contain 1 to 16 origins.');
  }

  for (const origin of origins) {
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      throw new ConfigError('SECUREOPS_HTTP_ALLOWED_ORIGINS contains an invalid origin.');
    }

    const originHost = parsed.hostname.replace(/^\[|\]$/g, '');
    const localOrigin = originHost === 'localhost' || isLoopbackAddress(originHost);
    if (
      origin !== parsed.origin ||
      (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && localOrigin)) ||
      parsed.username !== '' ||
      parsed.password !== ''
    ) {
      throw new ConfigError(
        'SECUREOPS_HTTP_ALLOWED_ORIGINS must use HTTPS or loopback HTTP origins.',
      );
    }
  }

  if (new Set(origins).size !== origins.length) {
    throw new ConfigError('SECUREOPS_HTTP_ALLOWED_ORIGINS must not contain duplicates.');
  }

  return origins;
}

function resolveHttpAuth(
  environment: z.infer<typeof environmentSchema>,
  workingDirectory: string,
): HttpDemoConfig['http']['auth'] {
  const suppliedToken = environment.SECUREOPS_HTTP_AUTH_TOKEN;
  const suppliedFile = environment.SECUREOPS_HTTP_AUTH_TOKEN_FILE;
  if ((suppliedToken === undefined) === (suppliedFile === undefined)) {
    throw new ConfigError('Configure exactly one HTTP bearer-token source.');
  }

  if (suppliedToken !== undefined) {
    if (!bearerTokenPattern.test(suppliedToken)) {
      throw new ConfigError(
        'SECUREOPS_HTTP_AUTH_TOKEN must be a 32 to 512 character bearer token.',
      );
    }
    return makeHttpAuth(suppliedToken, {
      kind: 'environment',
      variable: 'SECUREOPS_HTTP_AUTH_TOKEN',
    });
  }

  if (
    suppliedFile === undefined ||
    suppliedFile.length === 0 ||
    suppliedFile.length > 4096 ||
    suppliedFile.trim() !== suppliedFile ||
    suppliedFile.includes('\0')
  ) {
    throw new ConfigError('SECUREOPS_HTTP_AUTH_TOKEN_FILE must be a valid file path.');
  }

  const tokenFilePath = path.resolve(workingDirectory, suppliedFile);
  let token: string;
  try {
    const file = statSync(tokenFilePath);
    if (!file.isFile() || file.size > 1024) {
      throw new Error('Invalid token file');
    }
    token = readFileSync(tokenFilePath, 'utf8').replace(/\r?\n$/, '');
  } catch {
    // Do not include a secret-file path or filesystem error in routine diagnostics.
    throw new ConfigError('SECUREOPS_HTTP_AUTH_TOKEN_FILE could not be read.');
  }

  if (!bearerTokenPattern.test(token)) {
    throw new ConfigError('SECUREOPS_HTTP_AUTH_TOKEN_FILE must contain a valid bearer token.');
  }
  return makeHttpAuth(token, { kind: 'file' });
}

function makeHttpAuth(
  token: string,
  source: HttpDemoConfig['http']['auth']['source'],
): HttpDemoConfig['http']['auth'] {
  const auth = { token, source };
  // JSON/stringify-based diagnostics must not expose a bearer credential.
  Object.defineProperty(auth, 'token', { enumerable: false });
  return auth;
}

export function loadConfig(
  environment: NodeJS.ProcessEnv = process.env,
  workingDirectory: string = process.cwd(),
): AppConfig {
  const parsed = environmentSchema.safeParse({
    SECUREOPS_MODE: environment.SECUREOPS_MODE,
    SECUREOPS_DB_PATH: environment.SECUREOPS_DB_PATH,
    SECUREOPS_LOG_LEVEL: environment.SECUREOPS_LOG_LEVEL,
    SECUREOPS_HTTP_HOST: environment.SECUREOPS_HTTP_HOST,
    SECUREOPS_HTTP_PORT: environment.SECUREOPS_HTTP_PORT,
    SECUREOPS_HTTP_ALLOW_PUBLIC_BIND: environment.SECUREOPS_HTTP_ALLOW_PUBLIC_BIND,
    SECUREOPS_HTTP_ALLOWED_ORIGINS: environment.SECUREOPS_HTTP_ALLOWED_ORIGINS,
    SECUREOPS_HTTP_AUTH_TOKEN: environment.SECUREOPS_HTTP_AUTH_TOKEN,
    SECUREOPS_HTTP_AUTH_TOKEN_FILE: environment.SECUREOPS_HTTP_AUTH_TOKEN_FILE,
  });

  if (!parsed.success) {
    const keys = [...new Set(parsed.error.issues.map((issue) => String(issue.path[0])))];
    throw new ConfigError(`Invalid SecureOps configuration: ${keys.join(', ')}.`);
  }

  const databasePath = resolveDatabasePath(
    parsed.data.SECUREOPS_DB_PATH ?? defaultDatabasePath,
    workingDirectory,
  );

  if (parsed.data.SECUREOPS_MODE === 'http-demo') {
    const host = parsed.data.SECUREOPS_HTTP_HOST;
    const allowPublicBind = parsed.data.SECUREOPS_HTTP_ALLOW_PUBLIC_BIND === 'true';
    if (isIP(host) === 0) {
      throw new ConfigError('SECUREOPS_HTTP_HOST must be an IP address.');
    }
    if (!isLoopbackAddress(host) && !allowPublicBind) {
      throw new ConfigError(
        'A non-loopback HTTP bind requires SECUREOPS_HTTP_ALLOW_PUBLIC_BIND=true.',
      );
    }

    return rememberLoadedConfig({
      mode: 'http-demo',
      transport: 'streamable-http',
      database: { path: databasePath, readOnly: true },
      logLevel: parsed.data.SECUREOPS_LOG_LEVEL,
      http: {
        host,
        port: parsed.data.SECUREOPS_HTTP_PORT,
        allowPublicBind,
        allowedOrigins: resolveAllowedOrigins(parsed.data.SECUREOPS_HTTP_ALLOWED_ORIGINS),
        auth: resolveHttpAuth(parsed.data, workingDirectory),
      },
    });
  }

  return rememberLoadedConfig({
    mode: 'local-full',
    transport: 'stdio',
    database: { path: databasePath, readOnly: false },
    logLevel: parsed.data.SECUREOPS_LOG_LEVEL,
  });
}
