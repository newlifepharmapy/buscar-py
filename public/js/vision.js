/*
 * Buscar PY — extração de características visuais.
 * O mesmo código roda no navegador (busca do usuário) e no Node (indexação do catálogo),
 * garantindo que a consulta e o catálogo fiquem no mesmo espaço vetorial.
 *
 * Assinatura visual de cada imagem:
 *  - deep:  vetor de 1280 dimensões da MobileNetV2 (camada Conv_1) com GeM pooling,
 *           média entre a imagem original e a espelhada (mais robusto a orientação), normalizado L2.
 *  - color: histograma de cor (36 bins) só dos pixels do produto, ignorando o fundo claro.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.BuscaVision = factory();
})(typeof self !== "undefined" ? self : this, function () {
  const FEATURE_NODE = "module_apply_default/MobilenetV2/Conv_1/Relu6";
  const SIZE = 224;
  const GEM_P = 3;
  const HUE_BINS = 12, SAT_BINS = 2, VAL_BINS = 1, GRAY_BINS = 4;
  const COLOR_DIM = HUE_BINS * SAT_BINS * VAL_BINS * 2 + GRAY_BINS; // 52

  // Coloca a imagem num quadrado com fundo branco (fotos de produto costumam ter fundo branco)
  function toSquare(tf, img) {
    return tf.tidy(() => {
      const [h, w] = img.shape;
      const s = Math.max(h, w);
      const top = Math.floor((s - h) / 2), left = Math.floor((s - w) / 2);
      const f = img.toFloat();
      return f.pad([[top, s - h - top], [left, s - w - left], [0, 0]], 255);
    });
  }

  function deepFeatures(tf, model, img) {
    return tf.tidy(() => {
      const sq = toSquare(tf, img);
      const x = tf.image.resizeBilinear(sq, [SIZE, SIZE], true).div(255);
      const batch = tf.stack([x, x.reverse(1)]);
      const fmap = model.execute(batch, FEATURE_NODE); // [2,7,7,1280]
      const gem = fmap.clipByValue(1e-6, 1e6).pow(GEM_P).mean([1, 2]).pow(1 / GEM_P); // [2,1280]
      const v = gem.mean(0);
      return v.div(v.norm());
    });
  }

  function rgbToHsv(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
    let h = 0;
    if (d > 0) {
      if (max === r) h = ((g - b) / d) % 6;
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60; if (h < 0) h += 360;
    }
    return [h, max === 0 ? 0 : d / max, max];
  }

  // pixels: Uint8 RGB(A) array, channels = 3 ou 4
  function colorHistogram(pixels, channels) {
    const hist = new Float32Array(COLOR_DIM);
    let total = 0;
    for (let i = 0; i < pixels.length; i += channels) {
      const r = pixels[i], g = pixels[i + 1], b = pixels[i + 2];
      if (channels === 4 && pixels[i + 3] < 128) continue;
      const [h, s, v] = rgbToHsv(r, g, b);
      if (v > 0.93 && s < 0.08) continue; // fundo branco
      let bin;
      if (s < 0.18 || v < 0.15) {
        bin = HUE_BINS * SAT_BINS * 2 + Math.min(GRAY_BINS - 1, Math.floor(v * GRAY_BINS));
      } else {
        const hb = Math.floor(h / (360 / HUE_BINS)) % HUE_BINS;
        const sb = s < 0.55 ? 0 : 1;
        const vb = v < 0.55 ? 0 : 1;
        bin = (hb * SAT_BINS + sb) * 2 + vb;
      }
      hist[bin] += 1; total += 1;
    }
    if (total > 0) for (let i = 0; i < COLOR_DIM; i++) hist[i] /= total;
    return hist;
  }

  function histIntersection(a, b) {
    let s = 0;
    for (let i = 0; i < a.length; i++) s += Math.min(a[i], b[i]);
    return s;
  }

  async function describe(tf, model, img) {
    const deepT = deepFeatures(tf, model, img);
    const deep = await deepT.data();
    deepT.dispose();
    const small = tf.tidy(() => tf.image.resizeBilinear(img.toFloat(), [64, 64]).round().toInt());
    const px = await small.data();
    small.dispose();
    return { deep: Float32Array.from(deep), color: colorHistogram(px, 3) };
  }

  return { FEATURE_NODE, COLOR_DIM, describe, colorHistogram, histIntersection };
});
