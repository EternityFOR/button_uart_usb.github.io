import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { webcrypto } from "node:crypto";
import path from "node:path";

const DEFAULT_ITERATIONS = 210000;
const DEFAULT_TOLERANCE = 0.0001;
const PUBLIC_ID_PATTERN = /^product-[a-z0-9-]+$/;
const PUBLIC_LABEL_PATTERN = /^Product [A-Z0-9]+$/;
const COST_SCOPE_PRE_DELIVERY = "pre-delivery-cash";
const COST_SCOPE_POST_SALE = "post-sale-support-reserve";
const COST_SCOPE_FIXED_LAUNCH = "fixed-launch-investment";
const COST_SCOPE_CHANNEL_DEDUCTION = "sales-channel-deduction";
const COST_SCOPE_BUDGET_CONTEXT = "budget-context";
const COST_SCOPES = new Set([
  COST_SCOPE_PRE_DELIVERY,
  COST_SCOPE_POST_SALE,
  COST_SCOPE_FIXED_LAUNCH,
  COST_SCOPE_CHANNEL_DEDUCTION,
  COST_SCOPE_BUDGET_CONTEXT
]);
const UNIT_COST_SCOPES = new Set([COST_SCOPE_PRE_DELIVERY, COST_SCOPE_POST_SALE]);
const PRODUCT_BUDGET_PROJECTS = new Set(["flashlink", "signing-release", "company-website"]);
const IP_BUDGET_PROJECTS = new Set(["ip-patent"]);
const COMPANY_BUDGET_PROJECTS = new Set(["company-setup", "company-ops"]);
const OFFICE_BUDGET_PROJECTS = new Set([
  ...PRODUCT_BUDGET_PROJECTS,
  ...IP_BUDGET_PROJECTS,
  ...COMPANY_BUDGET_PROJECTS
]);
const CHANNEL_DEDUCTION_BUDGET_IDS = new Set(["BUD-0030", "BUD-0031"]);
const UNIT_MODEL_BUDGET_IDS = new Set(["BUD-0019", "BUD-0032"]);
const MODEL_BOUNDARY_DEFINITIONS = new Map([
  [
    "tax and import handling not yet quoted",
    {
      id: "unquoted-tax-import",
      name: "尚未报价的税费与进口处理",
      status: "unquoted",
      dueStage: "目标市场、税务责任与进口路径冻结后",
      relationship: "unpriced-model-boundary",
      note: "报价尚未冻结，当前不作为已确认项目成本；一旦发生，必须回到完整模型重新计算。"
    }
  ],
  [
    "company income tax and statutory accounting adjustments",
    {
      id: "statutory-profit-adjustments",
      name: "所得税与法定会计调整",
      status: "statutory-adjustment",
      dueStage: "形成法定账目、应税利润与正式税务判断后",
      relationship: "statutory-model-boundary",
      note: "当前项目利润是管理口径，不等于法定财务报表中的公司净利润或纯利。"
    }
  ]
]);

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
  await injectOfficeBudgetCategories(product.data, entry.sourceFile, entry.product.canonicalRecord);
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

async function injectOfficeBudgetCategories(data, sourceFile, canonicalRecord) {
  if (canonicalRecord == null) return;
  const record = typeof canonicalRecord === "string" ? { path: canonicalRecord } : canonicalRecord;
  assertObject(record, sourceFile, "canonicalRecord");
  assertNonEmptyString(record.path, sourceFile, "canonicalRecord.path");
  const canonicalPath = path.resolve(path.dirname(sourceFile), record.path);
  const canonical = await readJson(canonicalPath);
  const budgetPath = path.resolve(path.dirname(canonicalPath), "../../registers/budget_items.csv");
  const budgetRows = await readCsvObjects(budgetPath);
  const relevantRows = budgetRows
    .filter((row) => OFFICE_BUDGET_PROJECTS.has(String(row.project_id || "").trim()))
    .sort((left, right) => String(left.budget_id).localeCompare(String(right.budget_id), "en"));
  const budgetById = new Map(relevantRows.map((row) => [String(row.budget_id || "").trim(), row]));

  for (const budgetId of CHANNEL_DEDUCTION_BUDGET_IDS) {
    if (!budgetById.has(budgetId)) fail(budgetPath, `Required channel-deduction budget row is missing: ${budgetId}`);
  }

  const fixedPrimaryBudgetIds = new Set(
    (canonical.fixedLaunchComponents || []).flatMap((component) =>
      (component.items || []).map((item) => String(item.budgetIds?.[0] || "").trim()).filter(Boolean)
    )
  );
  const representedBudgetIds = new Set(fixedPrimaryBudgetIds);
  const contextRows = relevantRows.filter((row) => {
    const budgetId = String(row.budget_id || "").trim();
    return !representedBudgetIds.has(budgetId) && !CHANNEL_DEDUCTION_BUDGET_IDS.has(budgetId);
  });
  const productContextRows = contextRows.filter((row) =>
    PRODUCT_BUDGET_PROJECTS.has(String(row.project_id || "").trim())
  );
  const ipContextRows = contextRows.filter((row) =>
    IP_BUDGET_PROJECTS.has(String(row.project_id || "").trim())
  );
  const companyContextRows = contextRows.filter((row) =>
    COMPANY_BUDGET_PROJECTS.has(String(row.project_id || "").trim())
  );
  const modelBoundaryItems = buildModelBoundaryItems(canonical, canonicalPath);

  data.categories = data.categories.filter((category) =>
    ![
      "sales-channel-deduction",
      "office-budget-context",
      "ip-budget-context",
      "company-budget-context"
    ].includes(category.id)
  );
  data.categories.push(buildChannelDeductionCategory(budgetById));
  data.categories.push(buildBudgetContextCategory(productContextRows));
  data.categories.push(buildIpBudgetContextCategory(ipContextRows));
  data.categories.push(buildCompanyBudgetContextCategory(companyContextRows, modelBoundaryItems));
  for (const category of data.categories) {
    category.collapsed = true;
    for (const group of category.groups) {
      group.collapsed = true;
      for (const item of group.items) item.collapsed = true;
    }
  }
}

function buildChannelDeductionCategory(budgetById) {
  const platform = buildOfficeBudgetItem(budgetById.get("BUD-0030"), "channel-deduction");
  platform.rateMode = "fixed";
  platform.ratePercent = 5;
  const processing = buildOfficeBudgetItem(budgetById.get("BUD-0031"), "channel-deduction");
  processing.rateMode = "remainder";
  processing.ratePercent = 0;
  return {
    id: "sales-channel-deduction",
    name: "销售渠道扣减",
    costScope: COST_SCOPE_CHANNEL_DEDUCTION,
    note: "按产品收入扣减，已进入最低平均售价和项目利润公式；不是额外叠加的单位履约成本。",
    collapsed: true,
    groups: [
      {
        id: "crowdfunding-channel-fees",
        name: "众筹平台与支付处理",
        note: "Kickstarter 平台费固定 5%；支付处理使用总扣减率扣除平台费后的余额。",
        collapsed: true,
        items: [platform, processing]
      }
    ]
  };
}

function buildBudgetContextCategory(rows) {
  const definitions = [
    {
      id: "covered-or-included",
      name: "已覆盖、已计入或无费用",
      note: "在现有生产、验证或支持预算中已经覆盖，不能再次加总。",
      statuses: new Set(["closed", "covered", "included-in-manufacturing", "included-in-unit-cost"])
    },
    {
      id: "shipping-pass-through",
      name: "客户运费转付",
      note: "运费向客户另收；只有出现垫付时间差时才建立现金缓冲。",
      statuses: new Set(["shipping-pass-through"])
    },
    {
      id: "conditional-or-deferred",
      name: "条件性、备选与递延路线",
      note: "只有触发市场、认证、签名或供应商条件后才进入当前成本。",
      statuses: null
    },
    {
      id: "paid-or-shared",
      name: "已支付或公司共享费用",
      note: "保留可追溯性，但不作为本次首发项目新增成本重复计入。",
      statuses: new Set(["paid"])
    }
  ];
  const grouped = new Map(definitions.map((definition) => [definition.id, []]));
  for (const row of rows) {
    const budgetId = String(row.budget_id || "").trim();
    const status = String(row.status || "").trim();
    const includedInCurrentModel = UNIT_MODEL_BUDGET_IDS.has(budgetId);
    const target = (includedInCurrentModel ? definitions[0] : null)
      || definitions.find((definition) => definition.statuses?.has(status))
      || definitions.find((definition) => definition.id === "conditional-or-deferred");
    grouped.get(target.id).push(buildOfficeBudgetItem(
      row,
      includedInCurrentModel ? "included-in-current-model" : target.id
    ));
  }
  return {
    id: "office-budget-context",
    name: "产品预算边界与备选路线",
    costScope: COST_SCOPE_BUDGET_CONTEXT,
    note: "同步产品、发布签名与网站预算；已计入、已覆盖、客户另付及条件路线均分层展示。",
    collapsed: true,
    groups: definitions
      .map((definition) => ({
        id: definition.id,
        name: definition.name,
        note: definition.note,
        collapsed: true,
        items: grouped.get(definition.id)
      }))
      .filter((group) => group.items.length)
  };
}

function buildIpBudgetContextCategory(rows) {
  const paidOrPrerequisiteIds = new Set(["BUD-0008", "BUD-0038"]);
  const laterHongKongRouteIds = new Set(["BUD-0006", "BUD-0034"]);
  const groups = [
    {
      id: "ip-paid-or-personal-prerequisite",
      name: "已支付与个人身份前置",
      note: "保留付款和电子提交前置记录，不回加到本次产品成本。",
      relationship: "paid-or-personal-prerequisite",
      rows: rows.filter((row) => paidOrPrerequisiteIds.has(String(row.budget_id || "").trim()))
    },
    {
      id: "ip-later-hong-kong-route",
      name: "香港后续审查与专业服务",
      note: "属于后续法定期限或权利要求策略，不作为本次首发固定投入重复计入。",
      relationship: "later-ip-route",
      rows: rows.filter((row) => laterHongKongRouteIds.has(String(row.budget_id || "").trim()))
    },
    {
      id: "ip-alternative-territory-route",
      name: "替代申请与海外扩展路线",
      note: "只有首申地或目标市场策略改变后才触发，不能与当前香港主线直接相加。",
      relationship: "alternative-ip-route",
      rows: rows.filter((row) => {
        const budgetId = String(row.budget_id || "").trim();
        return !paidOrPrerequisiteIds.has(budgetId) && !laterHongKongRouteIds.has(budgetId);
      })
    }
  ];
  return {
    id: "ip-budget-context",
    name: "知识产权路线预算",
    costScope: COST_SCOPE_BUDGET_CONTEXT,
    note: "将已支付前置、香港后续程序和海外替代路线与当前首发成本分开。",
    collapsed: true,
    groups: groups
      .filter((group) => group.rows.length)
      .map((group) => ({
        id: group.id,
        name: group.name,
        note: group.note,
        collapsed: true,
        items: group.rows.map((row) => buildOfficeBudgetItem(row, group.relationship))
      }))
  };
}

function buildCompanyBudgetContextCategory(rows, modelBoundaryItems) {
  const groups = [
    {
      id: "company-setup-boundary",
      name: "主体设立费用",
      note: "注册地址、秘书服务、注册与商业登记属于主体层成本，当前未分摊到本产品。",
      relationship: "company-level-not-allocated",
      rows: rows.filter((row) => String(row.project_id || "").trim() === "company-setup")
    },
    {
      id: "company-operations-boundary",
      name: "持续运营期间费用",
      note: "薪酬、周年申报、商业登记续期、记账与审计属于期间费用，当前未分摊到本产品。",
      relationship: "company-level-not-allocated",
      rows: rows.filter((row) => String(row.project_id || "").trim() === "company-ops")
    }
  ];
  if (modelBoundaryItems.length) {
    groups.push({
      id: "unpriced-and-statutory-boundary",
      name: "未定税费与法定调整",
      note: "当前没有可确认金额，只保留模型边界；取得报价或法定结论后再纳入相应层级。",
      relationship: "",
      rows: [],
      items: modelBoundaryItems
    });
  }
  return {
    id: "company-budget-context",
    name: "主体与法定费用边界",
    costScope: COST_SCOPE_BUDGET_CONTEXT,
    note: "产品项目成本与主体设立、期间费用、所得税及法定调整分层，避免误算为单位成本。",
    collapsed: true,
    groups: groups
      .filter((group) => group.rows.length || group.items?.length)
      .map((group) => ({
        id: group.id,
        name: group.name,
        note: group.note,
        collapsed: true,
        items: group.items || group.rows.map((row) => buildOfficeBudgetItem(row, group.relationship))
      }))
  };
}

function buildModelBoundaryItems(canonical, canonicalPath) {
  const exclusions = Array.isArray(canonical.excludedFromProfitModel)
    ? canonical.excludedFromProfitModel.map((value) => String(value || "").trim())
    : [];
  return exclusions
    .map((value) => MODEL_BOUNDARY_DEFINITIONS.get(value))
    .filter(Boolean)
    .map((definition) => buildModelBoundaryItem(definition, canonical, canonicalPath));
}

function buildModelBoundaryItem(definition, canonical, canonicalPath) {
  const supplierId = `model-boundary-${definition.id}`;
  return {
    id: definition.id,
    name: definition.name,
    designator: "财务模型边界",
    footprint: definition.status,
    qty: 1,
    unit: "边界项",
    lossRate: 0,
    processCost: 0,
    note: definition.note,
    chosenSupplierId: supplierId,
    collapsed: true,
    budgetReference: {
      referenceKind: "model-boundary",
      budgetId: "",
      projectId: "flashlink",
      category: "excluded-from-profit-model",
      status: definition.status,
      currency: String(canonical.currency || "").trim(),
      lowEstimate: 0,
      highEstimate: 0,
      dueStage: definition.dueStage,
      sourceOrBasis: path.relative(process.cwd(), canonicalPath).replaceAll("\\", "/"),
      notes: definition.note,
      relationship: definition.relationship
    },
    suppliers: [
      {
        id: supplierId,
        name: "Office 权威财务模型",
        sku: definition.id,
        model: definition.status,
        price: 0,
        shipping: 0,
        moq: 1,
        pricingMode: "unit",
        note: "未计量的模型边界；金额确认后必须回到权威记录并重新构建。"
      }
    ]
  };
}

function buildOfficeBudgetItem(row, relationship) {
  const budgetId = String(row.budget_id || "").trim();
  const supplierId = `office-${budgetId.toLowerCase()}`;
  return {
    id: `office-budget-${budgetId.toLowerCase()}`,
    name: String(row.item || budgetId).trim(),
    designator: budgetId,
    footprint: String(row.status || "").trim(),
    qty: 1,
    unit: "预算项",
    lossRate: 0,
    processCost: 0,
    note: String(row.notes || "").trim(),
    chosenSupplierId: supplierId,
    collapsed: true,
    budgetReference: {
      referenceKind: "office-budget",
      budgetId,
      projectId: String(row.project_id || "").trim(),
      category: String(row.category || "").trim(),
      status: String(row.status || "").trim(),
      currency: String(row.currency || "").trim(),
      lowEstimate: parseBudgetNumber(row.low_estimate),
      highEstimate: parseBudgetNumber(row.high_estimate),
      dueStage: String(row.due_stage || "").trim(),
      sourceOrBasis: String(row.source_or_basis || "").trim(),
      notes: String(row.notes || "").trim(),
      relationship
    },
    suppliers: [
      {
        id: supplierId,
        name: "Office 预算主表",
        sku: budgetId,
        model: String(row.status || "").trim(),
        price: 0,
        shipping: 0,
        moq: 1,
        pricingMode: "unit",
        note: "参考记录；金额是否进入当前模型由费用 scope 决定。"
      }
    ]
  };
}

function parseBudgetNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
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
  if (data.recommendedPublicUnitPrice != null) {
    assertNonNegativeNumber(data.recommendedPublicUnitPrice, sourceFile, "data.recommendedPublicUnitPrice");
  }
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
      fail(sourceFile, `${categoryPath}.costScope is not supported: ${category.costScope}`);
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
  const unitCategories = data.categories.filter((category) => UNIT_COST_SCOPES.has(category.costScope));
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
    if (category.costScope === COST_SCOPE_FIXED_LAUNCH) {
      fixedLaunchInvestmentFromCategories += categoryUnitCost * batchQuantity;
    } else if (category.costScope === COST_SCOPE_POST_SALE) {
      expectedUnitAfterSalesSupportCost += categoryUnitCost;
      unitFulfillmentCost += categoryUnitCost;
    } else if (category.costScope === COST_SCOPE_PRE_DELIVERY) {
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
    recommendedRetailUnitPrice: Math.max(
      roundRetailPrice(minimumAverageSellingPrice),
      Number(data.recommendedPublicUnitPrice || 0)
    )
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

async function readCsvObjects(file) {
  const rows = parseCsv((await readFile(file, "utf8")).replace(/^\uFEFF/, ""));
  if (!rows.length) return [];
  const headers = rows[0].map((header) => String(header || "").trim());
  return rows.slice(1).map((row) => Object.fromEntries(headers.map((header, index) => [header, row[index] ?? ""])));
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let value = "";
  let inQuotes = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (char === '"') {
      if (inQuotes && next === '"') { value += '"'; index += 1; }
      else inQuotes = !inQuotes;
      continue;
    }
    if (char === "," && !inQuotes) { row.push(value); value = ""; continue; }
    if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && next === "\n") index += 1;
      row.push(value); rows.push(row); row = []; value = ""; continue;
    }
    value += char;
  }
  if (value.length || row.length) { row.push(value); rows.push(row); }
  return rows.filter((candidate) => candidate.some((cell) => cell !== ""));
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
