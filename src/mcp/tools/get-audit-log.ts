import { AgentAuditService } from '../../application/agent-audit-service.js';
import { getAuditLogInputSchema, getAuditLogOutputSchema } from '../schemas.js';
import type { McpToolRegistrar } from '../server.js';
import { handleStructuredToolCall } from '../tool-handler.js';

/** Register a local-only trace of safe, fixed workflow summaries. */
export const registerGetAuditLogTool: McpToolRegistrar = (server, context) => {
  const auditService = new AgentAuditService(context.database);

  server.registerTool(
    'get_audit_log',
    {
      title: 'Read fictional workflow audit trace',
      description:
        'Read a bounded page of redacted proposal workflow events, optionally filtered by one fictional proposal or resource. A trace does not verify audit-chain integrity or grant review authority.',
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: getAuditLogInputSchema,
      outputSchema: getAuditLogOutputSchema,
    },
    (input) =>
      handleStructuredToolCall(input, getAuditLogInputSchema, getAuditLogOutputSchema, (request) =>
        auditService.getAuditLog(context.actor, request),
      ),
  );
};
