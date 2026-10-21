// CPM · Cálculo de Peso — API da central de coleta (Cloudflare Worker + D1)
const COLLS = new Set(["coleta", "envios"]);
const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8" } });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const m = url.pathname.match(/^\/api\/([a-z]+)(?:\/([A-Za-z0-9_.:@+~-]{1,120}))?$/);
    if (!m) return env.ASSETS.fetch(request);
    const [, coll, id] = m;
    if (!COLLS.has(coll)) return json({ error: "coleção inválida" }, 400);

    try {
      if (request.method === "GET" && !id) {
        const { results } = await env.DB.prepare(
          "SELECT id, data FROM docs WHERE coll = ? ORDER BY updated_at DESC LIMIT 1000"
        ).bind(coll).all();
        return json(results.map((r) => ({ id: r.id, data: JSON.parse(r.data) })));
      }
      if (!id) return json({ error: "id obrigatório" }, 400);

      if (request.method === "DELETE") {
        await env.DB.prepare("DELETE FROM docs WHERE coll = ? AND id = ?").bind(coll, id).run();
        return json({ ok: true });
      }

      if (request.method === "PUT" || request.method === "PATCH") {
        const body = await request.json().catch(() => null);
        if (!body || typeof body !== "object" || Array.isArray(body)) return json({ error: "corpo inválido" }, 400);
        let data = body;
        if (request.method === "PATCH") {
          const cur = await env.DB.prepare("SELECT data FROM docs WHERE coll = ? AND id = ?").bind(coll, id).first();
          if (!cur) return json({ error: "documento não existe" }, 400);
          data = { ...JSON.parse(cur.data), ...body };
        }
        const txt = JSON.stringify(data);
        if (txt.length > 200_000) return json({ error: "documento grande demais" }, 400);
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
