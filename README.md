# DeDge Cost Planner

Diractive Edge internal cost planning tool. The public page loads encrypted product data from `data/cost-vault.json` and unlocks it in the browser with an access code.

Public metadata must stay generic. The vault dropdown may only show labels such as `Product A` and `Product B`; it must not expose product names, launch names, campaign names, supplier clues, or project-specific identifiers. Real product names and cost details belong only in `.private/products/` and are encrypted into `data/cost-vault.json` by the build script.

## Layout

```text
index.html                 Main page entry
cost-planner.html          Backup entry, kept in sync with index.html
data/cost-vault.json       Encrypted cost vault
tools/                     Local maintenance scripts
workers/                   Cloudflare Worker sync API source
.private/products/         Private product sources
.private/access-codes.txt  Access code record
```

## Maintenance Flow

1. Keep one private source file per product under `.private/products/<product-id>.json`.
2. Each private source must define generic public fields: `publicId` like `product-a`, and `publicLabel` like `Product A`.
3. Never put real product names in `publicId`, `publicLabel`, README, page text, or other committed public metadata.
4. After adding or updating a product, run:

```bash
node tools/build-cost-vault.mjs
```

5. Commit the generated `data/cost-vault.json`, page files, and tool scripts.
6. Access codes are recorded at `.private/access-codes.txt`.

Local preview:

```bash
node tools/dev-server.mjs
```
