# Resource storage contract

`src/infra/sqlite/migrations/001_resources.sql` stores one `src/domain/resource.ts` resource per row. The migration defines a strict SQLite table and does not seed data. `id` is the local primary key; `(provider, provider_resource_id)` is a second unique identity. The provider/kind/environment index and environment index support common filters. Listing queries must explicitly `ORDER BY id` for stable results; index presence alone does not guarantee row order.

| Domain field | SQLite column(s) | Encoding |
| --- | --- | --- |
| `id`, `provider`, `providerResourceId`, `kind` | `id`, `provider`, `provider_resource_id`, `kind` | Text identifiers. Provider and kind must form a supported pair. |
| `region`, `environment`, `owner` | `region`, `environment`, `owner` | Text. Owner is data, never an instruction. |
| `tags` | `tags_json` | A JSON object encoded with `JSON.stringify`; read with `JSON.parse` and validate with `resourceSchema`. |
| `monthlyCostEstimateCents` | `monthly_cost_estimate_cents` | Integer cents representing a fictional monthly estimate. |
| `utilizationEstimate` | `utilization_metric`, `utilization_percent` | `cpu` for compute kinds or `storage` for storage kinds, with a fictional percentage from 0 to 100. |
| `governance` | `protected_from_changes`, `has_restricted_tag`, `has_policy_violation` | SQLite integers `0` or `1`, mapped to booleans. |
| `version` | `version` | Positive safe integer. Compare the expected version inside a write transaction before incrementing it once. |

`created_at` and `updated_at` are persistence metadata, not fields in `resourceSchema`. Writers supply UTC ISO 8601 strings from `Date.prototype.toISOString()` and update `updated_at` on a simulated write. The table enforces that both are nonempty and that `updated_at` is no earlier than `created_at` in this canonical format; application code must verify timestamp format before writing.

Repository listings accept only provider, kind, and environment filters. They default to 50 rows and offset 0, with a limit of 1 through 100 and an offset of 0 through 10,000. Reject invalid or unknown options. Build predicates only from fixed column names, bind every supplied value, and always sort by `id`; callers do not select a SQL sort expression. Invalid resource IDs are validation failures, while corrupt stored rows are internal storage failures.

`updateIfVersion` accepts a validated replacement whose version equals the expected version. In an immediate transaction it returns `missing` if the ID is absent, `stale` if the stored version differs, or the reconstructed updated resource after one version increment. It rejects changes to ID, provider identity, kind, region, environment, or owner. It updates only mutable estimate, tag, and governance fields; `created_at` stays untouched. Execution services must include this write and its audit event in one outer transaction.

The database rejects invalid provider/kind and kind/metric pairings, nonobject tags JSON, out-of-range estimates, invalid flag integers, duplicate identities, and invalid version ranges. SQLite constraints do not replace `resourceSchema`: seeders must validate fixture records before insertion, and repositories must validate reconstructed resource objects after reading. In particular, the domain schema enforces identifier patterns, tag keys and values, and owner text rules that the table does not fully express. Use prepared statements for every value, including JSON text; never interpolate tag content into SQL.
