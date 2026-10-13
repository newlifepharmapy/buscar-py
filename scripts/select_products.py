"""Seleciona produtos do dataset Amazon Berkeley Objects (CC BY 4.0) e baixa as imagens.

Uso: python3 scripts/select_products.py <pasta_abo>
<pasta_abo> deve conter listings/metadata/*.json.gz e images.csv.gz
"""
import csv, gzip, glob, json, os, random, re, sys, urllib.request
from concurrent.futures import ThreadPoolExecutor

ABO = sys.argv[1]
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
IMG_DIR = os.path.join(ROOT, "public", "img")
PER_CAT = 24

# product_type do ABO -> (id, nome em português, faixa de preço em US$)
CATEGORIES = {
    "HEADPHONES": ("fones", "Fones de ouvido", (8, 90)),
    "SPEAKERS": ("caixas-som", "Caixas de som", (15, 120)),
    "WIRELESS_ACCESSORY": ("acessorios-celular", "Cabos e carregadores", (4, 40)),
    "KEYBOARDS": ("teclados", "Teclados", (10, 80)),
    "WATCH": ("relogios", "Relógios", (20, 180)),
    "BACKPACK": ("mochilas", "Mochilas", (15, 90)),
    "SUITCASE": ("malas", "Malas de viagem", (40, 220)),
    "HANDBAG": ("bolsas", "Bolsas", (15, 120)),
    "WALLET": ("carteiras", "Carteiras", (8, 60)),
    "SHOES": ("calcados", "Tênis e sapatos", (20, 140)),
    "BOOT": ("botas", "Botas", (35, 160)),
    "SANDAL": ("sandalias", "Sandálias", (12, 70)),
    "LAMP": ("luminarias", "Luminárias", (18, 110)),
    "SAUTE_FRY_PAN": ("panelas", "Frigideiras e panelas", (12, 75)),
    "CELLULAR_PHONE_CASE": ("capinhas", "Capinhas de celular", (3, 20)),
}

def pick_name(d):
    names = {n["language_tag"]: n["value"] for n in d.get("item_name", [])}
    for tag in ("pt_BR", "en_US", "en_GB", "en_CA", "en_AU", "en_IN"):
        if tag in names:
            return names[tag], tag
    for tag, v in names.items():
        if tag.startswith("en"):
            return v, tag
    return None, None

def main():
    random.seed(42)
    paths = {}
    with gzip.open(os.path.join(ABO, "images.csv.gz"), "rt") as f:
        for row in csv.DictReader(f):
            paths[row["image_id"]] = row["path"]

    pools = {k: [] for k in CATEGORIES}
    for fn in sorted(glob.glob(os.path.join(ABO, "listings/metadata/*.json.gz"))):
        for line in gzip.open(fn, "rt"):
            d = json.loads(line)
            pt = d.get("product_type", [{}])[0].get("value")
            img = d.get("main_image_id")
            if pt not in pools or img not in paths:
                continue
            name, lang = pick_name(d)
            if not name or "renewed" in name.lower():
                continue
            colors = [c["value"] for c in d.get("color", []) if c.get("language_tag", "").startswith("en")]
            pools[pt].append({
                "abo_id": d["item_id"],
                "name": re.sub(r"\s+", " ", name).strip(),
                "name_lang": lang,
                "brand": (d.get("brand") or [{}])[0].get("value", ""),
                "color": colors[0] if colors else "",
                "image_path": paths[img],
            })

    products = []
    for pt, pool in pools.items():
        random.shuffle(pool)
        seen, chosen = set(), []
        for p in pool:
            # evita variações quase idênticas (mesmo nome sem cor/tamanho)
            key = re.sub(r"[^a-z]", "", p["name"].lower().split(",")[0])[:40]
            if key in seen:
                continue
            seen.add(key)
            chosen.append(p)
            if len(chosen) == PER_CAT:
                break
        cid, cname, prange = CATEGORIES[pt]
        for p in chosen:
            p.update(category=cid, category_name=cname, price_range=prange)
            products.append(p)

    def download(p):
        dest = os.path.join(IMG_DIR, p["abo_id"] + ".jpg")
        if not os.path.exists(dest):
            url = "https://amazon-berkeley-objects.s3.amazonaws.com/images/small/" + p["image_path"]
            urllib.request.urlretrieve(url, dest)
        p["image"] = "img/" + p["abo_id"] + ".jpg"

    os.makedirs(IMG_DIR, exist_ok=True)
    with ThreadPoolExecutor(16) as ex:
        list(ex.map(download, products))
    with open(os.path.join(ROOT, "data", "abo_selection.json"), "w") as f:
        json.dump(products, f, ensure_ascii=False, indent=1)
    print(len(products), "produtos selecionados")

if __name__ == "__main__":
    main()
