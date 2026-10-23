# Permission-aware material bulk actions

`POST /api/creator/materials/bulk-action` accepts one explicit action and a
bounded list of material `_id` values. The endpoint requires the
`creator:manage` permission and checks ownership and current lifecycle state
for every record; it never turns a broad filter into a mutation.

Preview an operation first:

```json
{
  "action": "archive",
  "recordIds": ["507f1f77bcf86cd799439011"],
  "dryRun": true
}
```

The response reports an eligible count and a per-record reason for each
selection. It performs no data writes. When at least one record is eligible,
the response includes a short-lived `confirmationToken` bound to the actor,
action, exact selected IDs, and record revisions.

Execute by sending the same `action` and `recordIds`, `dryRun: false`, and the
returned token. The framework rechecks eligibility and revision for every
record and reports `applied` or a per-record failure. Records changed since
preview are skipped as `stale_selection`; only records eligible at preview
can be applied. Each token is single-use.

Set `BULK_ACTION_TOKEN_SECRET` to a unique secret of at least 32 characters
before using the endpoint. There is no built-in fallback secret. The current
registered operations are `archive` and `restore`; each updates the material
with an optimistic concurrency check and refreshes the search projection and
catalog cache.

Validate with:

```bash
node --test tests/backend/bulk-action-framework.test.mjs
```
