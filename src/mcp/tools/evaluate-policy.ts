import { PolicyPreviewService } from '../../application/policy-preview-service.js';
import { SqliteResourceRepository } from '../../infra/sqlite/resource-repository.js';
import { evaluatePolicyInputSchema, evaluatePolicyOutputSchema } from '../schemas.js';
import type { McpToolRegistrar } from '../server.js';
import { handleStructuredToolCall } from '../tool-handler.js';

/** Register a local-only, read-only preview of policy findings for a fictional change. */
export const registerEvaluatePolicyTool: McpToolRegistrar = (server, context) => {
  const policyPreviewService = new PolicyPreviewService(
    new SqliteResourceRepository(context.database),
  );

  server.registerTool(
    'evaluate_policy',
    {
      title: 'Evaluate fictional change policy',
      description:
        'Preview an allowlisted change and current governance findings for one synthetic resource. Eligibility does not approve, propose, or execute a change.',
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: evaluatePolicyInputSchema,
      outputSchema: evaluatePolicyOutputSchema,
    },
    (input) =>
      handleStructuredToolCall(
        input,
        evaluatePolicyInputSchema,
        evaluatePolicyOutputSchema,
        (request) => policyPreviewService.evaluatePolicy(context.actor, request),
        { logger: context.logger, operation: 'evaluate_policy' },
      ),
  );
};
