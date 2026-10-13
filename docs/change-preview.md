# Fictional change previews

`src/domain/change.ts` owns the two allowed simulated actions: `resize_compute` to a named demo size and `disable_compute`. It accepts no scripts, commands, free-form sizes, or storage change action. The MCP input schema re-exports the same action contract so tools and application code cannot drift into separate allowlists.

| Demo size | Synthetic monthly cost estimate |
| --- | ---: |
| `demo-small` | 5,000 cents |
| `demo-medium` | 10,000 cents |
| `demo-large` | 15,000 cents |

These fixed values are invented examples shared across fictional providers. They are not cloud prices, measured bills, or savings forecasts. `src/application/change-preview.ts` uses them only for validated compute resources. A resize changes the cost estimate but leaves the fictional CPU estimate unchanged because no workload model exists. A disable preview sets both estimates to zero only when the compute resource is nonproduction and its CPU estimate is exactly zero. Protected resources and storage kinds are rejected. The preview requires the caller's expected version to match the supplied resource snapshot, leaves that version and all identity fields unchanged, and makes no write. A production resize can be previewed, but the separate policy service denies its proposal; policy checks, independent review, and version-checked execution remain separate gates.
