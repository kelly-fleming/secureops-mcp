import { ResourceService } from '../../application/resource-service.js';
import { SqliteResourceRepository } from '../../infra/sqlite/resource-repository.js';
import { listResourcesInputSchema, listResourcesOutputSchema } from '../schemas.js';
import type { McpToolRegistrar } from '../server.js';
import { handleStructuredToolCall } from '../tool-handler.js';

/** Register a read-only view of bounded fictional resource summaries. */
export const registerListResourcesTool: McpToolRegistrar = (server, context) => {
  const resourceService = new ResourceService(new SqliteResourceRepository(context.database));

  server.registerTool(
    'list_resources',
    {
      title: 'List fictional cloud resources',
      description:
        'List paged synthetic AWS, Azure, and GCP resources. Filter by provider, kind, or environment; costs are fictional monthly estimates.',
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: listResourcesInputSchema,
      outputSchema: listResourcesOutputSchema,
    },
    (input) =>
      handleStructuredToolCall(
        input,
        listResourcesInputSchema,
        listResourcesOutputSchema,
        (filters) => resourceService.listResources(context.actor, filters),
        { logger: context.logger, operation: 'list_resources' },
      ),
  );
};
