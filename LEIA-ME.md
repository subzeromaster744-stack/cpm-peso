# CPM · Cálculo de Peso de Materiais

Site com calculadora por medida, calculadora por kg, catálogo de barras, central de coleta por seção (A a D),
histórico com gráficos e área de admin.

- `public/index.html` — o site
- `src/index.js` — API (central de coleta, envios, admin)
- `wrangler.jsonc` — configuração; usa o banco D1 `cpm-peso`

## Publicação

O Cloudflare publica sozinho a cada envio para a branch `main` do GitHub.

## Senha de admin

Workers & Pages → cpm-peso → Settings → Variables and Secrets → Add

- Type: Secret
- Name: `ADMIN_PASSWORD`
- Value: a senha que o admin vai usar

Com a senha, o admin entra pela aba Histórico ("Entrar como admin") e pode editar e excluir envios.
