const HISTORY_LIMIT = 50;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, PUT, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Sync-Secret",
  "Content-Type": "application/json; charset=utf-8"
};

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    if (!env.COST_DATA) {
      return json({ error: "KV binding COST_DATA is missing" }, 500);
    }

    if (!env.SYNC_SECRET) {
      return json({ error: "Worker secret SYNC_SECRET is missing" }, 500);
    }

    if (request.headers.get("X-Sync-Secret") !== env.SYNC_SECRET) {
      return json({ error: "unauthorized" }, 401);
    }

    const url = new URL(request.url);
    const key = decodeURIComponent(url.pathname.slice(1) || "default");
    if (!/^[\w.-]{1,80}$/.test(key)) {
      return json({ error: "invalid key" }, 400);
    }

    if (request.method === "GET") {
      if (url.searchParams.get("history") === "1") {
        return json({ key, history: await readHistory(env, key) });
      }

      if (url.searchParams.get("meta") === "1") {
        const raw = await env.COST_DATA.get(metaKey(key));
        return raw
          ? new Response(raw, { headers: corsHeaders })
          : json({ error: "not found" }, 404);
      }

      const raw = await env.COST_DATA.get(key);
      return raw
        ? new Response(raw, { headers: corsHeaders })
        : json({ error: "not found" }, 404);
    }

    if (request.method === "PUT") {
      const body = await request.text();
      const payload = JSON.parse(body);
      const updatedAt = new Date().toISOString();
      const previousMeta = await readMeta(env, key);
      const version = Number(previousMeta?.version || 0) + 1;
      const meta = {
        key,
        version,
        updatedAt,
        updatedBy: String(payload.updatedBy || "未填写"),
        projectName: String(payload.projectName || payload.data?.projectName || ""),
        productCount: Array.isArray(payload.data?.products) ? payload.data.products.length : undefined,
        bytes: new TextEncoder().encode(body).length
      };

      await env.COST_DATA.put(key, body);
      await env.COST_DATA.put(metaKey(key), JSON.stringify(meta));
      await appendHistory(env, key, meta);
      return json({ ok: true, ...meta });
    }

    return json({ error: "method not allowed" }, 405);
  }
};

async function readMeta(env, key) {
  const raw = await env.COST_DATA.get(metaKey(key));
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function readHistory(env, key) {
  const raw = await env.COST_DATA.get(historyKey(key));
  if (!raw) return [];
  try {
    const history = JSON.parse(raw);
    return Array.isArray(history) ? history : [];
  } catch {
    return [];
  }
}

async function appendHistory(env, key, meta) {
  const history = await readHistory(env, key);
  history.unshift(meta);
  await env.COST_DATA.put(historyKey(key), JSON.stringify(history.slice(0, HISTORY_LIMIT)));
}

function metaKey(key) {
  return `${key}.__meta`;
}

function historyKey(key) {
  return `${key}.__history`;
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: corsHeaders
  });
}
