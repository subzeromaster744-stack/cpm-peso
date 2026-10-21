# CPM · Peso de Materiais

App (PWA) com calculadora de peso, calculadora por kg, central de coleta por seção (A a D),
histórico com gráficos, login e cadastro de usuários.

- `public/index.html` — o app
- `public/sw.js`, `public/manifest.webmanifest`, `public/icons/` — instalação como app e uso sem internet
- `src/index.js` — API (login, usuários, central, envios)
- `wrangler.jsonc` — configuração; usa o banco D1 `cpm-peso`

## Publicação

O Cloudflare publica sozinho a cada envio para a branch `main` do GitHub.

## Primeiro acesso (obrigatório)

O administrador principal é o usuário **admin**, com a senha guardada no Cloudflare:

Workers & Pages → cpm-peso → Settings → Variables and Secrets → Add

- Type: Secret
- Name: `ADMIN_PASSWORD`
- Value: a senha do admin

Sem esse segredo ninguém consegue entrar. Depois de entrar como admin, use a aba **Usuários** para cadastrar
as pessoas de cada seção (e outros administradores, se quiser).

## Permissões

- **Usuário da seção:** vê, adiciona e envia apenas itens da própria seção; vê o histórico da própria seção.
- **Administrador:** vê todas as seções, edita e exclui envios e cadastra, edita, bloqueia ou exclui usuários.
