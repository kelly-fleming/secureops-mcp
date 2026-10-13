import { randomUUID } from 'node:crypto';

import { ProposalService } from '../../application/proposal-service.js';
import { proposeChangeInputSchema, proposeChangeOutputSchema } from '../schemas.js';
import type { McpToolRegistrar } from '../server.js';
import { handleStructuredToolCall } from '../tool-handler.js';

/** Register draft creation; the proposal service owns authorization and the write transaction. */
export const registerProposeChangeTool: McpToolRegistrar = (server, context) => {
  const proposalService = new ProposalService(
    context.database,
    { now: () => new Date() },
    { nextId: (prefix) => `${prefix}-${randomUUID()}` },
  );

  server.registerTool(
    'propose_change',
    {
      title: 'Propose fictional resource change',
      description:
        'Create a draft after checking the current fictional resource and policy. An exact retry returns the original draft and policy snapshot. No approval or execution is granted.',
      annotations: { readOnlyHint: false, openWorldHint: false },
      inputSchema: proposeChangeInputSchema,
      outputSchema: proposeChangeOutputSchema,
    },
    (input) =>
      handleStructuredToolCall(
        input,
        proposeChangeInputSchema,
        proposeChangeOutputSchema,
        (request) => proposalService.proposeChange(context.actor, request),
      ),
  );
};
