import { ExecutionService } from '../../application/execution-service.js';
import { executeChangeInputSchema, executeChangeOutputSchema } from '../schemas.js';
import type { McpToolRegistrar } from '../server.js';
import { handleStructuredToolCall } from '../tool-handler.js';

/** Register local simulation; the service owns authorization and the atomic write. */
export const registerExecuteChangeTool: McpToolRegistrar = (server, context) => {
  const executionService = new ExecutionService(context.database);

  server.registerTool(
    'execute_change',
    {
      title: 'Execute approved fictional change',
      description:
        'Simulate an existing proposal after an authenticated CLI reviewer has approved it. This call cannot approve a proposal. Requires a proposal ID and idempotency key; returns the fictional result, resource version, execution ID, and audit event ID.',
      annotations: { readOnlyHint: false, openWorldHint: false },
      inputSchema: executeChangeInputSchema,
      outputSchema: executeChangeOutputSchema,
    },
    (input) =>
      handleStructuredToolCall(
        input,
        executeChangeInputSchema,
        executeChangeOutputSchema,
        (request) => executionService.executeChange(context.actor, request),
      ),
  );
};
