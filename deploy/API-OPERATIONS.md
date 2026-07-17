# Paid API operations

This runbook applies only to the Sovereign Explorer API service.

## Key registry

- Set `API_KEYS_FILE=/etc/sov-explorer.api-keys.json` through `deploy/api.conf`.
- Own the registry as `root:explorer`, mode `0640`. It contains key identifiers,
  plans, expiry, quota, enabled state, and SHA-256 digests — never raw secrets.
- Deliver a create/rotate secret through the billing/customer secret channel once.
  Do not paste it into tickets, URLs, shell history, logs, or metrics.
- Keep the generated secret in a root-only `0600` handoff file only until delivery,
  then remove the handoff file.

## Provision and rotate

```sh
/opt/node24/bin/node /opt/sov-explorer/app/scripts/api-key.mjs create \
  --file /etc/sov-explorer.api-keys.json --id customer --plan pro --rpm 1200 \
  --expires 2027-07-01T00:00:00Z
chown root:explorer /etc/sov-explorer.api-keys.json
chmod 0640 /etc/sov-explorer.api-keys.json
systemctl kill --signal=HUP sovereign-explorer
```

Use `rotate` with the same id to invalidate the old secret immediately after reload.
Use `revoke` for cancellation or compromise. `list` never prints hashes or secrets.

## Verification

```sh
# Anonymous envelope succeeds.
curl -i 'https://sovxus.org/api/v1/mainnet/transactions?limit=50'

# Paid boundary fails closed without a key.
curl -i 'https://sovxus.org/api/v1/mainnet/transactions?limit=51'

# Paid request succeeds and returns quota headers.
curl -i -H "X-API-Key: $SOV_EXPLORER_API_KEY" \
  'https://sovxus.org/api/v1/mainnet/transactions?limit=200'
```

Expected boundary errors are `402 paid_api_key_required`, `401 invalid_api_key`, and
`429 key_rate_limit_exceeded`. Every response has `X-Request-Id` and `X-API-Tier`;
keyed responses also have limit, remaining, and reset headers.

## Incident response

1. Revoke or rotate the affected id.
2. Restore `root:explorer 0640` ownership after the atomic key-file replacement.
3. Send `SIGHUP` and confirm the service logs only the count of loaded records.
4. Verify the old key returns 401 and the replacement returns quota headers.
5. Inspect tier/outcome metrics; no key id, hash, or secret is a metrics label.

If the registry is missing or unreadable, service startup/reload fails rather than
silently opening paid features. Anonymous reads remain bounded by the documented
envelope when the registry is intentionally unset in development.
