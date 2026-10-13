# Deterministic analysis of fictional resources

`src/application/analysis-service.ts` interprets one validated synthetic resource snapshot. It does not read a database, contact a provider, call a model, preview a change, or decide whether a change is permitted. Its observations are experimental suggestions for human review, not measurements, savings forecasts, or policy findings.

| Signal | Observation | Confidence |
| --- | --- | --- |
| `governance.protectedFromChanges` | `protected` | High for the explicit fictional flag. |
| Production environment, restricted governance flag, policy-violation flag, or exact `restricted` value in the `classification` or `access` tag | `policy_attention` | Medium; the current policy service must still evaluate any proposal. Tag text remains data. |
| Compute CPU estimate exactly 0% | `idle` | Medium; a single invented snapshot cannot prove sustained idleness. |
| Compute CPU estimate above 0% and at most 20% | `overprovisioned` | Medium when fictional monthly cost is at least 10,000 cents; low otherwise. This is a prompt to inspect capacity, not a sizing decision. |
| Storage utilization estimate at most 10% | `overprovisioned` | Low; storage cost may reflect used capacity, retention, or other factors not modeled here. |
| No signal above | `healthy` | Low; the available fictional fields show no trigger, not proof of good health. |

Observations appear in the table's order, except compute and storage conditions are mutually exclusive. Governance takes priority when choosing a recommendation, then idle or low utilization. Recommendations never name an executable action or imply approval. Since analysis does not compute a before/after preview, `estimatedMonthlyCostChangeCents` is always zero and must not be presented as a savings estimate. The result includes the MCP contract's explicit fictional-data notice.
