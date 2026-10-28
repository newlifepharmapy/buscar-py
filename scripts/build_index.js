// Gera public/data/embeddings.bin e colors.bin a partir das imagens do catálogo.
// Uso: node scripts/build_index.js
const fs = require("fs");
const path = require("path");
const tf = require("@tensorflow/tfjs-node");
const V = require("../public/js/vision.js");

const ROOT = path.join(__dirname, "..");

async function main() {
  const catalog = JSON.parse(fs.readFileSync(path.join(ROOT, "public/data/catalog.json"), "utf8"));
  const model = await tf.loadGraphModel("file://" + path.join(ROOT, "public/model/model.json"));
  // só os produtos com foto local (os de exemplo, sempre os primeiros). Os importados do Compras Paraguai
  // têm a foto no servidor de imagens de lá: o navegador calcula o vetor deles na primeira busca por foto.
  const n = catalog.products.findIndex((p) => p.image_src) === -1 ? catalog.products.length : catalog.products.findIndex((p) => p.image_src);
  if (catalog.products.slice(n).some((p) => !p.image_src)) throw new Error("produtos com foto local precisam vir antes dos importados");
  const deep = new Float32Array(n * 1280);
  const color = new Float32Array(n * V.COLOR_DIM);
  for (let i = 0; i < n; i++) {
    const p = catalog.products[i];
    const img = tf.node.decodeImage(fs.readFileSync(path.join(ROOT, "public", p.image)), 3);
    const d = await V.describe(tf, model, img);
    img.dispose();
    deep.set(d.deep, i * 1280);
    color.set(d.color, i * V.COLOR_DIM);
    if (i % 50 === 0) console.log(`${i}/${n}`);
  }
  fs.writeFileSync(path.join(ROOT, "public/data/embeddings.bin"), Buffer.from(deep.buffer));
  fs.writeFileSync(path.join(ROOT, "public/data/colors.bin"), Buffer.from(color.buffer));
  console.log("ok", n, "produtos indexados");
}
main();
