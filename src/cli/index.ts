import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { AuditCommandError, runAuditListCommand, runAuditVerifyCommand } from './commands/audit.js';
import { runDatabaseCommand } from './commands/db.js';
import { runMigrationCommand } from './commands/migrate.js';
import {
  ProposalCommandError,
  runProposalListCommand,
  runProposalReviewCommand,
} from './commands/proposals.js';
import { runReviewerInitCommand } from './commands/reviewer-init.js';
import { resourceIdSchema } from '../domain/resource.js';
import { proposalDraftSchema } from '../infra/sqlite/proposal-repository.js';

/** Importing this module never executes a command or opens a database. */

export const cliCommands = Object.freeze([
  'db:migrate',
  'db:seed',
  'db:reset',
  'reviewer:init',
  'proposals:list',
  'proposals:review',
  'audit:list',
  'audit:verify',
] as const);

export type CliCommand = (typeof cliCommands)[number];
type CliFlag = '--db-path' | '--force' | '--proposal-id' | '--resource-id' | '--limit' | '--offset';

interface CommandSpec {
  readonly summary: string;
  readonly usage: string;
  readonly flags: readonly CliFlag[];
  readonly required: readonly CliFlag[];
}

const commandSpecs: Readonly<Record<CliCommand, CommandSpec>> = {
  'db:migrate': {
    summary: 'Apply numbered migrations to a selected local database.',
    usage: 'db:migrate --db-path <local .db path>',
    flags: ['--db-path'],
    required: ['--db-path'],
  },
  'db:seed': {
    summary: 'Seed missing fictional resources in the disposable demo database.',
    usage: 'db:seed --db-path data/demo/secureops-demo.db',
    flags: ['--db-path'],
    required: ['--db-path'],
  },
  'db:reset': {
    summary: 'Restore the disposable demo database and clear its local workflow.',
    usage: 'db:reset --db-path data/demo/secureops-demo.db --force',
    flags: ['--db-path', '--force'],
    required: ['--db-path', '--force'],
  },
  'reviewer:init': {
    summary: 'Enroll the first local reviewer through an interactive terminal.',
    usage: 'reviewer:init --db-path <existing local .db path>',
    flags: ['--db-path'],
    required: ['--db-path'],
  },
  'proposals:list': {
    summary: 'List pending fictional proposals after reviewer authentication.',
    usage: 'proposals:list --db-path <local .db path> [--limit 1..100] [--offset 0..10000]',
    flags: ['--db-path', '--limit', '--offset'],
    required: ['--db-path'],
  },
  'proposals:review': {
    summary:
      'Interactively approve or reject one fictional proposal after reviewer authentication.',
    usage: 'proposals:review --db-path <local .db path> --proposal-id <id>',
    flags: ['--db-path', '--proposal-id'],
    required: ['--db-path', '--proposal-id'],
  },
  'audit:list': {
    summary: 'List local fictional audit events after reviewer or auditor authentication.',
    usage:
      'audit:list --db-path <local .db path> [--proposal-id <id> | --resource-id <id>] ' +
      '[--limit 1..100] [--offset 0..10000]',
    flags: ['--db-path', '--proposal-id', '--resource-id', '--limit', '--offset'],
    required: ['--db-path'],
  },
  'audit:verify': {
    summary: 'Check consistency of stored local audit events after authentication.',
    usage: 'audit:verify --db-path <local .db path>',
    flags: ['--db-path'],
    required: ['--db-path'],
  },
};

export interface CliOptions {
  readonly databasePath: string;
  readonly force: boolean;
  readonly proposalId?: string;
  readonly resourceId?: string;
  readonly limit?: number;
  readonly offset?: number;
}

export type ParsedCliArgs =
  | { readonly kind: 'help'; readonly text: string }
  | { readonly kind: 'command'; readonly command: CliCommand; readonly options: CliOptions };

export class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliUsageError';
  }
}

function isCliCommand(value: string): value is CliCommand {
  return Object.hasOwn(commandSpecs, value);
}

function isAllowedFlag(value: string, spec: CommandSpec): value is CliFlag {
  return spec.flags.some((flag) => flag === value);
}

export function getCliHelp(command?: CliCommand): string {
  if (command !== undefined) {
    const spec = commandSpecs[command];
    return `Usage: npm run cli -- ${spec.usage}\n\n${spec.summary}\n`;
  }
  const lines = cliCommands.map((name) => `  ${commandSpecs[name].usage}`);
  return [
    'SecureOps MCP - fictional local resource governance',
    '',
    'Usage: npm run cli -- <command> [flags]',
    '       npm run cli -- <command> --help',
    '',
    'Commands:',
    ...lines,
    '',
    'Select a local database explicitly. Review and audit commands require a terminal challenge.',
    'Commands operate on local SQLite data and never contact a cloud provider.',
    '',
  ].join('\n');
}

function parseBoundedInteger(value: string, minimum: number, maximum: number): number {
  if (!/^(0|[1-9][0-9]{0,4})$/.test(value)) throw new CliUsageError('Invalid paging value.');
  const parsed = Number(value);
  if (parsed < minimum || parsed > maximum) throw new CliUsageError('Invalid paging value.');
  return parsed;
}

/** Parse without opening a database, prompting, writing output, or reading environment state. */
export function parseCliArgs(args: readonly string[]): ParsedCliArgs {
  if (args.length === 0 || (args.length === 1 && args[0] === '--help')) {
    return { kind: 'help', text: getCliHelp() };
  }
  const commandName = args[0];
  if (commandName === undefined || !isCliCommand(commandName)) {
    throw new CliUsageError('Unknown command. Run npm run cli -- --help for usage.');
  }
  if (args.length === 2 && args[1] === '--help') {
    return { kind: 'help', text: getCliHelp(commandName) };
  }

  const spec = commandSpecs[commandName];
  const values = new Map<CliFlag, string | true>();
  for (let index = 1; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === undefined || !isAllowedFlag(flag, spec)) {
      throw new CliUsageError(`Invalid flags. Run npm run cli -- ${commandName} --help for usage.`);
    }
    if (values.has(flag)) throw new CliUsageError('Duplicate CLI flag.');
    if (flag === '--force') {
      values.set(flag, true);
      continue;
    }
    const value = args[index + 1];
    if (value === undefined || value.length === 0 || value.startsWith('--')) {
      throw new CliUsageError('Missing CLI flag value.');
    }
    values.set(flag, value);
    index += 1;
  }
  if (spec.required.some((flag) => !values.has(flag))) {
    throw new CliUsageError(
      `Missing required flag. Run npm run cli -- ${commandName} --help for usage.`,
    );
  }
  if (values.has('--proposal-id') && values.has('--resource-id')) {
    throw new CliUsageError('Select only one audit subject filter.');
  }

  const databasePath = values.get('--db-path');
  if (typeof databasePath !== 'string' || databasePath.trim() !== databasePath) {
    throw new CliUsageError('Select a nonempty local database path.');
  }
  const proposalId = values.get('--proposal-id');
  const resourceId = values.get('--resource-id');
  if (
    (typeof proposalId === 'string' &&
      !proposalDraftSchema.shape.id.safeParse(proposalId).success) ||
    (typeof resourceId === 'string' && !resourceIdSchema.safeParse(resourceId).success)
  ) {
    throw new CliUsageError('Invalid synthetic identifier.');
  }
  const limit = values.get('--limit');
  const offset = values.get('--offset');
  const options: CliOptions = Object.freeze({
    databasePath,
    force: values.has('--force'),
    ...(typeof proposalId === 'string' ? { proposalId } : {}),
    ...(typeof resourceId === 'string' ? { resourceId } : {}),
    ...(typeof limit === 'string' ? { limit: parseBoundedInteger(limit, 1, 100) } : {}),
    ...(typeof offset === 'string' ? { offset: parseBoundedInteger(offset, 0, 10_000) } : {}),
  });
  return { kind: 'command', command: commandName, options };
}

export interface CliRuntime {
  readonly environment: NodeJS.ProcessEnv;
  readonly workingDirectory: string;
  isInteractive(): boolean;
  runMigration: typeof runMigrationCommand;
  runDatabase: typeof runDatabaseCommand;
  runReviewerInit: typeof runReviewerInitCommand;
  runProposalList: typeof runProposalListCommand;
  runProposalReview: typeof runProposalReviewCommand;
  runAuditList: typeof runAuditListCommand;
  runAuditVerify: typeof runAuditVerifyCommand;
}

function defaultRuntime(): CliRuntime {
  return {
    environment: process.env,
    workingDirectory: process.cwd(),
    isInteractive: () => process.stdin.isTTY === true && process.stderr.isTTY === true,
    runMigration: runMigrationCommand,
    runDatabase: runDatabaseCommand,
    runReviewerInit: runReviewerInitCommand,
    runProposalList: runProposalListCommand,
    runProposalReview: runProposalReviewCommand,
    runAuditList: runAuditListCommand,
    runAuditVerify: runAuditVerifyCommand,
  };
}

/** Route parsed local commands; each protected handler authenticates its reader. */
export async function runCli(
  args: readonly string[],
  runtime: CliRuntime = defaultRuntime(),
): Promise<string> {
  const parsed = parseCliArgs(args);
  if (parsed.kind === 'help') return parsed.text;

  const { command, options } = parsed;
  const databaseArgs = ['--db-path', options.databasePath] as const;
  switch (command) {
    case 'db:migrate': {
      const result = runtime.runMigration(
        databaseArgs,
        runtime.environment,
        runtime.workingDirectory,
      );
      return `Applied ${result.applied} migration(s); schema version ${result.currentVersion}.`;
    }
    case 'db:seed': {
      const result = runtime.runDatabase(
        ['seed', ...databaseArgs],
        runtime.environment,
        runtime.workingDirectory,
      );
      return `Seeded ${result.resourceCount} demo resources.`;
    }
    case 'db:reset': {
      if (!runtime.isInteractive()) {
        throw new CliUsageError('Demo reset requires an interactive terminal.');
      }
      const result = runtime.runDatabase(
        ['reset', ...databaseArgs, '--force'],
        runtime.environment,
        runtime.workingDirectory,
      );
      return `Restored ${result.resourceCount} demo resources.`;
    }
    case 'reviewer:init': {
      if (!runtime.isInteractive()) {
        throw new CliUsageError('Reviewer enrollment requires an interactive terminal.');
      }
      const result = await runtime.runReviewerInit(
        databaseArgs,
        runtime.environment,
        runtime.workingDirectory,
      );
      return `Enrolled local reviewer ${result.username}.`;
    }
    case 'proposals:review':
      if (!runtime.isInteractive()) {
        throw new CliUsageError('Proposal review requires an interactive terminal.');
      }
      return await runtime.runProposalReview(
        {
          databasePath: options.databasePath,
          proposalId: options.proposalId,
        },
        runtime.environment,
        runtime.workingDirectory,
      );
    case 'proposals:list':
      if (!runtime.isInteractive()) {
        throw new CliUsageError('Proposal listing requires an interactive terminal.');
      }
      return await runtime.runProposalList(
        {
          databasePath: options.databasePath,
          limit: options.limit,
          offset: options.offset,
        },
        runtime.environment,
        runtime.workingDirectory,
      );
    case 'audit:list':
      if (!runtime.isInteractive()) {
        throw new CliUsageError('Audit listing requires an interactive terminal.');
      }
      return await runtime.runAuditList(
        {
          databasePath: options.databasePath,
          proposalId: options.proposalId,
          resourceId: options.resourceId,
          limit: options.limit,
          offset: options.offset,
        },
        runtime.environment,
        runtime.workingDirectory,
      );
    case 'audit:verify':
      if (!runtime.isInteractive()) {
        throw new CliUsageError('Audit verification requires an interactive terminal.');
      }
      return await runtime.runAuditVerify(
        {
          databasePath: options.databasePath,
        },
        runtime.environment,
        runtime.workingDirectory,
      );
  }
}

function isDirectInvocation(): boolean {
  const entryPoint = process.argv[1];
  if (entryPoint === undefined) return false;
  try {
    return realpathSync(path.resolve(entryPoint)) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isDirectInvocation()) {
  try {
    const output = await runCli(process.argv.slice(2));
    process.stdout.write(output.endsWith('\n') ? output : `${output}\n`);
  } catch (error) {
    // Never return thrown SQL, paths, configuration, or prompt values to the terminal.
    const message =
      error instanceof CliUsageError ||
      error instanceof ProposalCommandError ||
      error instanceof AuditCommandError
        ? error.message
        : error instanceof Error &&
            (error.name === 'ExitPromptError' || error.name === 'AbortPromptError')
          ? 'Command canceled.'
          : 'SecureOps command failed.';
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
