# Synthetic demo resources

`fixtures/resources.json` contains twelve original, fictional resources. It is an inventory for local demonstrations, not data from any AWS, Azure, or GCP account. The `demo/...` provider resource IDs, owner names, tags, utilization figures, and cost estimates were invented for this repository. No cloud credentials or live provider calls are involved.

## Inventory and ordering

The array is ordered by application `id`, with two examples of each supported kind:

| Provider | Kinds | Count |
| --- | --- | ---: |
| AWS | EC2 instance, S3 bucket | 4 |
| Azure | Virtual machine, storage account | 4 |
| GCP | Compute instance, Cloud Storage bucket | 4 |

The application `id` is a stable local key. `providerResourceId` is a visibly synthetic, provider-labeled identifier and must never be used to contact a real provider. Every initial `version` is `1`; later simulated writes must use the version check and increment rules in `src/domain/resource.ts`.

## Demo scenarios

| Resource ID | Scenario |
| --- | --- |
| `res-aws-ec2-01`, `res-gcp-compute-01` | Idle compute examples with a 0% CPU estimate. |
| `res-aws-s3-01`, `res-azure-vm-01`, `res-gcp-cloud-storage-01` | Underused examples with low storage or CPU estimates. |
| `res-azure-vm-02`, `res-gcp-compute-02` | Well-utilized compute examples. |
| `res-aws-ec2-02`, `res-gcp-cloud-storage-02` | Protected production examples. |
| `res-aws-s3-02` | A restricted access tag and matching governance flag. |
| `res-azure-storage-01` | A fictional missing-retention marker and policy-violation flag. |

The scenario flags are fixture inputs for local policy and workflow experiments. They do not themselves grant approval or implement an allow/deny decision. The policy service evaluates requests using current resource state.

`monthlyCostEstimateCents` is an invented monthly estimate in integer cents, not a bill or a savings claim. `utilizationEstimate.percent` is an invented 0-100 percentage: `cpu` for compute kinds and `storage` for storage kinds. These figures are examples for deterministic analysis, not measurements or operational advice.

## Use by the demo seeder

Treat this JSON file as read-only source data. `src/infra/sqlite/seed.ts` validates each entry with `resourceSchema` before copying it into the selected local SQLite database. The `db:seed` and `db:reset` commands are documented in `docs/seed-reset.md`. Preserve IDs and order for reproducible demos. Any simulated resource change belongs in the database and its audit workflow; it must not rewrite the checked-in fixture. Do not mix customer inventories, actual account identifiers, or secrets into this file.
