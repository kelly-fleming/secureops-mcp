import type { z } from 'zod';

import { analyzeResource as analyzeResourceSnapshot } from './analysis-service.js';
import { InternalError, NotFoundError, ValidationError } from '../domain/errors.js';
import { resourceSchema, type Resource } from '../domain/resource.js';
import type { ResourceListOptions } from '../infra/sqlite/resource-repository.js';
import {
  analyzeResourceInputSchema,
  analyzeResourceOutputSchema,
  getResourceInputSchema,
  getResourceOutputSchema,
  listResourcesInputSchema,
  listResourcesOutputSchema,
} from '../mcp/schemas.js';
import { requireCapability, type ActorContext } from '../security/permissions.js';

type DeepReadonly<T> = T extends readonly (infer Item)[]
  ? readonly DeepReadonly<Item>[]
  : T extends object
    ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
    : T;

export type ResourceListResult = DeepReadonly<z.infer<typeof listResourcesOutputSchema>>;
export type ResourceDetailResult = DeepReadonly<z.infer<typeof getResourceOutputSchema>>;
export type ResourceAnalysisResult = DeepReadonly<z.infer<typeof analyzeResourceOutputSchema>>;

/** Only read operations are available to this application service. */
export interface ResourceReader {
  getById(id: string): Resource | null;
  list(options: ResourceListOptions): readonly Resource[];
}

function deepFreeze<T>(value: T): DeepReadonly<T> {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value as DeepReadonly<T>;
}

export class ResourceService {
  constructor(private readonly reader: ResourceReader) {}

  /** Fail closed if a stored resource is invalid or differs from the requested ID. */
  private readValidatedResource(resourceId: string): Resource {
    const resource = this.reader.getById(resourceId);
    if (resource === null) throw new NotFoundError();
    const parsedResource = resourceSchema.safeParse(resource);
    if (!parsedResource.success || parsedResource.data.id !== resourceId) {
      throw new InternalError();
    }
    return parsedResource.data;
  }

  listResources(actor: ActorContext, input: unknown = {}): ResourceListResult {
    requireCapability(actor, 'list_resources');
    const parsedInput = listResourcesInputSchema.safeParse(input);
    if (!parsedInput.success) throw new ValidationError();

    const summaries = this.reader.list(parsedInput.data).map((resource) => {
      const parsedResource = resourceSchema.safeParse(resource);
      if (!parsedResource.success) throw new InternalError();
      const current = parsedResource.data;
      return {
        id: current.id,
        provider: current.provider,
        kind: current.kind,
        region: current.region,
        environment: current.environment,
        owner: current.owner,
        monthlyCostEstimateCents: current.monthlyCostEstimateCents,
        version: current.version,
      };
    });
    const parsedOutput = listResourcesOutputSchema.safeParse({ resources: summaries });
    if (!parsedOutput.success) throw new InternalError();
    return deepFreeze(parsedOutput.data);
  }

  getResource(actor: ActorContext, input: unknown): ResourceDetailResult {
    requireCapability(actor, 'get_resource');
    const parsedInput = getResourceInputSchema.safeParse(input);
    if (!parsedInput.success) throw new ValidationError();

    const resource = this.readValidatedResource(parsedInput.data.resourceId);
    const parsedOutput = getResourceOutputSchema.safeParse({ resource });
    if (!parsedOutput.success) throw new InternalError();
    return deepFreeze(parsedOutput.data);
  }

  analyzeResource(actor: ActorContext, input: unknown): ResourceAnalysisResult {
    requireCapability(actor, 'analyze_resource');
    const parsedInput = analyzeResourceInputSchema.safeParse(input);
    if (!parsedInput.success) throw new ValidationError();

    const resource = this.readValidatedResource(parsedInput.data.resourceId);
    const analysis = analyzeResourceSnapshot(resource);
    const parsedOutput = analyzeResourceOutputSchema.safeParse(analysis);
    if (!parsedOutput.success) throw new InternalError();
    return deepFreeze(parsedOutput.data);
  }
}
