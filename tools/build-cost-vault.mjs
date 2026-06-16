import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { webcrypto } from "node:crypto";
import path from "node:path";

const DEFAULT_ITERATIONS = 210000;

const sourcePath = process.argv[2] || ".private/products";
const outputPath = process.argv[3] || "data/cost-vault.json";

const products = await loadProducts(sourcePath);
if (!products.length) {
  throw new Error("No products found. Add .json files under .private/products.");
}

const vault = {
  version: 1,
  kdf: {
    name: "PBKDF2",
    hash: "SHA-256",
    iterations: DEFAULT_ITERATIONS
  },
  products: []
};

for (const product of products.sort((a, b) => String(a.label).localeCompare(String(b.label), "zh-CN"))) {
  if (!product.id || !product.label || !product.token || !product.data) {
    throw new Error("Each product needs id, label, token, and data.");
  }

  const salt = webcrypto.getRandomValues(new Uint8Array(16));
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(product.token, salt, vault.kdf.iterations);
  const plaintext = new TextEncoder().encode(JSON.stringify(product.data));
  const ciphertext = new Uint8Array(await webcrypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext));

  vault.products.push({
    id: product.id,
    label: product.label,
    salt: toBase64(salt),
    iv: toBase64(iv),
    ciphertext: toBase64(ciphertext)
  });
}

await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(vault, null, 2)}\n`, "utf8");
console.log(`Wrote ${path.resolve(outputPath)} with ${vault.products.length} encrypted product(s).`);

async function loadProducts(source) {
  const stat = await safeStat(source);
  if (!stat) throw new Error(`Source path not found: ${source}`);

  if (stat.isDirectory()) {
    const names = await readdir(source);
    const files = names.filter((name) => name.toLowerCase().endsWith(".json")).sort();
    const entries = await Promise.all(files.map(async (name) => {
      const product = JSON.parse(await readFile(path.join(source, name), "utf8"));
      return Array.isArray(product.products) ? product.products : [product];
    }));
    return entries.flat();
  }

  const value = JSON.parse(await readFile(source, "utf8"));
  return Array.isArray(value.products) ? value.products : [value];
}

async function safeStat(file) {
  try {
    const { stat } = await import("node:fs/promises");
    return await stat(file);
  } catch {
    return null;
  }
}

async function deriveKey(token, salt, iterations) {
  const keyMaterial = await webcrypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(token),
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
