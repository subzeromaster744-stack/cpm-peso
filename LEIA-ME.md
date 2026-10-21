# CPM · Cálculo de Peso de Materiais

Site com a calculadora, o catálogo de barras e a central de coleta compartilhada.

- `public/index.html` — o site
- `src/index.js` — API da central de coleta
- `wrangler.jsonc` — configuração; o banco D1 `cpm-peso` já foi criado na sua conta

## Publicar (uma vez, no seu computador)

Precisa do Node.js 18 ou mais novo instalado.

    cd cpm-site
    npx wrangler login
    npx wrangler deploy

O endereço aparece no final, algo como `https://cpm-peso.<sua-conta>.workers.dev`.

Para atualizar depois, edite os arquivos e rode `npx wrangler deploy` de novo.
