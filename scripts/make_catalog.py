"""Gera public/data/catalog.json: produtos + lojas fictícias + ofertas e histórico de preços de exemplo.

Os preços e as lojas são inventados (seed fixa) apenas para demonstrar o comparador.
Na versão real, esta etapa é substituída pelos coletores de preços de cada loja.
"""
import json, os, random, re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

STORES = [
    ("casa-parana", "Casa Paraná Imports", "Ciudad del Este"),
    ("ybyra", "Ybyrá Shopping", "Ciudad del Este"),
    ("guarani-tech", "Guaraní Tech", "Ciudad del Este"),
    ("tres-fronteras", "Tres Fronteras Store", "Ciudad del Este"),
    ("puerto-franco", "Puerto Franco Megastore", "Ciudad del Este"),
    ("jasy", "Jasy Eletrônicos", "Ciudad del Este"),
    ("amambay", "Amambay Center", "Pedro Juan Caballero"),
    ("lago-azul", "Lago Azul Imports", "Pedro Juan Caballero"),
    ("salto-import", "Salto Import Center", "Salto del Guairá"),
    ("galeria-mburuvicha", "Galería Mburuvicha", "Salto del Guairá"),
    ("asuncion-outlet", "Asunción Outlet", "Asunción"),
    ("ponte-amizade", "Ponte da Amizade Store", "Ciudad del Este"),
]

def clean_name(name):
    name = re.sub(r"^(Amazon Brand|Marca Amazon)\s*[-–]\s*", "", name)
    name = re.sub(r"^Amazon Brand\s+", "", name)
    return name.strip(" ,-")

def main():
    rnd = random.Random(7)
    sel = json.load(open(os.path.join(ROOT, "data", "abo_selection.json")))
    stores = [{"id": s, "name": n, "city": c, "rating": round(rnd.uniform(3.6, 4.9), 1)} for s, n, c in STORES]
    products, categories = [], {}
    for i, p in enumerate(sel):
        lo, hi = p["price_range"]
        base = round(rnd.uniform(lo, hi), 2)
        k = rnd.choice([2, 3, 3, 4, 4, 5, 6, 7])
        offers = []
        for s in rnd.sample(stores, k):
            price = round(base * rnd.uniform(0.88, 1.18), 2)
            offers.append({
                "store": s["id"],
                "price": price,
                "in_stock": rnd.random() > 0.12,
                "updated_days_ago": rnd.randint(0, 6),
            })
        offers.sort(key=lambda o: o["price"])
        # histórico semanal do menor preço (26 semanas)
        hist, v = [], base * rnd.uniform(1.05, 1.3)
        for _ in range(26):
            v = max(base * 0.85, v * rnd.uniform(0.97, 1.025))
            hist.append(round(v, 2))
        avail = [o for o in offers if o["in_stock"]] or offers
        hist[-1] = avail[0]["price"]  # o histórico termina no menor preço disponível hoje
        categories[p["category"]] = p["category_name"]
        products.append({
            "id": i,
            "name": clean_name(p["name"]),
            "brand": p["brand"],
            "color": p["color"],
            "category": p["category"],
            "image": p["image"],
            "source_id": p["abo_id"],
            "offers": offers,
            "history": hist,
        })
    out = {
        "generated": "2026-10-13",
        "rates": {"BRL": 5.45, "PYG": 7900},
        "stores": stores,
        "categories": [{"id": k, "name": v} for k, v in categories.items()],
        "products": products,
    }
    with open(os.path.join(ROOT, "public", "data", "catalog.json"), "w") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
    print(len(products), "produtos,", sum(len(p["offers"]) for p in products), "ofertas")

if __name__ == "__main__":
    main()
