import { describe, expect, it } from 'vitest';

import { ApprovalRequestService } from '../src/application/approval-request-service.js';
import { ProposalService } from '../src/application/proposal-service.js';
import {
  runProposalListCommand,
  runProposalReviewCommand,
  type ProposalPromptRuntime,
} from '../src/cli/commands/proposals.js';
import { parseCliArgs } from '../src/cli/index.js';
import { runReviewerInitCommand } from '../src/cli/commands/reviewer-init.js';
import { loadConfig } from '../src/config.js';
import type { SqliteConnection } from '../src/infra/sqlite/connection.js';
import { SqliteDecisionRepository } from '../src/infra/sqlite/decision-repository.js';
import { SqliteProposalRepository } from '../src/infra/sqlite/proposal-repository.js';
import { SqliteResourceRepository } from '../src/infra/sqlite/resource-repository.js';
import { createMcpActor } from '../src/security/permissions.js';
import type { ReviewerAuthRuntime } from '../src/security/reviewer-auth.js';
import { buildProposalRequest } from './helpers/builders.js';
import { createFixedClock, createSequentialIdGenerator } from './helpers/fakes.js';
import { withTestDatabase } from './helpers/test-db.js';

const username = 'reviewer_one';
const passphrase = 'fictional-reviewer-passphrase-001';
const approvalTime = '2026-01-01T01:00:00.000Z';
const environment = { SECUREOPS_MODE: 'local-full' };

function databasePath(database: SqliteConnection): string {
  const entries = database.pragma('database_list') as Array<{ name: string; file: string }>;
  const main = entries.find((entry) => entry.name === 'main');
  if (main === undefined || main.file.length === 0)
    throw new Error('Missing private test database.');
  return main.file;
}

async function enrollReviewer(database: SqliteConnection): Promise<void> {
  await runReviewerInitCommand(['--db-path', databasePath(database)], environment, process.cwd(), {
    isInteractive: () => true,
    askUsername: async () => username,
    askPassphrase: async () => passphrase,
  });
}

function createPendingProposal(database: SqliteConnection, reason?: string): string {
  const request = buildProposalRequest(reason === undefined ? {} : { reason });
  const agent = createMcpActor(loadConfig(environment, process.cwd()));
  const proposalId = new ProposalService(
    database,
    createFixedClock(),
    createSequentialIdGenerator(),
  ).proposeChange(agent, {
    resourceId: request.resourceId,
    action: { type: request.actionType },
    reason: request.reason,
    idempotencyKey: request.idempotencyKey,
  }).proposalId;
  new ApprovalRequestService(database, createFixedClock(approvalTime)).requestApproval(agent, {
    proposalId,
    justification: 'Independent fictional review requested.',
  });
  return proposalId;
}

interface PromptHarness {
  readonly runtime: ProposalPromptRuntime;
  readonly displays: string[];
  readonly prompts: string[];
}

function promptHarness(
  options: {
    readonly interactive?: boolean;
    readonly enteredPassphrase?: string;
    readonly decision?: 'approved' | 'rejected';
    readonly confirmed?: boolean;
  } = {},
): PromptHarness {
  const displays: string[] = [];
  const prompts: string[] = [];
  const interactive = options.interactive ?? true;
  const authRuntime: ReviewerAuthRuntime = {
    isInteractive: () => interactive,
    askUsername: async () => {
      prompts.push('username');
      return username;
    },
    askPassphrase: async () => {
      prompts.push('passphrase');
      return options.enteredPassphrase ?? passphrase;
    },
    delay: async () => undefined,
  };
  return {
    displays,
    prompts,
    runtime: {
      isInteractive: () => interactive,
      write: (text) => {
        displays.push(text);
      },
      chooseDecision: async () => {
        prompts.push('decision');
        return options.decision ?? 'approved';
      },
      askReason: async () => {
        prompts.push('reason');
        return 'Human reviewed this fictional change.';
      },
      confirmDecision: async () => {
        prompts.push('confirmation');
        return options.confirmed ?? true;
      },
      authRuntime,
    },
  };
}

function decisionCount(database: SqliteConnection): number {
  const row = database.prepare('SELECT count(*) AS total FROM approval_decisions').get() as {
    total: number;
  };
  return row.total;
}

describe('authenticated proposal CLI', () => {
  it('lists pending requests only after reviewer authentication and escapes stored text', async () => {
    await withTestDatabase(
      async (database) => {
        const proposalId = createPendingProposal(
          database,
          'Synthetic request with \u202e invisible direction text.',
        );
        await enrollReviewer(database);
        const harness = promptHarness();
        const output = await runProposalListCommand(
          { databasePath: databasePath(database), limit: 1, offset: 0 },
          environment,
          process.cwd(),
          harness.runtime,
        );

        expect(harness.prompts).toEqual(['username', 'passphrase']);
        expect(output).toContain(proposalId);
        expect(output).toContain('fictional local simulation');
        expect(output).toContain('Current policy');
        expect(output).toContain('Estimated monthly cost');
        expect(output).toContain('Synthetic request with   invisible direction text.');
        expect(output).not.toContain('\u202e');
        expect(decisionCount(database)).toBe(0);
        expect(new SqliteProposalRepository(database).getById(proposalId)?.status).toBe(
          'pending_approval',
        );
      },
      { seed: true },
    );
  });

  it('records an approved decision only after a separate confirmation', async () => {
    await withTestDatabase(
      async (database) => {
        const proposalId = createPendingProposal(database);
        await enrollReviewer(database);
        const harness = promptHarness();
        const output = await runProposalReviewCommand(
          { databasePath: databasePath(database), proposalId },
          environment,
          process.cwd(),
          harness.runtime,
        );

        expect(harness.prompts).toEqual([
          'username',
          'passphrase',
          'decision',
          'reason',
          'confirmation',
        ]);
        expect(harness.displays.join('')).toContain(proposalId);
        expect(output).toMatch(
          /^Recorded approved decision decision-[a-z0-9-]+ for fictional proposal /,
        );
        expect(output).toContain(proposalId);
        expect(new SqliteProposalRepository(database).getById(proposalId)?.status).toBe('approved');
        const reviewer = database
          .prepare('SELECT id FROM local_identities WHERE username = ?')
          .get(username) as { id: string };
        expect(new SqliteDecisionRepository(database).getByProposalId(proposalId)).toMatchObject({
          reviewerId: reviewer.id,
          decision: 'approved',
          reason: 'Human reviewed this fictional change.',
        });
        expect(decisionCount(database)).toBe(1);
      },
      { seed: true },
    );
  });

  it('leaves the proposal pending when the human declines confirmation', async () => {
    await withTestDatabase(
      async (database) => {
        const proposalId = createPendingProposal(database);
        await enrollReviewer(database);
        const harness = promptHarness({ confirmed: false });
        const output = await runProposalReviewCommand(
          { databasePath: databasePath(database), proposalId },
          environment,
          process.cwd(),
          harness.runtime,
        );

        expect(output).toBe('Review canceled; no decision recorded.');
        expect(harness.prompts).toContain('confirmation');
        expect(decisionCount(database)).toBe(0);
        expect(new SqliteProposalRepository(database).getById(proposalId)?.status).toBe(
          'pending_approval',
        );
      },
      { seed: true },
    );
  });

  it('records a confirmed rejection without approving the fictional change', async () => {
    await withTestDatabase(
      async (database) => {
        const proposalId = createPendingProposal(database);
        await enrollReviewer(database);
        const harness = promptHarness({ decision: 'rejected' });
        const output = await runProposalReviewCommand(
          { databasePath: databasePath(database), proposalId },
          environment,
          process.cwd(),
          harness.runtime,
        );

        expect(output).toContain('Recorded rejected decision');
        expect(harness.prompts).toContain('confirmation');
        expect(new SqliteProposalRepository(database).getById(proposalId)?.status).toBe('rejected');
        expect(new SqliteDecisionRepository(database).getByProposalId(proposalId)?.decision).toBe(
          'rejected',
        );
        expect(decisionCount(database)).toBe(1);
      },
      { seed: true },
    );
  });

  it('rejects bad credentials before showing or deciding a proposal', async () => {
    await withTestDatabase(
      async (database) => {
        const proposalId = createPendingProposal(database);
        await enrollReviewer(database);
        const harness = promptHarness({ enteredPassphrase: 'incorrect-fictional-secret' });
        const selectedPath = databasePath(database);

        await expect(
          runProposalListCommand(
            { databasePath: selectedPath },
            environment,
            process.cwd(),
            harness.runtime,
          ),
        ).rejects.toThrow('Authentication failed.');
        await expect(
          runProposalReviewCommand(
            { databasePath: selectedPath, proposalId },
            environment,
            process.cwd(),
            harness.runtime,
          ),
        ).rejects.toThrow('Authentication failed.');
        expect(harness.displays).toEqual([]);
        expect(harness.prompts.filter((prompt) => prompt === 'decision')).toEqual([]);
        expect(decisionCount(database)).toBe(0);
      },
      { seed: true },
    );
  });

  it('refuses a stale proposal before asking for a decision', async () => {
    await withTestDatabase(
      async (database) => {
        const proposalId = createPendingProposal(database);
        await enrollReviewer(database);
        const resources = new SqliteResourceRepository(database);
        const current = resources.getById(buildProposalRequest().resourceId);
        if (current === null) throw new Error('Missing fictional compute resource.');
        expect(resources.updateIfVersion(current, current.version).status).toBe('updated');
        const harness = promptHarness();

        await expect(
          runProposalReviewCommand(
            { databasePath: databasePath(database), proposalId },
            environment,
            process.cwd(),
            harness.runtime,
          ),
        ).rejects.toThrow('cannot be reviewed');
        expect(harness.displays.join('')).toContain('[stale]');
        expect(harness.prompts).toEqual(['username', 'passphrase']);
        expect(decisionCount(database)).toBe(0);
      },
      { seed: true },
    );
  });

  it('requires a terminal before authentication or database access', async () => {
    const harness = promptHarness({ interactive: false });
    const missingPath = 'missing-review-database.db';
    await expect(
      runProposalListCommand(
        { databasePath: missingPath },
        environment,
        process.cwd(),
        harness.runtime,
      ),
    ).rejects.toThrow('interactive terminal');
    await expect(
      runProposalReviewCommand(
        { databasePath: missingPath, proposalId: 'proposal-demo-001' },
        environment,
        process.cwd(),
        harness.runtime,
      ),
    ).rejects.toThrow('interactive terminal');
    expect(harness.prompts).toEqual([]);
    expect(harness.displays).toEqual([]);
  });

  it('rejects flag and direct-handler attempts to bypass interactive approval', async () => {
    const selectedPath = 'fictional-review-database.db';
    for (const flag of ['--approve', '--decision', '--reason', '--passphrase', '--username']) {
      expect(() =>
        parseCliArgs([
          'proposals:review',
          '--db-path',
          selectedPath,
          '--proposal-id',
          'proposal-demo-001',
          flag,
          'approved',
        ]),
      ).toThrow();
    }
    const harness = promptHarness({ interactive: false });
    await expect(
      runProposalReviewCommand(
        {
          databasePath: selectedPath,
          proposalId: 'proposal-demo-001',
          decision: 'approved',
        },
        environment,
        process.cwd(),
        harness.runtime,
      ),
    ).rejects.toThrow('Invalid proposal review options.');
    expect(harness.prompts).toEqual([]);
  });
});
