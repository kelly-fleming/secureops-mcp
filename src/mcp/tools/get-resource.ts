import { ResourceService } from '../../application/resource-service.js';
import { SqliteResourceRepository } from '../../infra/sqlite/resource-repository.js';
import { getResourceInputSchema, getResourceOutputSchema } from '../schemas.js';
import type { McpToolRegistrar } from '../server.js';
import { handleStructuredToolCall } from '../tool-handler.js';

/** Register a read-only detail view for one synthetic resource ID. */
export const registerGetResourceTool: McpToolRegistrar = (server, context) => {
  const resourceService = new ResourceService(new SqliteResourceRepository(context.database));

  server.registerTool(
    'get_resource',
    {
      title: 'Get fictional cloud resource',
      description:
        'Inspect one synthetic resource by ID, including current version, tags, estimated monthly cost, utilization, and governance flags.',
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: getResourceInputSchema,
      outputSchema: getResourceOutputSchema,
    },
    (input) =>
      handleStructuredToolCall(
        input,
        getResourceInputSchema,
        getResourceOutputSchema,
        (request) => resourceService.getResource(context.actor, request),
        { logger: context.logger, operation: 'get_resource' },
      ),
  );
};
