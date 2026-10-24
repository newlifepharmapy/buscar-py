# Buscar PY

Comparador de preços de lojas do Paraguai (no estilo do Compras Paraguai) com **busca por imagem**.
A busca (inclusive a IA de visão) roda no navegador. O servidor Node, sem dependências, monta as
páginas com o que foi definido no painel admin e mantém a cotação do dólar atualizada.

## Rodar

```bash
ADMIN_PASSWORD=uma-senha-forte npm start   # http://localhost:8080 e /admin (Node 20+, sem dependências)
npm test                                     # testes do servidor
```

## Painel admin (`/admin`)

Edita, sem mexer no código: nome e cores do site, logo, mensagem e links da barra superior, textos da
página inicial, câmeras ao vivo, rodapé, título e descrição para o Google, e a cotação do dólar.
Cada alteração é publicada na hora ao clicar em **Salvar e publicar**.

- Senha: variável `ADMIN_PASSWORD` (mínimo de 8 caracteres). Sem ela, o painel fica desligado.
- A sessão dura 12 horas. **Sair** encerra todas as sessões abertas, em qualquer aparelho.
- Depois de 8 senhas erradas, aquele aparelho (IP) espera 15 minutos. Se chegarem muitas senhas erradas
  de vários lugares ao mesmo tempo, o login só fica mais lento: a senha certa continua entrando.
- Um campo inválido (ex.: cor sem os 6 dígitos) fica com o último valor salvo.
- As configurações ficam em `DATA_DIR/settings.json`. No Railway, **adicione um volume** ao serviço
  (ex.: montado em `/data`): o servidor usa o volume sozinho. Sem volume, as alterações somem no
  próximo deploy (o painel avisa). O `Dockerfile` roda como root porque o Railway monta o volume
  como root; se o painel disser que o volume está montado mas sem permissão de gravar, defina
  `RAILWAY_RUN_UID=0` no serviço.

## Cotação do dólar

O servidor lê a cotação comercial do dólar em real e em guarani **a cada 5 minutos** na página do
Google Finance (a mesma que aparece numa busca no Google). Se o Google não responder, usa a AwesomeAPI
e depois a ExchangeRate-API. Valores fora de uma faixa plausível são descartados, e um salto de mais
de 10% só vale se outra fonte confirmar. A primeira leitura (sem cotação anterior) também precisa de
uma segunda fonte que concorde, a não ser que só uma esteja respondendo. A página do visitante confere
`/api/rates` a cada minuto e troca os valores em R$ e ₲ sem recarregar. No painel dá para desligar a
atualização automática e fixar um valor manual.

## Câmeras ao vivo (`/cameras`)

Câmeras da Ponte da Amizade (imagens do Portal da Cidade), editáveis no painel. O endereço do player
precisa começar com `https://`. Para YouTube, cole o link normal do vídeo ou da live
(`youtube.com/watch?v=…`, `youtube.com/live/…` ou `youtu.be/…`): o servidor converte para o player.
As câmeras aparecem todas juntas, como no iClinic (3 lado a lado no computador, uma embaixo da outra
no celular), e o link da barra superior abre a página na mesma janela. Para não travar o celular, cada
player só é criado quando a câmera aparece na tela e é removido quando ela sai; no máximo 3 tocam ao
mesmo tempo no computador e 2 no celular, tudo fecha quando a aba fica escondida e pausa depois de 10 minutos sem uso; com
"economia de dados" ligada, cada câmera só abre com um toque.

## Publicar no Railway

O repositório já vem com um `Dockerfile`, que o Railway usa sozinho para o build.

1. No Railway, crie um serviço a partir deste repositório do GitHub. Em *Settings → Deploy*, defina
   **Healthcheck Path** = `/health` (timeout de 60 s) e **Restart Policy** = *On Failure*. (O Railway não
   aplica o `railway.json` em serviços novos; ele fica no repositório só para serviços antigos.)
2. Variáveis: `ADMIN_PASSWORD` (senha do painel) e, opcional, `CANONICAL_HOST=buscarpy.com`, que redireciona
   `www.buscarpy.com` e `http://` para `https://buscarpy.com`. Adicione também um volume (ver "Painel admin").
3. Em *Settings → Networking*, adicione os domínios `buscarpy.com` e `www.buscarpy.com`. Para cada um, o Railway
   mostra um registro **CNAME** (para onde apontar) e um **TXT** `_railway-verify` (prova de que o domínio é seu).
   Crie os dois no provedor de DNS do domínio.
   - No domínio raiz (`buscarpy.com`), o provedor precisa aceitar CNAME na raiz (CNAME flattening, ALIAS ou ANAME).
     Cloudflare, por exemplo, aceita. Se o seu provedor não aceitar, mude os servidores DNS para a Cloudflare (grátis).
   - Na Cloudflare, use SSL/TLS no modo **Full** (não *Flexible*: com *Flexible* e `CANONICAL_HOST` ligado,
     o site entra em redirecionamento infinito). Deixe a nuvem laranja desligada até o Railway emitir o certificado.
   - Quando ligar a nuvem laranja (site passando pela Cloudflare), defina também `TRUST_CLOUDFLARE=1`, para o
     limite de senhas erradas do painel usar o IP real de quem acessa. Sem a Cloudflare na frente, não defina:
     qualquer um poderia inventar o cabeçalho com o IP. (O endereço `*.up.railway.app` continua acessível sem
     passar pela Cloudflare; se não usar, remova-o em *Settings → Networking*.)
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
server.js          servidor de produção (Railway): páginas, painel, cotação
lib/               configurações (padrões e validação), login, cotação, montagem das páginas
views/             modelos das páginas (início, câmeras, 404) e partes comuns
public/            arquivos do site (css/, js/, admin/, data/, model/, img/, vendor/tf.min.js)
test/              testes (npm test)
scripts/           select_products.py, make_catalog.py, build_index.js, build_artifact.py
                   (scripts/package.json tem as dependências de indexação: npm run indexar)
```

## Licenças

- Imagens e nomes de produtos: Amazon Berkeley Objects, CC BY 4.0.
- MobileNetV2 (pesos do modelo) e TensorFlow.js: Apache 2.0.
