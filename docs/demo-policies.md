# Fictional governance policy

`config/demo-policies.json` is the versioned input for the local simulated-change policy. Every rule has a stable ID, a rationale, a severity, and an effect: `deny` for a failed guard or `require_approval` for a review prerequisite. Severity describes the finding and never overrides its effect. These are experimental rules for fictional resources, not cloud account controls or compliance certification. Change the version when changing rule meaning or thresholds so proposal policy snapshots can be compared with the current policy.

| Rule ID | Input and outcome |
| --- | --- |
| `deny_production` | Deny when `resource.environment` is `production`. |
| `deny_restricted` | Deny when `resource.governance.hasRestrictedTag` is true or a configured tag key has the exact value `restricted`. Tag text is data, never instructions. |
| `deny_protected` | Deny when `resource.governance.protectedFromChanges` is true. |
| `require_owner` | Deny when the normalized `resource.owner` label is absent or blank. The domain resource shape uses this field as its canonical owner metadata. The immutable fixtures do not duplicate it in `tags.owner`; the rule checks the canonical field, not a literal tag-map entry. Validated resources already require a nonempty owner, so this guard also protects policy evaluation if unvalidated data reaches it. |
| `allow_actions` | Deny any action outside `resize_compute` and `disable_compute`. This allowlist does not establish that an allowed action is valid for a particular resource. |
| `limit_cost_increase` | Deny when `after.monthlyCostEstimateCents - before.monthlyCostEstimateCents` exceeds 5,000 cents. A decrease is within this cap. The values are fictional monthly estimates, not bills or measured savings. |
| `require_human_approval` | Mark every otherwise eligible modification as requiring a separate authenticated reviewer decision before execution. A model-supplied approval claim never satisfies this rule. |

Evaluation must fail closed when the policy document, resource, action, cost preview, or required attributes cannot be validated. `allowed` means only that no deny rule blocks a proposal from requesting review. The approval finding and `approvalRequired` field state an independent prerequisite for execution, including on a denied evaluation; they do not override a denial, record a reviewer decision, or permit execution. Findings stay in policy order. Before a simulated write, the execution service must re-evaluate current policy and resource state, verify the persisted approved decision and expected resource version, and do so inside the write transaction. A matching version string alone does not prove that policy content is unchanged or that the proposed change is still allowed.
