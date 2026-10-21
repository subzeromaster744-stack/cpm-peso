// CPM · Cálculo de Peso — API da central de coleta e do histórico (Cloudflare Worker + D1)
//
// Coleções:
//   coleta  – itens aguardando envio (qualquer pessoa com o link pode adicionar/remover)
//   envios  – pedidos enviados (qualquer pessoa cria; só o admin edita ou exclui)
//
// Senha de admin: segredo ADMIN_PASSWORD no Cloudflare
//   (Workers & Pages → cpm-peso → Settings → Variables and Secrets → Add → tipo Secret)

const COLLS = new Set(["coleta", "envios"]);
const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

async function sha256(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return new Uint8Array(buf);
}
async function isAdmin(request, env) {
  const given = request.headers.get("x-admin-token") || "";
  if (!env.ADMIN_PASSWORD || !given) return false;
  const [a, b] = await Promise.all([sha256(given), sha256(env.ADMIN_PASSWORD)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
async function requireAdmin(request, env) {
  if (!env.ADMIN_PASSWORD) return json({ error: "senha de admin não configurada" }, 503);
  if (!(await isAdmin(request, env))) return json({ error: "senha de admin inválida" }, 401);
  return null;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/admin/check") {
      const deny = await requireAdmin(request, env);
      return deny || json({ ok: true });
    }

    // Envio atômico: grava o pedido e tira os itens da central numa só operação
    if (url.pathname === "/api/enviar" && request.method === "POST") {
      const body = await request.json().catch(() => null);
      const envio = body && body.envio;
      const ids = Array.isArray(body && body.ids) ? body.ids.filter((x) => typeof x === "string").slice(0, 500) : [];
      if (!envio || typeof envio !== "object" || typeof envio.numero !== "string" || !/^[A-Za-z0-9_.:@+~-]{1,120}$/.test(envio.numero))
        return json({ error: "envio inválido" }, 400);
      const exists = await env.DB.prepare("SELECT 1 FROM docs WHERE coll = 'envios' AND id = ?").bind(envio.numero).first();
      if (exists) return json({ error: "envio já existe" }, 409);
      const txt = JSON.stringify(envio);
      if (txt.length > 500_000) return json({ error: "envio grande demais" }, 400);
      await env.DB.batch([
        env.DB.prepare("INSERT INTO docs (coll, id, data, updated_at) VALUES ('envios', ?, ?, ?)").bind(envio.numero, txt, Date.now()),
        ...ids.map((id) => env.DB.prepare("DELETE FROM docs WHERE coll = 'coleta' AND id = ?").bind(id)),
      ]);
      return json({ ok: true });
    }

    // Remove vários itens da central de uma vez
    if (url.pathname === "/api/coleta/remover" && request.method === "POST") {
      const body = await request.json().catch(() => null);
      const ids = Array.isArray(body && body.ids) ? body.ids.filter((x) => typeof x === "string").slice(0, 500) : [];
      if (!ids.length) return json({ error: "nenhum item" }, 400);
      await env.DB.batch(ids.map((id) => env.DB.prepare("DELETE FROM docs WHERE coll = 'coleta' AND id = ?").bind(id)));
      return json({ ok: true });
    }

    const m = url.pathname.match(/^\/api\/([a-z]+)(?:\/([A-Za-z0-9_.:@+~-]{1,120}))?$/);
    if (!m) {
      if (url.pathname.startsWith("/api/")) return json({ error: "rota inválida" }, 404);
      return env.ASSETS.fetch(request);
    }
    const [, coll, id] = m;
    if (!COLLS.has(coll)) return json({ error: "coleção inválida" }, 400);

    try {
      if (request.method === "GET" && !id) {
        const { results } = await env.DB.prepare(
          "SELECT id, data FROM docs WHERE coll = ? ORDER BY updated_at DESC LIMIT 5000"
        ).bind(coll).all();
        return json(results.map((r) => ({ id: r.id, data: JSON.parse(r.data) })));
      }
      if (!id) return json({ error: "id obrigatório" }, 400);

      const cur = await env.DB.prepare("SELECT data FROM docs WHERE coll = ? AND id = ?").bind(coll, id).first();

      if (request.method === "DELETE") {
        if (coll === "envios") {
          const deny = await requireAdmin(request, env);
          if (deny) return deny;
        }
        await env.DB.prepare("DELETE FROM docs WHERE coll = ? AND id = ?").bind(coll, id).run();
        return json({ ok: true });
      }

      if (request.method === "PUT" || request.method === "PATCH") {
        // envio já existente só pode ser alterado pelo admin
        if (coll === "envios" && (cur || request.method === "PATCH")) {
          const deny = await requireAdmin(request, env);
          if (deny) return deny;
        }
        const body = await request.json().catch(() => null);
        if (!body || typeof body !== "object" || Array.isArray(body)) return json({ error: "corpo inválido" }, 400);
        let data = body;
        if (request.method === "PATCH") {
          if (!cur) return json({ error: "documento não existe" }, 400);
          data = { ...JSON.parse(cur.data), ...body };
        }
        const txt = JSON.stringify(data);
        if (txt.length > 500_000) return json({ error: "documento grande demais" }, 400);
        await env.DB.prepare(
          "INSERT INTO docs (coll, id, data, updated_at) VALUES (?, ?, ?, ?) " +
            "ON CONFLICT(coll, id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at"
        ).bind(coll, id, txt, Date.now()).run();
        return json({ ok: true });
      }
      return json({ error: "método não suportado" }, 405);
    } catch (e) {
      return json({ error: "erro no servidor" }, 500);
    }
  },
};
