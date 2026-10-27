# Walkthrough media

Eight PNG screenshots from an automated fictional workflow are supplied below and embedded in the [walkthrough](../demo-walkthrough.md). Seven capture the actual MCP Inspector UI. `04-cli-approved.png` renders the real CLI's final stdout confirmation in a labeled browser panel; it is not a screenshot of an interactive terminal window. No video or GIF is required or supplied. The [sample payloads](../../examples/sample-tool-results.json) remain authored illustrations, separate from the captured results.

## Capture record

- Capture date: 2026-10-27, approximately 08:24 America/New_York (12:24 UTC).
- Checkout: `9adaaaf985d4f291f0a4c167c8083a2d0fe586bd`, with the new media and documentation changes uncommitted. Existing operator screenshots under `examples/` were preserved.
- Environment: Docker Linux containers, Node v24.21.0, SecureOps MCP v0.2.0; local MCP Inspector v2.12.0 with the structured-error display fix; Playwright driving headless Microsoft Edge on Windows. Browser result text was enlarged to 16 px, duplicate structured output was collapsed, and viewport heights were adjusted to fit each result. Result values were not edited.
- Scenario: a freshly seeded, isolated fictional database; resource `res-aws-ec2-01`; action `disable_compute`; policy `demo-v1`; proposal `proposal-e96985db-7d31-420d-a9b3-efb196674f59`. The operator's normal Docker database and pending proposal were not used or reset.
- Observed checks: version-1 baseline; policy assessment; draft and pending transitions; pending execution refused with `PRECONDITION_FAILED`; real CLI enrollment and authentication through a Linux pseudoterminal with an ephemeral in-memory credential; automated approval; one simulated execution to version 2; identical completed retry; five ordered restricted audit summaries. All capture assertions passed. Every final image was visually reviewed for readability and privacy.
- Limits: review input was automated. These captures are not independent human acceptance, evidence of real cloud savings, audit-chain verification, or a GitHub CI result. The full test suite was not rerun during capture. Detailed local records remain in the ignored verification log.

| File | Actual captured content |
| --- | --- |
| [01-idle-resource.png](01-idle-resource.png) | Version 1, zero CPU utilization, fictional monthly estimate of 6,900 cents. |
| [01b-idle-analysis.png](01b-idle-analysis.png) | Idle observation and analysis's zero estimated cost change. |
| [02-policy-review-required.png](02-policy-review-required.png) | Seven findings, required review, and the advisory preview. |
| [03-pending-approval.png](03-pending-approval.png) | The returned proposal ID and pending approval status. |
| [03b-pending-execution-blocked.png](03b-pending-execution-blocked.png) | Execution refused before the CLI decision. |
| [04-cli-approved.png](04-cli-approved.png) | Labeled rendering of the actual authenticated CLI approval confirmation. |
| [05-simulated-execution.png](05-simulated-execution.png) | Committed version 2 and fictional cost changing from 6,900 cents to zero. |
| [06-workflow-audit.png](06-workflow-audit.png) | Five restricted workflow summaries for the same proposal. |

## Future capture guidance

For a future capture, use only the disposable fictional database. Show the idle resource, policy findings, pending approval, a separate authenticated CLI decision, simulated version change and restricted audit trace. Keep all panels on the same database and substitute actual returned IDs. A rejected example must remain rejected; never splice a different proposal's successful execution into it. Do not reset midway through the workflow.

Keep passphrase prompts and enrollment out of recordings, even when masking is enabled. Exclude local usernames, filesystem paths, terminal history, environment dumps, Inspector URL tokens and unrelated windows. Prefer the restricted MCP audit summaries when showing workflow evidence. Review each frame before publication; do not place raw captures containing secrets in Git history.

Use readable text and provide alt text describing the actual frame. A short GIF should have a static alternative and a prose description of the steps. Label synthetic estimates as fictional, and avoid captions implying real provider savings or measured performance.

For any media added later, accompany it with the capture date, checkout identifier, Docker or host environment, exact scenario and checks actually run with their outcomes. State omissions and distinguish automated terminal smoke evidence from independent human acceptance. Generated illustrative IDs or this checklist cannot serve as execution evidence. Keep personal acceptance records in the existing ignored verification log, not in public media captions. An independently reviewed human capture remains separate from this automated demonstration.
