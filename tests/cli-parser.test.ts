import { describe, expect, it } from 'vitest';

import {
  cliCommands,
  CliUsageError,
  getCliHelp,
  parseCliArgs,
  runCli,
  type CliRuntime,
} from '../src/cli/index.js';

const databasePath = 'data/demo/secureops-demo.db';
const proposalId = 'proposal-demo-001';

function fakeRuntime(interactive = true): { runtime: CliRuntime; calls: string[] } {
  const calls: string[] = [];
  const runtime: CliRuntime = {
    environment: { SECUREOPS_MODE: 'local-full' },
    workingDirectory: 'fictional-workspace',
    isInteractive: () => interactive,
    runMigration: (args) => {
      calls.push(`migrate:${args.join('|')}`);
      return { applied: 2, currentVersion: 3 };
    },
    runDatabase: (args) => {
      calls.push(`database:${args.join('|')}`);
      return { action: args[0] === 'reset' ? 'reset' : 'seed', resourceCount: 5 };
    },
    runReviewerInit: async (args) => {
      calls.push(`reviewer:${args.join('|')}`);
      return { username: 'reviewer_one' };
    },
    runProposalList: async (options) => {
      calls.push(`proposals:list:${JSON.stringify(options)}`);
      return 'No pending fictional proposals.';
    },
    runProposalReview: async (options) => {
      calls.push(`proposals:review:${JSON.stringify(options)}`);
      return 'Review canceled; no decision recorded.';
    },
    runAuditList: async (options) => {
      calls.push(`audit:list:${JSON.stringify(options)}`);
      return 'No local fictional audit events found.';
    },
    runAuditVerify: async (options) => {
      calls.push(`audit:verify:${JSON.stringify(options)}`);
      return 'Local fictional audit chain consistent.';
    },
  };
  return { runtime, calls };
}

describe('CLI command grammar and router', () => {
  it('advertises each stable command and gives help without dispatching', async () => {
    const { runtime, calls } = fakeRuntime();
    const help = getCliHelp();
    expect(parseCliArgs([])).toEqual({ kind: 'help', text: help });
    expect(parseCliArgs(['--help'])).toEqual({ kind: 'help', text: help });
    expect(await runCli(['--help'], runtime)).toBe(help);
    for (const command of cliCommands) {
      expect(help).toContain(command);
      expect(parseCliArgs([command, '--help'])).toEqual({
        kind: 'help',
        text: getCliHelp(command),
      });
    }
    expect(getCliHelp('proposals:review')).toContain('after reviewer authentication');
    expect(getCliHelp('audit:verify')).toContain('after authentication');
    expect(calls).toEqual([]);
  });

  it('parses bounded paging and one synthetic audit filter', () => {
    expect(
      parseCliArgs([
        'audit:list',
        '--offset',
        '10000',
        '--resource-id',
        'res-aws-ec2-01',
        '--db-path',
        databasePath,
        '--limit',
        '100',
      ]),
    ).toEqual({
      kind: 'command',
      command: 'audit:list',
      options: {
        databasePath,
        force: false,
        resourceId: 'res-aws-ec2-01',
        limit: 100,
        offset: 10_000,
      },
    });
    expect(
      parseCliArgs(['proposals:review', '--proposal-id', proposalId, '--db-path', databasePath]),
    ).toEqual({
      kind: 'command',
      command: 'proposals:review',
      options: { databasePath, force: false, proposalId },
    });
  });

  it.each(
    [
      ['unknown', '--db-path', databasePath],
      ['db:seed'],
      ['db:seed', '--db-path', ''],
      ['db:seed', '--db-path', databasePath, '--db-path', databasePath],
      ['db:seed', '--db-path', databasePath, '--force'],
      ['db:seed', '--db-path', databasePath, 'extra'],
      ['db:reset', '--db-path', databasePath],
      ['reviewer:init', '--db-path', databasePath, '--passphrase', 'unsafe'],
      ['proposals:review', '--db-path', databasePath],
      ['proposals:review', '--db-path', databasePath, '--proposal-id', 'wrong-id'],
      [
        'audit:list',
        '--db-path',
        databasePath,
        '--proposal-id',
        proposalId,
        '--resource-id',
        'res-aws-ec2-01',
      ],
      ['audit:list', '--db-path', databasePath, '--limit', '0'],
      ['audit:list', '--db-path', databasePath, '--limit', '101'],
      ['audit:list', '--db-path', databasePath, '--offset', '-1'],
      ['audit:verify', '--db-path', databasePath, '--limit', '1'],
    ].map((args) => ({ args })),
  )('rejects unsupported or unsafe arguments before dispatch: $args', async ({ args }) => {
    const { runtime, calls } = fakeRuntime();
    expect(() => parseCliArgs(args)).toThrow(CliUsageError);
    await expect(runCli(args, runtime)).rejects.toThrow(CliUsageError);
    expect(calls).toEqual([]);
  });

  it('dispatches existing database commands with canonical arguments', async () => {
    const { runtime, calls } = fakeRuntime();
    expect(await runCli(['db:migrate', '--db-path', databasePath], runtime)).toBe(
      'Applied 2 migration(s); schema version 3.',
    );
    expect(await runCli(['db:seed', '--db-path', databasePath], runtime)).toBe(
      'Seeded 5 demo resources.',
    );
    expect(await runCli(['db:reset', '--force', '--db-path', databasePath], runtime)).toBe(
      'Restored 5 demo resources.',
    );
    expect(calls).toEqual([
      `migrate:--db-path|${databasePath}`,
      `database:seed|--db-path|${databasePath}`,
      `database:reset|--db-path|${databasePath}|--force`,
    ]);
  });

  it('rejects nonterminal reset and protected commands before dispatch', async () => {
    const { runtime, calls } = fakeRuntime(false);
    await expect(
      runCli(['db:reset', '--db-path', databasePath, '--force'], runtime),
    ).rejects.toThrow('interactive terminal');
    await expect(runCli(['reviewer:init', '--db-path', databasePath], runtime)).rejects.toThrow(
      'interactive terminal',
    );
    await expect(
      runCli(['proposals:review', '--db-path', databasePath, '--proposal-id', proposalId], runtime),
    ).rejects.toThrow('interactive terminal');
    await expect(runCli(['proposals:list', '--db-path', databasePath], runtime)).rejects.toThrow(
      'interactive terminal',
    );
    await expect(runCli(['audit:list', '--db-path', databasePath], runtime)).rejects.toThrow(
      'interactive terminal',
    );
    await expect(runCli(['audit:verify', '--db-path', databasePath], runtime)).rejects.toThrow(
      'interactive terminal',
    );
    expect(calls).toEqual([]);
  });

  it('delegates authenticated proposal and audit slots', async () => {
    const { runtime, calls } = fakeRuntime();
    expect(await runCli(['reviewer:init', '--db-path', databasePath], runtime)).toBe(
      'Enrolled local reviewer reviewer_one.',
    );
    expect(await runCli(['proposals:list', '--db-path', databasePath], runtime)).toBe(
      'No pending fictional proposals.',
    );
    expect(
      await runCli(
        ['proposals:review', '--db-path', databasePath, '--proposal-id', proposalId],
        runtime,
      ),
    ).toBe('Review canceled; no decision recorded.');
    expect(await runCli(['audit:list', '--db-path', databasePath], runtime)).toBe(
      'No local fictional audit events found.',
    );
    expect(await runCli(['audit:verify', '--db-path', databasePath], runtime)).toBe(
      'Local fictional audit chain consistent.',
    );
    expect(calls).toEqual([
      `reviewer:--db-path|${databasePath}`,
      `proposals:list:${JSON.stringify({ databasePath })}`,
      `proposals:review:${JSON.stringify({ databasePath, proposalId })}`,
      `audit:list:${JSON.stringify({ databasePath })}`,
      `audit:verify:${JSON.stringify({ databasePath })}`,
    ]);
  });
});
