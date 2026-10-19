import { writeFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { ConfigError, loadConfig } from '../src/config.js';

const workingDirectory = process.cwd();
const exampleToken = 'a'.repeat(32);

function httpEnvironment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    SECUREOPS_MODE: 'http-demo',
    SECUREOPS_HTTP_ALLOWED_ORIGINS: 'http://127.0.0.1:3000',
    SECUREOPS_HTTP_AUTH_TOKEN: exampleToken,
    ...overrides,
  };
}

describe('loadConfig', () => {
  it('defaults to local stdio with a resolved writable SQLite path', () => {
    expect(loadConfig({}, workingDirectory)).toEqual({
      mode: 'local-full',
      transport: 'stdio',
      database: { path: path.resolve(workingDirectory, 'data', 'secureops.db'), readOnly: false },
      logLevel: 'info',
    });
  });

  it('rejects an unknown mode', () => {
    expect(() => loadConfig({ SECUREOPS_MODE: 'admin' }, workingDirectory)).toThrow(ConfigError);
  });

  it.each(['silent', 'error', 'warn', 'info', 'debug'] as const)(
    'accepts the %s diagnostic level in local and HTTP configuration',
    (level) => {
      expect(loadConfig({ SECUREOPS_LOG_LEVEL: level }, workingDirectory).logLevel).toBe(level);
      expect(
        loadConfig(httpEnvironment({ SECUREOPS_LOG_LEVEL: level }), workingDirectory).logLevel,
      ).toBe(level);
    },
  );

  it.each(['', 'off', 'trace', 'ERROR'])('rejects the unknown diagnostic level %s', (level) => {
    expect(() => loadConfig({ SECUREOPS_LOG_LEVEL: level }, workingDirectory)).toThrow(ConfigError);
  });

  it.each(['0', '65536', '-1', '1.5', 'abc'])('rejects invalid HTTP port %s', (port) => {
    expect(() =>
      loadConfig(httpEnvironment({ SECUREOPS_HTTP_PORT: port }), workingDirectory),
    ).toThrow(ConfigError);
  });

  it.each(['', ':memory:', 'NUL.db', 'data/folder/'])(
    'rejects invalid database path %s',
    (databasePath) => {
      expect(() => loadConfig({ SECUREOPS_DB_PATH: databasePath }, workingDirectory)).toThrow(
        ConfigError,
      );
    },
  );

  it('rejects HTTP mode without a bearer credential', () => {
    expect(() =>
      loadConfig(
        { SECUREOPS_MODE: 'http-demo', SECUREOPS_HTTP_ALLOWED_ORIGINS: 'http://127.0.0.1:3000' },
        workingDirectory,
      ),
    ).toThrow('exactly one HTTP bearer-token source');
  });

  it('returns a loopback-only, read-only HTTP configuration', () => {
    const config = loadConfig(httpEnvironment(), workingDirectory);
    expect(config.mode).toBe('http-demo');
    if (config.mode !== 'http-demo') throw new Error('Expected HTTP configuration');

    expect(config.database.readOnly).toBe(true);
    expect(config.http.host).toBe('127.0.0.1');
    expect(config.http.port).toBe(3000);
    expect(config.http.allowPublicBind).toBe(false);
    expect(config.http.allowedOrigins).toEqual(['http://127.0.0.1:3000']);
    expect(config.http.auth.token).toBe(exampleToken);
    expect(JSON.stringify(config)).not.toContain(exampleToken);
  });

  it('requires explicit opt-in to bind to a non-loopback address', () => {
    const environment = httpEnvironment({ SECUREOPS_HTTP_HOST: '0.0.0.0' });
    expect(() => loadConfig(environment, workingDirectory)).toThrow(
      'requires SECUREOPS_HTTP_ALLOW_PUBLIC_BIND=true',
    );

    const config = loadConfig(
      { ...environment, SECUREOPS_HTTP_ALLOW_PUBLIC_BIND: 'true' },
      workingDirectory,
    );
    expect(config.mode).toBe('http-demo');
    if (config.mode !== 'http-demo') throw new Error('Expected HTTP configuration');
    expect(config.http.host).toBe('0.0.0.0');
    expect(config.http.allowPublicBind).toBe(true);
  });

  it.each(['*', 'http://example.com', 'https://example.com/path', 'http://127.0.0.1:3000/'])(
    'rejects unsafe or non-origin allowlist entry %s',
    (origin) => {
      expect(() =>
        loadConfig(httpEnvironment({ SECUREOPS_HTTP_ALLOWED_ORIGINS: origin }), workingDirectory),
      ).toThrow(ConfigError);
    },
  );

  it('loads a bearer token from a file without serializing it or its path', () => {
    const temporaryDirectory = process.env.SECUREOPS_TEST_DIR;
    if (temporaryDirectory === undefined) throw new Error('Missing disposable test directory');
    const tokenFile = path.join(temporaryDirectory, 'viewer.token');
    writeFileSync(tokenFile, `${exampleToken}\n`);

    const config = loadConfig(
      httpEnvironment({
        SECUREOPS_HTTP_AUTH_TOKEN: undefined,
        SECUREOPS_HTTP_AUTH_TOKEN_FILE: tokenFile,
      }),
      workingDirectory,
    );
    expect(config.mode).toBe('http-demo');
    if (config.mode !== 'http-demo') throw new Error('Expected HTTP configuration');
    expect(config.http.auth.token).toBe(exampleToken);
    expect(config.http.auth.source).toEqual({ kind: 'file' });
    expect(JSON.stringify(config)).not.toContain(exampleToken);
    expect(JSON.stringify(config)).not.toContain(tokenFile);
  });

  it('rejects both bearer-token sources being configured', () => {
    expect(() =>
      loadConfig(
        httpEnvironment({ SECUREOPS_HTTP_AUTH_TOKEN_FILE: 'viewer.token' }),
        workingDirectory,
      ),
    ).toThrow('exactly one HTTP bearer-token source');
  });
});
