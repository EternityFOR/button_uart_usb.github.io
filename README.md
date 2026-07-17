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

When `canonicalRecord` is present, `node tools/build-cost-vault.mjs` verifies the batch quantity, sales-channel deduction rate, target first-launch project profit margin, recurring-cost category ids and amounts, structured fixed-launch component groups and items, canonical benchmark results, and recommended public unit price before writing the encrypted vault. A mismatch stops the build.

Private product data uses `targetFirstLaunchProjectProfitMargin` as the canonical percentage field. Older `targetNetMargin` and `targetMargin` values are accepted only while importing legacy data; new session data, JSON exports, cloud records, and vault builds write only the canonical field.

Every cost category uses one of these scope codes:

- `pre-delivery-cash`: unit pre-delivery fulfillment cost (`单位交付前履约成本`)
- `post-sale-support-reserve`: expected unit after-sales support cost (`单位售后支持预计成本`)
- `fixed-launch-investment`: batch-level release, validation, compliance, IP, and proof costs (`首发固定投入`)
- `sales-channel-deduction`: percentage deductions from product revenue, such as platform and payment-processing fees (`销售渠道扣减`)
- `budget-context`: covered, pass-through, deferred, conditional, paid, company-level, or unpriced statutory references that must remain visible without entering the current cost formula (`预算边界与备选路线`)

The first two scopes sum to unit fulfillment cost (`单位履约成本`). Fixed-launch groups are batch amounts and are divided by the planned batch only when calculating the unit allocation; they never enter unit fulfillment cost. Unit fulfillment cost plus that allocation is unit first-launch full cost (`单位首发完全成本`). Sales-channel deductions enter the minimum-selling-price and project-profit equations as a percentage of product revenue. Budget-context rows are never silently added to the current model.

For products with `canonicalRecord`, the vault builder also reads `00_Office/registers/budget_items.csv`. It injects the active revenue deductions and every remaining product, release-signing, website, IP, company-setup, and company-operations budget row that is not already represented by a fixed-launch detail. Unit-model references, covered items, pass-through shipping, deferred or alternative routes, paid records, company-level costs, and the canonical model's still-unpriced tax/statutory boundaries therefore remain auditable without double counting. Legacy private products without `canonicalRecord` remain compatible: missing finance fields receive the existing UI defaults, and categories without a scope are treated as `pre-delivery-cash` during the build. Canonically synchronized products must declare every source category scope explicitly.

## Local Unlock Preference

The `记住本机` option stores only the last successful public product id and access code in that browser's local storage. It is never included in cloud-sync documents. `清除解锁` removes both the decrypted session data and the saved local access code. Use the option only in a trusted browser profile because any person with access to that profile can open developer tools and read local storage.

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
