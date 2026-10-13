# Buscar PY

Comparador de preços de lojas do Paraguai (no estilo do Compras Paraguai) com **busca por imagem**.
Protótipo funcional: tudo roda no navegador, inclusive a IA de visão, então pode ser hospedado em
qualquer servidor estático (Netlify, Vercel, GitHub Pages, S3).

## Rodar

```bash
npm start            # http://localhost:8080 (Node 20+, sem dependências)
```

## Publicar no Railway

O repositório já vem pronto: `Dockerfile` + `railway.json` (build pelo Dockerfile e healthcheck em `/health`).

1. No Railway, crie um serviço a partir deste repositório do GitHub. Confira em *Settings → Deploy* se o
   healthcheck ficou em `/health` (o `railway.json` sugere, mas a configuração do painel prevalece).
2. Variável opcional `CANONICAL_HOST=buscarpy.com`: redireciona `www.buscarpy.com` e `http://` para `https://buscarpy.com`.
3. Em *Settings → Networking*, adicione os domínios `buscarpy.com` e `www.buscarpy.com`. Para cada um, o Railway
   mostra um registro **CNAME** (para onde apontar) e um **TXT** `_railway-verify` (prova de que o domínio é seu).
   Crie os dois no provedor de DNS do domínio.
   - No domínio raiz (`buscarpy.com`), o provedor precisa aceitar CNAME na raiz (CNAME flattening, ALIAS ou ANAME).
     Cloudflare, por exemplo, aceita. Se o seu provedor não aceitar, mude os servidores DNS para a Cloudflare (grátis).
   - Na Cloudflare, use SSL/TLS no modo **Full** (não *Flexible*: com *Flexible* e `CANONICAL_HOST` ligado,
     o site entra em redirecionamento infinito). Deixe a nuvem laranja desligada até o Railway emitir o certificado.
   - O certificado HTTPS é emitido sozinho pelo Railway depois que os registros propagam.
   - O plano Trial do Railway aceita 1 domínio próprio por serviço; o Hobby aceita 2 (raiz + www).

O servidor (`server.js`) serve `public/` com Brotli/Gzip, ETag (revalidação barata a cada visita), cache de 7 dias para as fotos,
e cabeçalhos de segurança (CSP, nosniff, referrer-policy).

## O que tem

- **Busca por texto** em português ou espanhol, sem acento e tolerante a erro de digitação
  (`relogio masculino`, `mochila preta`, `headphnes`). Sinônimos em `public/js/search.js`.
- **Busca por imagem** (`public/js/vision.js`):
  - envio por arquivo, arrastar e soltar, Ctrl+V ou câmera do celular;
  - **recorte**: arraste sobre a foto para marcar só o produto, a busca refaz sozinha;
  - assinatura visual = MobileNetV2 (GeM pooling, média com a imagem espelhada) + histograma de cor
    que ignora o fundo branco;
  - controle de **peso da cor** (mesmo modelo na mesma cor) e de **similaridade mínima**;
  - **"Parece ser"**: categoria provável votada pelos vizinhos mais próximos, clicável como filtro;
  - "Buscar parecidos" em qualquer produto e combinação com filtros de preço, loja, cidade e estoque.
- **Comparação de preços**: menor preço por produto, tabela de lojas em US$, R$ e ₲,
  economia entre a loja mais cara e a mais barata, histórico de 26 semanas.

Teste interno (`scripts/` + 57 fotos alteradas com recorte, ruído e mudança de brilho):
o produto exato aparece em 1º lugar em 96% dos casos e entre os 5 primeiros em 100%.
Entre vizinhos do próprio catálogo, 80% dos 5 mais parecidos são da mesma categoria.

## Dados

- `public/data/catalog.json`: produtos, lojas, ofertas, histórico e cotação.
- Imagens e nomes vêm do dataset **Amazon Berkeley Objects** (CC BY 4.0).
  **Lojas, preços e histórico são fictícios**, gerados por `scripts/make_catalog.py`.
- `public/data/embeddings.bin` e `colors.bin`: índice visual, gerado por `npm run indexar`.

Para usar dados reais, troque `make_catalog.py` por coletores de cada loja (feed/API ou scraping
autorizado) gerando o mesmo formato de `catalog.json`, e rode `npm run indexar`.

## Próximos passos sugeridos

1. Coletores de preço das lojas + atualização agendada.
2. Backend de busca (Postgres + pgvector ou Qdrant) quando o catálogo passar de ~20 mil produtos;
   o mesmo `vision.js` roda no Node para indexar.
3. Trocar a MobileNetV2 por CLIP/SigLIP para aceitar busca "texto → imagem" e fotos mais difíceis.
4. Alertas de preço, conta de usuário e página por loja.

## Estrutura

```
server.js          servidor de produção (Railway)
public/            site (index.html, css/, js/, data/, model/, img/, vendor/tf.min.js)
scripts/           select_products.py, make_catalog.py, build_index.js, build_artifact.py
                   (scripts/package.json tem as dependências de indexação: npm run indexar)
```

## Licenças

- Imagens e nomes de produtos: Amazon Berkeley Objects, CC BY 4.0.
- MobileNetV2 (pesos do modelo) e TensorFlow.js: Apache 2.0.
