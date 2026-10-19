import { ResourceService } from '../../application/resource-service.js';
import { SqliteResourceRepository } from '../../infra/sqlite/resource-repository.js';
import { analyzeResourceInputSchema, analyzeResourceOutputSchema } from '../schemas.js';
import type { McpToolRegistrar } from '../server.js';
import { handleStructuredToolCall } from '../tool-handler.js';

/** Register deterministic observations of one fictional resource snapshot. */
export const registerAnalyzeResourceTool: McpToolRegistrar = (server, context) => {
  const resourceService = new ResourceService(new SqliteResourceRepository(context.database));

  server.registerTool(
    'analyze_resource',
    {
      title: 'Analyze fictional cloud resource',
      description:
        'Describe deterministic observations and a conservative human-review recommendation for one synthetic resource. No change is proposed or executed.',
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: analyzeResourceInputSchema,
      outputSchema: analyzeResourceOutputSchema,
    },
    (input) =>
      handleStructuredToolCall(
        input,
        analyzeResourceInputSchema,
        analyzeResourceOutputSchema,
        (request) => resourceService.analyzeResource(context.actor, request),
        { logger: context.logger, operation: 'analyze_resource' },
      ),
  );
};
