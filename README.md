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

## Finance Synchronization

The matching `00_Office/projects/<project>/finance_model.json` record is the source of truth for management-accounting terminology and benchmark values. A private product source may opt into strict synchronization with a record whose path is relative to that private product file:

```json
{
  "canonicalRecord": {
    "path": "../../../../00_Office/projects/<project>/finance_model.json",
    "tolerance": 0.0001
  }
}
```

When `canonicalRecord` is present, `node tools/build-cost-vault.mjs` verifies the batch quantity, sales-channel deduction rate, target first-launch project profit margin, fixed launch investment, category ids, category cost scopes, category unit amounts, canonical benchmark results, and recommended public unit price before writing the encrypted vault. A mismatch stops the build.

Private product data uses `targetFirstLaunchProjectProfitMargin` as the canonical percentage field. Older `targetNetMargin` and `targetMargin` values are accepted only while importing legacy data; new session data, JSON exports, cloud records, and vault builds write only the canonical field.

Every cost category uses one of these scope codes:

- `pre-delivery-cash`: unit pre-delivery fulfillment cost (`单位交付前履约成本`)
- `post-sale-support-reserve`: expected unit after-sales support cost (`单位售后支持预计成本`)

Their sum is unit fulfillment cost (`单位履约成本`). Fixed launch investment is then allocated across the planned batch; unit fulfillment cost plus that allocation is unit first-launch full cost (`单位首发完全成本`). Legacy private products without `canonicalRecord` remain compatible: missing finance fields receive the existing UI defaults, and categories without a scope are treated as `pre-delivery-cash` during the build. Canonically synchronized products must declare every category scope explicitly.

The standard first-launch calculation bridge is:

```text
gross pledge revenue
- batch fulfillment cost
= management product gross profit
- sales-channel deductions
= product contribution profit
- fixed launch investment
= first-launch project profit (management basis)
```

First-launch project profit margin is first-launch project profit divided by gross pledge revenue. It is a management-planning measure, not statutory company net profit. JSON and CSV exports include the same calculated bridge and terminology version; calculated JSON summaries are regenerated on export and are not imported as source data.

Local preview:

```bash
node tools/dev-server.mjs
```
