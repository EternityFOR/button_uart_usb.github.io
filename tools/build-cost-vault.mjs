import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { webcrypto } from "node:crypto";
import path from "node:path";

const DEFAULT_ITERATIONS = 210000;
const DEFAULT_TOLERANCE = 0.0001;
const PUBLIC_ID_PATTERN = /^product-[a-z0-9-]+$/;
const PUBLIC_LABEL_PATTERN = /^Product [A-Z0-9]+$/;
const COST_SCOPES = new Set(["pre-delivery-cash", "post-sale-support-reserve", "fixed-launch-investment"]);

const sourcePath = process.argv[2] || ".private/products";
const outputPath = process.argv[3] || "data/cost-vault.json";

const productEntries = await loadProducts(sourcePath);
if (!productEntries.length) {
  throw new Error("No products found. Add .json files under .private/products.");
}

const publicProducts = [];
const publicIds = new Set();
for (const entry of productEntries) {
  const product = normalizeProduct(entry.product);
  if (publicIds.has(product.publicId)) throw new Error(`Duplicate public product id: ${product.publicId}`);
  publicIds.add(product.publicId);
  normalizeProductData(product.data, entry.sourceFile, Boolean(entry.product.canonicalRecord));
  validateProductData(product.data, entry.sourceFile);
  await validateCanonicalRecord(entry.product.canonicalRecord, product.data, entry.sourceFile);
  publicProducts.push(product);
}
publicProducts.sort((a, b) => a.publicId.localeCompare(b.publicId, "en"));

const vault = {
  version: 1,
  kdf: {
    name: "PBKDF2",
    hash: "SHA-256",
    iterations: DEFAULT_ITERATIONS
  },
  products: []
};

for (const product of publicProducts) {
  const salt = webcrypto.getRandomValues(new Uint8Array(16));
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(product.accessCode, salt, vault.kdf.iterations);
  const plaintext = new TextEncoder().encode(JSON.stringify(product.data));
  const ciphertext = new Uint8Array(await webcrypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext));

  vault.products.push({
    id: product.publicId,
    label: product.publicLabel,
    salt: toBase64(salt),
    iv: toBase64(iv),
    ciphertext: toBase64(ciphertext)
  });
}

await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(vault, null, 2)}\n`, "utf8");
console.log(`Wrote ${path.resolve(outputPath)} with ${vault.products.length} encrypted product(s).`);

function normalizeProduct(product) {
  const publicId = String(product.publicId || "").trim();
  const publicLabel = String(product.publicLabel || "").trim();
  if (!publicId || !publicLabel || !product.accessCode || !product.data) {
    throw new Error("Each product needs publicId, publicLabel, accessCode, and data.");
  }
  if (!PUBLIC_ID_PATTERN.test(publicId)) {
    throw new Error(`Public id must be generic, like product-a: ${publicId}`);
  }
  if (!PUBLIC_LABEL_PATTERN.test(publicLabel)) {
    throw new Error(`Public label must be generic, like Product A: ${publicLabel}`);
  }
  return { publicId, publicLabel, accessCode: product.accessCode, data: product.data };
}

function normalizeProductData(data, sourceFile, requireExplicitCostScope) {
  assertObject(data, sourceFile, "data");
  const compatibilityAliases = data.compatibilityAliases && typeof data.compatibilityAliases === "object" && !Array.isArray(data.compatibilityAliases)
    ? data.compatibilityAliases
    : {};
  const legacyTargetMargin = compatibilityAliases.targetNetMargin ?? data.targetNetMargin ?? data.targetMargin;
  data.targetFirstLaunchProjectProfitMargin = data.targetFirstLaunchProjectProfitMargin ?? legacyTargetMargin ?? 30;
  const remainingCompatibilityAliases = { ...compatibilityAliases };
  delete remainingCompatibilityAliases.targetNetMargin;
  if (Object.keys(remainingCompatibilityAliases).length) data.compatibilityAliases = remainingCompatibilityAliases;
  else delete data.compatibilityAliases;
  delete data.targetNetMargin;
  delete data.targetMargin;
  data.salesFeeRate = data.salesFeeRate ?? 0;
  data.fixedLaunchCost = data.fixedLaunchCost ?? 0;
  if (!Array.isArray(data.categories)) return;

  for (const category of data.categories) {
    if (!category.costScope) {
      if (requireExplicitCostScope) {
        fail(sourceFile, `Category ${category.id || "<missing-id>"} needs an explicit costScope when canonicalRecord is configured.`);
      }
      category.costScope = "pre-delivery-cash";
    }
    for (const group of category.groups || []) {
      for (const item of group.items || []) {
        item.qty = item.qty ?? 0;
        item.lossRate = item.lossRate ?? 0;
        item.processCost = item.processCost ?? 0;
        for (const supplier of item.suppliers || []) {
          supplier.pricingMode ||= supplier.note === "batch" ? "batch" : "unit";
          supplier.price = supplier.price ?? 0;
          supplier.shipping = supplier.shipping ?? 0;
          supplier.moq = supplier.moq ?? 0;
        }
      }
    }
  }
}

function validateProductData(data, sourceFile) {
  assertObject(data, sourceFile, "data");
  assertPositiveInteger(data.batchQty, sourceFile, "data.batchQty");
  assertPercentageAtMost(
    data.targetFirstLaunchProjectProfitMargin,
    60,
    sourceFile,
    "data.targetFirstLaunchProjectProfitMargin"
  );
  assertPercentageAtMost(data.salesFeeRate, 30, sourceFile, "data.salesFeeRate");
  assertNonNegativeNumber(data.fixedLaunchCost, sourceFile, "data.fixedLaunchCost");
  if (Number(data.targetFirstLaunchProjectProfitMargin) + Number(data.salesFeeRate) >= 100) {
    fail(sourceFile, "data.targetFirstLaunchProjectProfitMargin + data.salesFeeRate must be below 100%.");
  }
  if (!Array.isArray(data.categories) || !data.categories.length) {
    fail(sourceFile, "data.categories must be a non-empty array.");
  }

  const categoryIds = new Set();
  for (const [categoryIndex, category] of data.categories.entries()) {
    const categoryPath = `data.categories[${categoryIndex}]`;
    assertObject(category, sourceFile, categoryPath);
    assertNonEmptyString(category.id, sourceFile, `${categoryPath}.id`);
    if (categoryIds.has(category.id)) fail(sourceFile, `Duplicate category id: ${category.id}`);
    categoryIds.add(category.id);
    if (!COST_SCOPES.has(category.costScope)) {
      fail(sourceFile, `${categoryPath}.costScope must be pre-delivery-cash, post-sale-support-reserve, or fixed-launch-investment.`);
    }
    if (!Array.isArray(category.groups)) fail(sourceFile, `${categoryPath}.groups must be an array.`);

    for (const [groupIndex, group] of category.groups.entries()) {
      const groupPath = `${categoryPath}.groups[${groupIndex}]`;
      assertObject(group, sourceFile, groupPath);
      if (!Array.isArray(group.items)) fail(sourceFile, `${groupPath}.items must be an array.`);

      for (const [itemIndex, item] of group.items.entries()) {
        const itemPath = `${groupPath}.items[${itemIndex}]`;
        assertObject(item, sourceFile, itemPath);
        assertNonNegativeNumber(item.qty, sourceFile, `${itemPath}.qty`);
        assertNonNegativeNumber(item.lossRate, sourceFile, `${itemPath}.lossRate`);
        assertNonNegativeNumber(item.processCost, sourceFile, `${itemPath}.processCost`);
        if (!Array.isArray(item.suppliers) || !item.suppliers.length) {
          fail(sourceFile, `${itemPath}.suppliers must be a non-empty array.`);
        }
        if (item.chosenSupplierId && !item.suppliers.some((supplier) => supplier.id === item.chosenSupplierId)) {
          fail(sourceFile, `${itemPath}.chosenSupplierId does not match a supplier.`);
        }

        for (const [supplierIndex, supplier] of item.suppliers.entries()) {
          const supplierPath = `${itemPath}.suppliers[${supplierIndex}]`;
          assertObject(supplier, sourceFile, supplierPath);
          if (supplier.pricingMode !== "unit" && supplier.pricingMode !== "batch") {
            fail(sourceFile, `${supplierPath}.pricingMode must be unit or batch.`);
          }
          assertNonNegativeNumber(supplier.price, sourceFile, `${supplierPath}.price`);
          assertNonNegativeNumber(supplier.shipping, sourceFile, `${supplierPath}.shipping`);
          assertNonNegativeNumber(supplier.moq, sourceFile, `${supplierPath}.moq`);
        }
      }
    }
  }
}

async function validateCanonicalRecord(record, data, sourceFile) {
  if (record == null) return;
  const canonicalRecord = typeof record === "string" ? { path: record } : record;
  assertObject(canonicalRecord, sourceFile, "canonicalRecord");
  assertNonEmptyString(canonicalRecord.path, sourceFile, "canonicalRecord.path");
  if (path.isAbsolute(canonicalRecord.path)) {
    fail(sourceFile, "canonicalRecord.path must be relative to the private product source file.");
  }

  const tolerance = canonicalRecord.tolerance == null
    ? DEFAULT_TOLERANCE
    : Number(canonicalRecord.tolerance);
  if (!Number.isFinite(tolerance) || tolerance <= 0) {
    fail(sourceFile, "canonicalRecord.tolerance must be a positive number.");
  }

  const canonicalPath = path.resolve(path.dirname(sourceFile), canonicalRecord.path);
  const canonical = await readJson(canonicalPath);
  assertObject(canonical, canonicalPath, "canonical finance model");
  assertNonEmptyString(canonical.currency, canonicalPath, "currency");
  assertPositiveNumber(canonical.batchQuantity, canonicalPath, "batchQuantity");
  assertNonNegativeNumber(canonical.fixedLaunchInvestment, canonicalPath, "fixedLaunchInvestment");
  assertRate(canonical.salesChannelDeductionRate, canonicalPath, "salesChannelDeductionRate");
  const canonicalTargetProjectProfitMarginRate = Number(
    canonical.targetFirstLaunchProjectProfitMarginRate
      ?? canonical.compatibilityAliases?.targetFirstLaunchProjectNetMarginRate
      ?? canonical.targetFirstLaunchProjectNetMarginRate
  );
  assertRate(canonicalTargetProjectProfitMarginRate, canonicalPath, "targetFirstLaunchProjectProfitMarginRate");
  assertNonNegativeNumber(canonical.recommendedPublicUnitPrice, canonicalPath, "recommendedPublicUnitPrice");
  if (!Array.isArray(canonical.costComponents) || !canonical.costComponents.length) {
    fail(canonicalPath, "costComponents must be a non-empty array.");
  }

  assertClose(data.batchQty, canonical.batchQuantity, tolerance, sourceFile, "batch quantity");
  if (normalizeCurrency(data.currency) !== normalizeCurrency(canonical.currency)) {
    fail(sourceFile, `currency differs from the canonical finance model: ${data.currency} != ${canonical.currency}.`);
  }
  assertClose(Number(data.salesFeeRate) / 100, canonical.salesChannelDeductionRate, tolerance, sourceFile, "sales channel deduction rate");
  assertClose(
    Number(data.targetFirstLaunchProjectProfitMargin) / 100,
    canonicalTargetProjectProfitMarginRate,
    tolerance,
    sourceFile,
    "target first-launch project profit margin rate"
  );
  assertClose(data.fixedLaunchCost, canonical.fixedLaunchInvestment, tolerance, sourceFile, "fixed launch investment");

  const financials = calculateFinancials(data);
  const unitCategories = data.categories.filter((category) => category.costScope !== "fixed-launch-investment");
  const componentById = new Map(canonical.costComponents.map((component) => [component.id, component]));
  if (componentById.size !== canonical.costComponents.length) {
    fail(canonicalPath, "costComponents ids must be unique.");
  }
  if (componentById.size !== unitCategories.length) {
    fail(sourceFile, "Planner recurring-cost categories and canonical costComponents must contain the same ids.");
  }

  for (const category of unitCategories) {
    const component = componentById.get(category.id);
    if (!component) fail(sourceFile, `Canonical cost component missing for category ${category.id}.`);
    if (component.costScope !== category.costScope) {
      fail(sourceFile, `Cost scope mismatch for category ${category.id}.`);
    }
    assertNonNegativeNumber(component.unitAmount, canonicalPath, `costComponents.${category.id}.unitAmount`);
    assertClose(
      financials.categoryUnitCosts.get(category.id),
      component.unitAmount,
      tolerance,
      sourceFile,
      `category ${category.id} unit cost`
    );
  }

  const canonicalFixedComponents = canonical.fixedLaunchComponents || [];
  if (!Array.isArray(canonicalFixedComponents) || !canonicalFixedComponents.length) {
    fail(canonicalPath, "fixedLaunchComponents must be a non-empty array when the planner has fixed-launch details.");
  }
  const fixedComponentById = new Map(canonicalFixedComponents.map((component) => [component.id, component]));
  if (fixedComponentById.size !== canonicalFixedComponents.length) {
    fail(canonicalPath, "fixedLaunchComponents ids must be unique.");
  }
  const fixedGroups = data.categories
    .filter((category) => category.costScope === "fixed-launch-investment")
    .flatMap((category) => category.groups || []);
  if (fixedComponentById.size !== fixedGroups.length) {
    fail(sourceFile, "Planner fixed-launch groups and canonical fixedLaunchComponents must contain the same ids.");
  }
  for (const group of fixedGroups) {
    const component = fixedComponentById.get(group.id);
    if (!component) fail(sourceFile, `Canonical fixed-launch component missing for group ${group.id}.`);
    assertNonNegativeNumber(component.amount, canonicalPath, `fixedLaunchComponents.${group.id}.amount`);
    const groupAmount = group.items.reduce(
      (sum, item) => sum + itemUnitCost(data, item) * Number(data.batchQty),
      0
    );
    assertClose(groupAmount, component.amount, tolerance, sourceFile, `fixed-launch group ${group.id}`);

    if (component.items != null) {
      if (!Array.isArray(component.items)) fail(canonicalPath, `fixedLaunchComponents.${group.id}.items must be an array.`);
      const canonicalItems = new Map(component.items.map((item) => [item.id, item]));
      if (canonicalItems.size !== component.items.length || canonicalItems.size !== group.items.length) {
        fail(sourceFile, `Fixed-launch items differ for group ${group.id}.`);
      }
      for (const item of group.items) {
        const canonicalItem = canonicalItems.get(item.id);
        if (!canonicalItem) fail(sourceFile, `Canonical fixed-launch item missing for ${item.id}.`);
        assertNonNegativeNumber(canonicalItem.amount, canonicalPath, `fixedLaunchComponents.${group.id}.${item.id}.amount`);
        assertClose(
          itemUnitCost(data, item) * Number(data.batchQty),
          canonicalItem.amount,
          tolerance,
          sourceFile,
          `fixed-launch item ${item.id}`
        );
      }
    }
  }
  assertClose(
    financials.fixedLaunchInvestmentFromCategories,
    canonical.fixedLaunchInvestment,
    tolerance,
    sourceFile,
    "fixed-launch category total"
  );

  assertClose(
    financials.recommendedRetailUnitPrice,
    canonical.recommendedPublicUnitPrice,
    tolerance,
    sourceFile,
    "recommended public unit price"
  );

  if (canonical.benchmarkResults != null) {
    assertObject(canonical.benchmarkResults, canonicalPath, "benchmarkResults");
    const benchmarkFields = [
      "unitPreDeliveryFulfillmentCost",
      "expectedUnitAfterSalesSupportCost",
      "unitFulfillmentCost",
      "batchPreDeliveryFulfillmentCost",
      "batchFulfillmentCost",
      "unitAllocatedFixedLaunchInvestment",
      "unitFirstLaunchFullCost",
      "firstLaunchProjectFullCost",
      "minimumAverageSellingPrice"
    ];
    for (const field of benchmarkFields) {
      assertNonNegativeNumber(canonical.benchmarkResults[field], canonicalPath, `benchmarkResults.${field}`);
      assertClose(financials[field], canonical.benchmarkResults[field], tolerance, sourceFile, field);
    }
  }
}

function calculateFinancials(data) {
  const batchQuantity = Number(data.batchQty);
  const categoryUnitCosts = new Map();
  let unitPreDeliveryFulfillmentCost = 0;
  let expectedUnitAfterSalesSupportCost = 0;
  let unitFulfillmentCost = 0;
  let fixedLaunchInvestmentFromCategories = 0;

  for (const category of data.categories) {
    const categoryUnitCost = category.groups.reduce(
      (categoryTotal, group) => categoryTotal + group.items.reduce(
        (groupTotal, item) => groupTotal + itemUnitCost(data, item),
        0
      ),
      0
    );
    categoryUnitCosts.set(category.id, categoryUnitCost);
    if (category.costScope === "fixed-launch-investment") {
      fixedLaunchInvestmentFromCategories += categoryUnitCost * batchQuantity;
    } else if (category.costScope === "post-sale-support-reserve") {
      expectedUnitAfterSalesSupportCost += categoryUnitCost;
      unitFulfillmentCost += categoryUnitCost;
    } else {
      unitPreDeliveryFulfillmentCost += categoryUnitCost;
      unitFulfillmentCost += categoryUnitCost;
    }
  }

  const batchPreDeliveryFulfillmentCost = unitPreDeliveryFulfillmentCost * batchQuantity;
  const batchFulfillmentCost = unitFulfillmentCost * batchQuantity;
  const fixedLaunchInvestment = fixedLaunchInvestmentFromCategories || Number(data.fixedLaunchCost);
  const unitAllocatedFixedLaunchInvestment = fixedLaunchInvestment / batchQuantity;
  const unitFirstLaunchFullCost = unitFulfillmentCost + unitAllocatedFixedLaunchInvestment;
  const firstLaunchProjectFullCost = batchFulfillmentCost + fixedLaunchInvestment;
  const costCoverageRate = 1 - Number(data.targetFirstLaunchProjectProfitMargin) / 100 - Number(data.salesFeeRate) / 100;
  const minimumAverageSellingPrice = firstLaunchProjectFullCost / costCoverageRate / batchQuantity;
  return {
    categoryUnitCosts,
    unitPreDeliveryFulfillmentCost,
    expectedUnitAfterSalesSupportCost,
    unitFulfillmentCost,
    batchPreDeliveryFulfillmentCost,
    batchFulfillmentCost,
    fixedLaunchInvestmentFromCategories,
    unitAllocatedFixedLaunchInvestment,
    unitFirstLaunchFullCost,
    firstLaunchProjectFullCost,
    minimumAverageSellingPrice,
    recommendedRetailUnitPrice: roundRetailPrice(minimumAverageSellingPrice)
  };
}

function itemUnitCost(data, item) {
  const supplier = item.suppliers.find((entry) => entry.id === item.chosenSupplierId) || item.suppliers[0];
  const supplierCost = supplier.pricingMode === "batch"
    ? Number(supplier.price) / Number(data.batchQty) + Number(supplier.shipping)
    : Number(item.qty) * (1 + Number(item.lossRate) / 100) * Number(supplier.price) + Number(supplier.shipping);
  return supplierCost + Number(item.processCost);
}

function roundRetailPrice(value) {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.ceil((value + 1) / 10) * 10 - 1;
}

function normalizeCurrency(value) {
  const currency = String(value || "").trim().toUpperCase();
  if (currency === "HK$") return "HKD";
  if (currency === "$" || currency === "US$") return "USD";
  if (currency === "¥" || currency === "RMB") return "CNY";
  return currency;
}

function assertObject(value, sourceFile, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(sourceFile, `${field} must be an object.`);
  }
}

function assertNonEmptyString(value, sourceFile, field) {
  if (typeof value !== "string" || !value.trim()) fail(sourceFile, `${field} must be a non-empty string.`);
}

function assertPositiveNumber(value, sourceFile, field) {
  if (!Number.isFinite(Number(value)) || Number(value) <= 0) fail(sourceFile, `${field} must be a positive number.`);
}

function assertPositiveInteger(value, sourceFile, field) {
  if (!Number.isInteger(Number(value)) || Number(value) <= 0) fail(sourceFile, `${field} must be a positive integer.`);
}

function assertNonNegativeNumber(value, sourceFile, field) {
  if (!Number.isFinite(Number(value)) || Number(value) < 0) fail(sourceFile, `${field} must be a non-negative number.`);
}

function assertPercentageAtMost(value, maximum, sourceFile, field) {
  if (!Number.isFinite(Number(value)) || Number(value) < 0 || Number(value) > maximum) {
    fail(sourceFile, `${field} must be a percentage from 0 through ${maximum}.`);
  }
}

function assertRate(value, sourceFile, field) {
  if (!Number.isFinite(Number(value)) || Number(value) < 0 || Number(value) >= 1) {
    fail(sourceFile, `${field} must be a decimal rate from 0 up to but not including 1.`);
  }
}

function assertClose(actual, expected, tolerance, sourceFile, field) {
  if (Math.abs(Number(actual) - Number(expected)) > tolerance) {
    fail(sourceFile, `${field} differs from the canonical finance model: ${actual} != ${expected}.`);
  }
}

function fail(sourceFile, message) {
  throw new Error(`${path.resolve(sourceFile)}: ${message}`);
}

async function loadProducts(source) {
  const sourceStat = await safeStat(source);
  if (!sourceStat) throw new Error(`Source path not found: ${source}`);

  if (sourceStat.isDirectory()) {
    const names = await readdir(source);
    const files = names.filter((name) => name.toLowerCase().endsWith(".json")).sort();
    const entries = await Promise.all(files.map(async (name) => loadProductFile(path.join(source, name))));
    return entries.flat();
  }

  return loadProductFile(source);
}

async function loadProductFile(file) {
  const value = await readJson(file);
  const products = Array.isArray(value.products) ? value.products : [value];
  return products.map((product) => ({ product, sourceFile: file }));
}

async function readJson(file) {
  const text = await readFile(file, "utf8");
  return JSON.parse(text.replace(/^\uFEFF/, ""));
}

async function safeStat(file) {
  try {
    return await stat(file);
  } catch {
    return null;
  }
}

async function deriveKey(accessCode, salt, iterations) {
  const keyMaterial = await webcrypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(accessCode),
    "PBKDF2",
    false,
    ["deriveKey"]
  );

  return webcrypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"]
  );
}

function toBase64(bytes) {
  return Buffer.from(bytes).toString("base64");
}
