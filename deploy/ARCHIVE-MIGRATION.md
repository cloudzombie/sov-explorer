# Archive migration and rollback

The Explorer archive is `/var/lib/sovereign-explorer/<network>.sqlite`. Schema
changes are additive; token/NFT/contract/HTLC and expanded account indexes are derived
from canonical block/transaction records and can be rebuilt. Chain identity remains
pinned in `meta.chain_id` and `meta.genesis_hash`.

## Consistent pre-release snapshot

Stop the Explorer so no writer can race the snapshot, checkpoint WAL, verify the
database, copy it, and restart immediately:

```sh
systemctl stop sovereign-explorer
/opt/node24/bin/node --input-type=module -e '
  import { DatabaseSync } from "node:sqlite";
  const db = new DatabaseSync("/var/lib/sovereign-explorer/mainnet.sqlite");
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  const result = db.prepare("PRAGMA integrity_check").get();
  if (result.integrity_check !== "ok") throw new Error(JSON.stringify(result));
  db.close();
'
install -o root -g root -m 0600 \
  /var/lib/sovereign-explorer/mainnet.sqlite \
  /var/lib/sovereign-explorer/mainnet.sqlite.pre-release-YYYYMMDDTHHMMSSZ
systemctl start sovereign-explorer
curl --fail 'http://127.0.0.1:8080/healthz?network=mainnet&archive=1'
```

Keep the snapshot outside the archive writer's filename pattern. Record its checksum
and never copy only the main file while an active WAL writer is running.

## Application-only rollback

The prior Explorer binary can read a database containing the additive tables/columns;
it ignores them. Prefer rolling back the application release without rolling back
canonical archive data, then confirm health and historical links.

## Database rollback

Use only for a failed/corrupt migration. This discards blocks indexed after the
snapshot; the Explorer will re-fetch them from its identity-pinned relays.

```sh
systemctl stop sovereign-explorer
mv /var/lib/sovereign-explorer/mainnet.sqlite \
  /var/lib/sovereign-explorer/mainnet.sqlite.failed-YYYYMMDDTHHMMSSZ
rm -f /var/lib/sovereign-explorer/mainnet.sqlite-wal \
  /var/lib/sovereign-explorer/mainnet.sqlite-shm
install -o explorer -g explorer -m 0640 \
  /var/lib/sovereign-explorer/mainnet.sqlite.pre-release-YYYYMMDDTHHMMSSZ \
  /var/lib/sovereign-explorer/mainnet.sqlite
systemctl start sovereign-explorer
```

Then verify `/healthz?network=mainnet&archive=1`, genesis block `0`, a known historical
transaction, `PRAGMA integrity_check`, chain identity metadata, and contiguous archive
bounds. Do not delete the failed database until the replacement is proven complete.
