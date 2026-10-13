import { ValidationError } from '../domain/errors.js';
import { resourceSchema, type Resource } from '../domain/resource.js';

const simulationNotice = 'Fictional demo data; estimates are not real bills or savings.';
const lowComputeCpuPercent = 20;
const lowStorageUtilizationPercent = 10;
const notableMonthlyCostCents = 10_000;

export interface AnalysisObservation {
  readonly code: 'idle' | 'overprovisioned' | 'protected' | 'policy_attention' | 'healthy';
  readonly confidence: 'low' | 'medium' | 'high';
  readonly message: string;
}

export interface ResourceAnalysis {
  readonly resourceId: Resource['id'];
  readonly observations: readonly AnalysisObservation[];
  readonly estimatedMonthlyCostChangeCents: 0;
  readonly recommendation: string;
  readonly simulationNotice: typeof simulationNotice;
}

function observation(
  code: AnalysisObservation['code'],
  confidence: AnalysisObservation['confidence'],
  message: string,
): AnalysisObservation {
  return Object.freeze({ code, confidence, message });
}

/** Interpret one fictional snapshot without authorizing or previewing a change. */
export function analyzeResource(input: unknown): ResourceAnalysis {
  const parsed = resourceSchema.safeParse(input);
  if (!parsed.success) throw new ValidationError();

  const resource = parsed.data;
  const observations: AnalysisObservation[] = [];
  const hasPolicyAttention =
    resource.environment === 'production' ||
    resource.governance.hasRestrictedTag ||
    resource.governance.hasPolicyViolation ||
    resource.tags.classification === 'restricted' ||
    resource.tags.access === 'restricted';

  if (resource.governance.protectedFromChanges) {
    observations.push(
      observation(
        'protected',
        'high',
        'This fictional resource is marked as protected from changes.',
      ),
    );
  }
  if (hasPolicyAttention) {
    observations.push(
      observation(
        'policy_attention',
        'medium',
        'A governance label needs a separate policy review.',
      ),
    );
  }

  if (resource.utilizationEstimate.metric === 'cpu') {
    const cpuPercent = resource.utilizationEstimate.percent;
    if (cpuPercent === 0) {
      observations.push(
        observation('idle', 'medium', 'The fictional CPU estimate is zero in this snapshot.'),
      );
    } else if (cpuPercent <= lowComputeCpuPercent) {
      const confidence =
        resource.monthlyCostEstimateCents >= notableMonthlyCostCents ? 'medium' : 'low';
      observations.push(
        observation(
          'overprovisioned',
          confidence,
          'Low fictional CPU use suggests reviewing capacity.',
        ),
      );
    }
  } else if (resource.utilizationEstimate.percent <= lowStorageUtilizationPercent) {
    observations.push(
      observation(
        'overprovisioned',
        'low',
        'Low fictional storage use suggests reviewing capacity and retention.',
      ),
    );
  }

  if (observations.length === 0) {
    observations.push(
      observation(
        'healthy',
        'low',
        'No utilization or governance trigger appears in this fictional snapshot.',
      ),
    );
  }

  let recommendation = 'No adjustment is indicated by this fictional snapshot.';
  if (resource.governance.protectedFromChanges) {
    recommendation =
      'Consult the resource owner before considering any change to this protected example.';
  } else if (hasPolicyAttention) {
    recommendation = 'Review the governance label and current policy before considering a change.';
  } else if (observations.some((item) => item.code === 'idle')) {
    recommendation =
      'Confirm sustained idleness with the owner before considering a simulated proposal.';
  } else if (observations.some((item) => item.code === 'overprovisioned')) {
    recommendation =
      'Review the fictional capacity estimate with the owner before considering a simulated proposal.';
  }

  return Object.freeze({
    resourceId: resource.id,
    observations: Object.freeze(observations),
    estimatedMonthlyCostChangeCents: 0,
    recommendation,
    simulationNotice,
  });
}
