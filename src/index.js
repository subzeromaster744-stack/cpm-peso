// CPM · Peso de Materiais — API (Cloudflare Worker + D1)
//
// Tudo em /api exige login (exceto /api/login).
// Papéis: "admin" vê e altera tudo e cadastra usuários; "usuario" só vê, adiciona e envia itens da própria seção.
// Admin principal: usuário "admin" com a senha do segredo ADMIN_PASSWORD (Cloudflare → Settings → Variables and Secrets).
//
// Tabela única docs(coll, id, data, updated_at) com as coleções:
//   coleta    itens aguardando envio
//   envios    pedidos enviados
//   usuarios  contas (id = login)
//   sessoes   sessões abertas (id = token)

const SECOES = ["A", "B", "C", "D"];
const SESSAO_DIAS = 30;
const MAX_TENTATIVAS = 6;       // erros seguidos antes de travar o login
const TRAVA_MIN = 10;           // minutos de trava
const PBKDF2_ITER = 100000;
const ID_RE = /^[A-Za-z0-9_.:@+~-]{1,120}$/;
const LOGIN_RE = /^[a-z0-9._-]{2,40}$/;

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
const fail = (msg, status) => json({ error: msg }, status);

/* ---------- banco ---------- */
async function getDoc(env, coll, id) {
  const r = await env.DB.prepare("SELECT data FROM docs WHERE coll = ? AND id = ?").bind(coll, id).first();
  return r ? JSON.parse(r.data) : null;
}
async function listDocs(env, coll) {
  const { results } = await env.DB.prepare(
    "SELECT id, data FROM docs WHERE coll = ? ORDER BY updated_at DESC LIMIT 5000"
  ).bind(coll).all();
  return results.map((r) => ({ id: r.id, data: JSON.parse(r.data) }));
}
const putStmt = (env, coll, id, data) =>
  env.DB.prepare(
    "INSERT INTO docs (coll, id, data, updated_at) VALUES (?, ?, ?, ?) " +
      "ON CONFLICT(coll, id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at"
  ).bind(coll, id, JSON.stringify(data), Date.now());
const putDoc = (env, coll, id, data) => putStmt(env, coll, id, data).run();
const delStmt = (env, coll, id) => env.DB.prepare("DELETE FROM docs WHERE coll = ? AND id = ?").bind(coll, id);

/* ---------- senhas e sessões ---------- */
const enc = new TextEncoder();
const toHex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
const fromHex = (h) => new Uint8Array(h.match(/../g).map((x) => parseInt(x, 16)));
async function hashSenha(senha, saltHex) {
  const salt = saltHex ? fromHex(saltHex) : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", enc.encode(senha), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: PBKDF2_ITER }, key, 256);
  return { salt: toHex(salt), hash: toHex(bits) };
}
function iguais(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
async function sha(text) {
  return toHex(await crypto.subtle.digest("SHA-256", enc.encode(text)));
}
const publico = (u) => ({ login: u.login, nome: u.nome, secao: u.secao, papel: u.papel, ativo: u.ativo !== false });

async function sessao(request, env) {
  const auth = request.headers.get("authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!ID_RE.test(token)) return null;
  const s = await getDoc(env, "sessoes", token);
  if (!s || s.expira < Date.now()) return null;
  // renova a sessão de quem usa o app com frequência
  if (s.expira - Date.now() < (SESSAO_DIAS / 2) * 864e5)
    await putDoc(env, "sessoes", token, { ...s, expira: Date.now() + SESSAO_DIAS * 864e5 });
  if (s.login === "admin") return { token, login: "admin", nome: "Administrador", secao: "", papel: "admin", mestre: true };
  const u = await getDoc(env, "usuarios", s.login);
  if (!u || u.ativo === false) return null;
  return { token, ...publico(u) };
}

/* ---------- rotas ---------- */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    if (!path.startsWith("/api/")) return env.ASSETS.fetch(request);
    try {
      return await api(request, env, path, request.method);
    } catch (e) {
      return fail("erro no servidor", 500);
    }
  },
};

async function api(request, env, path, method) {
  const body = method === "POST" || method === "PUT" || method === "PATCH" ? await request.json().catch(() => null) : null;

  /* login */
  if (path === "/api/login" && method === "POST") {
    const login = String(body?.login || "").trim().toLowerCase();
    const senha = String(body?.senha || "");
    if (!login || !senha) return fail("informe usuário e senha", 400);
    const tKey = "t-" + (await sha(login)).slice(0, 32);
    const tent = (await getDoc(env, "tentativas", tKey)) || { n: 0, ate: 0 };
    if (tent.ate > Date.now()) {
      const min = Math.ceil((tent.ate - Date.now()) / 60000);
      return fail(`muitas tentativas erradas; tente de novo em ${min} min`, 429);
    }
    let user = null;
    if (login === "admin") {
      if (!env.ADMIN_PASSWORD) return fail("a senha do admin ainda não foi configurada no Cloudflare", 503);
      if (iguais(await sha(senha), await sha(env.ADMIN_PASSWORD)))
        user = { login: "admin", nome: "Administrador", secao: "", papel: "admin", mestre: true };
    } else {
      const u = await getDoc(env, "usuarios", login);
      if (u && u.ativo !== false) {
        const { hash } = await hashSenha(senha, u.salt);
        if (iguais(hash, u.hash)) user = publico(u);
      }
    }
    if (!user) {
      const n = (tent.ate && tent.ate <= Date.now() ? 0 : tent.n) + 1;
      await putDoc(env, "tentativas", tKey, { n, ate: n >= MAX_TENTATIVAS ? Date.now() + TRAVA_MIN * 60000 : 0 });
      return fail("usuário ou senha incorretos", 401);
    }
    if (tent.n) await delStmt(env, "tentativas", tKey).run();
    const token = toHex(crypto.getRandomValues(new Uint8Array(24)));
    await putDoc(env, "sessoes", token, { login: user.login, criada: Date.now(), expira: Date.now() + SESSAO_DIAS * 864e5 });
    // limpeza de sessões vencidas
    await env.DB.prepare("DELETE FROM docs WHERE coll = 'sessoes' AND json_extract(data, '$.expira') < ?").bind(Date.now()).run();
    return json({ token, user });
  }

  const me = await sessao(request, env);
  if (!me) return fail("faça login", 401);
  const admin = me.papel === "admin";

  if (path === "/api/me" && method === "GET") return json({ user: me });
  if (path === "/api/logout" && method === "POST") {
    await delStmt(env, "sessoes", me.token).run();
    return json({ ok: true });
  }

  /* ---------- trocar a própria senha ---------- */
  if (path === "/api/minha-senha" && method === "POST") {
    if (me.mestre) return fail("a senha do admin principal é trocada no Cloudflare (ADMIN_PASSWORD)", 400);
    const u = await getDoc(env, "usuarios", me.login);
    const atual = String(body?.atual || ""), nova = String(body?.nova || "");
    if (!u || !iguais((await hashSenha(atual, u.salt)).hash, u.hash)) return fail("a senha atual está errada", 400);
    if (nova.length < 4) return fail("a nova senha precisa ter pelo menos 4 caracteres", 400);
    const cred = await hashSenha(nova);
    await env.DB.batch([
      putStmt(env, "usuarios", me.login, { ...u, ...cred, atualizadoEm: Date.now() }),
      env.DB.prepare("DELETE FROM docs WHERE coll = 'sessoes' AND json_extract(data, '$.login') = ? AND id != ?").bind(me.login, me.token),
    ]);
    return json({ ok: true });
  }

  /* ---------- usuários (admin) ---------- */
  if (path === "/api/usuarios" && method === "GET") {
    if (!admin) return fail("só o admin pode ver usuários", 403);
    return json((await listDocs(env, "usuarios")).map((r) => publico(r.data)));
  }
  let m = path.match(/^\/api\/usuarios\/([^/]+)$/);
  if (m) {
    if (!admin) return fail("só o admin pode alterar usuários", 403);
    const login = decodeURIComponent(m[1]).toLowerCase();
    if (!LOGIN_RE.test(login) || login === "admin") return fail("login inválido (use letras minúsculas, números, ponto, hífen ou _)", 400);
    if (login === me.login && (method === "DELETE" || body?.ativo === false || body?.papel !== "admin"))
      return fail("você não pode excluir, bloquear ou tirar o acesso de admin da sua própria conta", 400);
    if (method === "DELETE") {
      await env.DB.batch([
        delStmt(env, "usuarios", login),
        env.DB.prepare("DELETE FROM docs WHERE coll = 'sessoes' AND json_extract(data, '$.login') = ?").bind(login),
      ]);
      return json({ ok: true });
    }
    if (method === "PUT") {
      const atual = await getDoc(env, "usuarios", login);
      const nome = String(body?.nome || "").trim().slice(0, 80);
      const papel = body?.papel === "admin" ? "admin" : "usuario";
      const secao = SECOES.includes(body?.secao) ? body.secao : "";
      const ativo = body?.ativo !== false;
      const senha = String(body?.senha || "");
      if (!nome) return fail("informe o nome", 400);
      if (papel === "usuario" && !secao) return fail("escolha a seção do usuário", 400);
      if (!atual && senha.length < 4) return fail("a senha precisa ter pelo menos 4 caracteres", 400);
      if (senha && senha.length < 4) return fail("a senha precisa ter pelo menos 4 caracteres", 400);
      const cred = senha ? await hashSenha(senha) : { salt: atual.salt, hash: atual.hash };
      const doc = { login, nome, papel, secao, ativo, ...cred, criadoEm: atual?.criadoEm || Date.now(), atualizadoEm: Date.now() };
      const stmts = [putStmt(env, "usuarios", login, doc)];
      if (senha || !ativo) // troca de senha ou desativação derruba as sessões abertas
        stmts.push(env.DB.prepare("DELETE FROM docs WHERE coll = 'sessoes' AND json_extract(data, '$.login') = ?").bind(login));
      await env.DB.batch(stmts);
      return json({ ok: true, user: publico(doc) });
    }
    return fail("método não suportado", 405);
  }

  /* ---------- central de coleta ---------- */
  if (path === "/api/coleta" && method === "GET") {
    let rows = await listDocs(env, "coleta");
    if (!admin) rows = rows.filter((r) => r.data.secao === me.secao);
    return json(rows);
  }
  if (path === "/api/coleta/remover" && method === "POST") {
    const ids = Array.isArray(body?.ids) ? body.ids.filter((x) => typeof x === "string" && ID_RE.test(x)).slice(0, 500) : [];
    if (!ids.length) return fail("nenhum item", 400);
    if (!admin) {
      for (const id of ids) {
        const d = await getDoc(env, "coleta", id);
        if (d && d.secao !== me.secao) return fail("você só pode remover itens da sua seção", 403);
      }
    }
    await env.DB.batch(ids.map((id) => delStmt(env, "coleta", id)));
    return json({ ok: true });
  }
  m = path.match(/^\/api\/coleta\/([^/]+)$/);
  if (m) {
    const id = m[1];
    if (!ID_RE.test(id)) return fail("id inválido", 400);
    const atual = await getDoc(env, "coleta", id);
    if (atual && !admin && atual.secao !== me.secao) return fail("item de outra seção", 403);
    if (method === "DELETE") {
      await delStmt(env, "coleta", id).run();
      return json({ ok: true });
    }
    if (method === "PUT" || method === "PATCH") {
      if (!body || typeof body !== "object" || Array.isArray(body)) return fail("corpo inválido", 400);
      let data = method === "PATCH" ? (atual ? { ...atual, ...body } : null) : body;
      if (!data) return fail("item não existe", 400);
      if (!admin) data.secao = me.secao; // usuário comum só grava na própria seção
      else if (!SECOES.includes(data.secao)) return fail("seção inválida", 400);
      if (!atual) { data.criadoPor = me.nome; data.criadoPorLogin = me.login; }
      if (JSON.stringify(data).length > 50_000) return fail("item grande demais", 400);
      await putDoc(env, "coleta", id, data);
      return json({ ok: true });
    }
    return fail("método não suportado", 405);
  }

  /* ---------- envio (atômico) ---------- */
  if (path === "/api/enviar" && method === "POST") {
    const envio = body?.envio;
    const ids = Array.isArray(body?.ids) ? body.ids.filter((x) => typeof x === "string" && ID_RE.test(x)).slice(0, 500) : [];
    if (!envio || typeof envio !== "object" || !ID_RE.test(String(envio.numero || ""))) return fail("envio inválido", 400);
    if (await getDoc(env, "envios", envio.numero)) return fail("envio já existe", 409);
    if (!admin) {
      envio.secao = me.secao;
      envio.itens = (Array.isArray(envio.itens) ? envio.itens : []).map((r) => ({ ...r, secao: me.secao }));
      for (const id of ids) {
        const d = await getDoc(env, "coleta", id);
        if (d && d.secao !== me.secao) return fail("você só pode enviar itens da sua seção", 403);
      }
    }
    envio.enviadoPor = me.nome;
    envio.enviadoPorLogin = me.login;
    envio.enviadoEm = Date.now();
    if (JSON.stringify(envio).length > 500_000) return fail("envio grande demais", 400);
    await env.DB.batch([putStmt(env, "envios", envio.numero, envio), ...ids.map((id) => delStmt(env, "coleta", id))]);
    return json({ ok: true, envio });
  }

  /* ---------- histórico ---------- */
  /* ---------- auditorias de estoque (só admin, somente leitura) ---------- */
  if (path === "/api/auditorias" && method === "GET") {
    if (!admin) return fail("só o admin pode ver as auditorias", 403);
    const rows = await listDocs(env, "auditorias");
    return json(rows.map((r) => r.data).sort((a, b) => String(a.data).localeCompare(String(b.data))));
  }
  // importação da planilha de auditoria (lida no navegador): grava ou atualiza cada auditoria pela data
  if (path === "/api/auditorias/importar" && method === "POST") {
    if (!admin) return fail("só o admin pode importar auditorias", 403);
    const lista = Array.isArray(body?.auditorias) ? body.auditorias : null;
    if (!lista || !lista.length || lista.length > 200) return fail("nenhuma auditoria para importar", 400);
    const NUM = ["fisico", "sap", "valorKg", "perda", "proposto", "consumo", "sobras"];
    const TXT = ["obs", "propostoObs", "sobrasObs"];
    const limpas = [];
    for (const a of lista) {
      if (!a || !/^\d{4}-\d{2}-\d{2}$/.test(a.data || "") || !Array.isArray(a.itens) || !a.itens.length || a.itens.length > 500)
        return fail("auditoria inválida: " + (a && a.data), 400);
      const itens = a.itens.map((i) => {
        const o = { codigo: String(i.codigo || "").slice(0, 20) };
        for (const k of NUM) if (typeof i[k] === "number" && isFinite(i[k])) o[k] = i[k];
        for (const k of TXT) if (typeof i[k] === "string" && i[k].trim()) o[k] = i[k].trim().slice(0, 120);
        return o;
      }).filter((i) => /^\d{4,12}$/.test(i.codigo));
      const doc = {
        id: "AUD-" + a.data.replace(/-/g, ""), data: a.data,
        periodoConsumo: String(a.periodoConsumo || "").slice(0, 80),
        fonte: String(a.fonte || "").slice(0, 120), importadoEm: Date.now(), importadoPor: me.nome, itens,
      };
      if (JSON.stringify(doc).length > 300_000) return fail("auditoria grande demais: " + a.data, 400);
      limpas.push(doc);
    }
    const existentes = new Set((await listDocs(env, "auditorias")).map((r) => r.id));
    await env.DB.batch(limpas.map((d) => putStmt(env, "auditorias", d.id, d)));
    const novas = limpas.filter((d) => !existentes.has(d.id)).length;
    return json({ ok: true, novas, atualizadas: limpas.length - novas });
  }
  // exclui todas as auditorias de uma vez (o navegador exige confirmação digitada)
  if (path === "/api/auditorias/excluir-todas" && method === "POST") {
    if (!admin) return fail("só o admin pode excluir auditorias", 403);
    if (body?.confirmar !== "EXCLUIR") return fail("confirmação ausente", 400);
    const r = await env.DB.prepare("DELETE FROM docs WHERE coll = 'auditorias'").run();
    return json({ ok: true, excluidas: r.meta?.changes ?? 0 });
  }
  m = path.match(/^\/api\/auditorias\/(AUD-\d{8})$/);
  if (m && method === "DELETE") {
    if (!admin) return fail("só o admin pode excluir auditorias", 403);
    await delStmt(env, "auditorias", m[1]).run();
    return json({ ok: true });
  }

  if (path === "/api/envios" && method === "GET") {
    let rows = await listDocs(env, "envios");
    if (!admin)
      rows = rows
        .filter((r) => r.data.secao === me.secao || (r.data.itens || []).some((i) => i.secao === me.secao))
        .map((r) => {
          const itens = (r.data.itens || []).filter((i) => (i.secao || r.data.secao) === me.secao);
          const pesoTotal = +itens.reduce((a, i) => a + (+i.pesoTotal || 0), 0).toFixed(3);
          const qtdPecas = itens.reduce((a, i) => a + (+i.qtd || 0), 0);
          return { id: r.id, data: { ...r.data, itens, pesoTotal, qtdPecas, qtdItens: undefined } };
        });
    return json(rows);
  }
  m = path.match(/^\/api\/envios\/([^/]+)$/);
  if (m) {
    if (!admin) return fail("só o admin pode alterar envios", 403);
    const id = m[1];
    if (!ID_RE.test(id)) return fail("id inválido", 400);
    if (method === "DELETE") {
      await delStmt(env, "envios", id).run();
      return json({ ok: true });
    }
    if (method === "PUT") {
      if (!body || typeof body !== "object") return fail("corpo inválido", 400);
      if (JSON.stringify(body).length > 500_000) return fail("envio grande demais", 400);
      await putDoc(env, "envios", id, { ...body, numero: id });
      return json({ ok: true });
    }
    return fail("método não suportado", 405);
  }

  return fail("rota inválida", 404);
}
