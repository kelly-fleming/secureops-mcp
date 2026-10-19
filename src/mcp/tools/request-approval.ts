import { ApprovalRequestService } from '../../application/approval-request-service.js';
import { requestApprovalInputSchema, requestApprovalOutputSchema } from '../schemas.js';
import type { McpToolRegistrar } from '../server.js';
import { handleStructuredToolCall } from '../tool-handler.js';

/** Register a review request; only an independently authenticated CLI reviewer can decide it. */
export const registerRequestApprovalTool: McpToolRegistrar = (server, context) => {
  const approvalRequestService = new ApprovalRequestService(context.database, {
    now: () => new Date(),
  });

  server.registerTool(
    'request_approval',
    {
      title: 'Request independent review',
      description:
        'Move your eligible fictional draft to pending approval with a justification. A separate authenticated human reviewer must decide it through the local CLI.',
      annotations: { readOnlyHint: false, openWorldHint: false },
      inputSchema: requestApprovalInputSchema,
      outputSchema: requestApprovalOutputSchema,
    },
    (input) =>
      handleStructuredToolCall(
        input,
        requestApprovalInputSchema,
        requestApprovalOutputSchema,
        (request) => approvalRequestService.requestApproval(context.actor, request),
        { logger: context.logger, operation: 'request_approval' },
      ),
  );
};
