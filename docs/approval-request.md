# Requesting independent approval

`src/application/approval-request-service.ts` accepts a strict request only from an issued actor with `request_approval` capability. The agent may request review only for its own draft. A duplicate request conflicts; the method does not add a second pending transition.

Inside one immediate SQLite transaction, the service loads the validated proposal and exact fictional resource, checks the resource's current version against the draft, rebuilds the synthetic action preview, and evaluates the current policy. A stale version or newly denied policy leaves the proposal in `draft`. A successful request changes only status, update time, and the validated justification. The original resource, requested action, reason, version, key, and policy snapshot stay unchanged.

`pending_approval` means a human review is needed. The response names the interactive `proposals:review` CLI command, run from the project root, with the proposal ID and a placeholder for the same local database's absolute path. It reveals no configured path or credential. The request creates no decision row and grants no execution authority. An independently authenticated reviewer must make a separate decision; later services must recheck policy and resource version again. The justification is untrusted display text and never a command or approval credential.

The proposal repository can list `pending_approval` rows as a storage primitive. That query does not authenticate the reader. The local `proposals:list` command authenticates a reviewer before its queue service returns pending proposals; `proposals:review` authenticates again before a separate decision. The queue service requires `review_proposals` and rechecks the enabled identity.

The service and repositories share one configured connection. The successful status transition and safe `approval_requested` audit append run in the same immediate transaction, so either both persist or both roll back. The audit payload omits the untrusted justification.
