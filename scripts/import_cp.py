"""Junta ao catálogo (public/data/catalog.json) os produtos, ofertas e lojas lidos no Compras Paraguai.

Entrada: data/comprasparaguai.json (o que foi lido nas páginas do site, sem nada inventado).
Os produtos de exemplo (ids 0 a 341, com vetores prontos em embeddings.bin) ficam como estão e na mesma
ordem; os importados entram depois deles. Rodar de novo troca a importação anterior pela nova.

Cada produto importado fica com uma oferta por loja: o menor preço daquela loja entre os anúncios do mesmo
modelo e tamanho (matches=true). As fotos e logos ficam no servidor de imagens do Compras Paraguai; o
servidor do site baixa cada uma uma vez (lib/remote-images.js) e serve por /img/cp/ e /img/lojas/.
"""
import json, os, re, sys, unicodedata
from urllib.parse import urlparse, quote_plus, parse_qsl, urlencode

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(ROOT, "data", "comprasparaguai.json")
CATALOG = os.path.join(ROOT, "public", "data", "catalog.json")
IMG_HOSTS = {"us-ord-10.linodeobjects.com", "bucket-prod.us-ord-10.linodeobjects.com"}
EXT = (".avif", ".webp", ".jpg", ".jpeg", ".png")

# categorias novas (entram antes das de exemplo na barra de categorias)
NEW_CATS = [
    ("celulares", "Celulares"), ("notebooks", "Notebooks"), ("tablets", "Tablets"),
    ("perfumes", "Perfumes"), ("beleza", "Beleza e cuidados"), ("games", "Games"),
    ("drones", "Drones"), ("eletro", "Casa e eletro"),
]
# (padrão no nome, categoria) — o primeiro que casar vale
CAT_RULES = [
    (r"^celular\b|\biphone\b", "celulares"), (r"^notebook\b|\bmacbook\b", "notebooks"), (r"^tablet\b|\bipad\b", "tablets"),
    (r"^perfume\b|eau de (parfum|toilette)|\bextrait\b", "perfumes"),
    (r"shampoo|condicionador|mascara|serum|medicube|creme|tonico|pad\b|mask", "beleza"),
    (r"playstation|nintendo|switch|xbox", "games"), (r"^drone\b|\bdji\b", "drones"),
    (r"caixa de som|\bjoog\b", "caixas-som"), (r"robo|aspirador|vacuum", "eletro"),
]
# palavra do tipo no começo do nome que a categoria já diz (sai do nome, mas continua valendo na busca)
STRIP = r"^(celular|notebook|tablet|perfume)\s+"
KIND = {"celulares": "Celular", "notebooks": "Notebook", "tablets": "Tablet", "perfumes": "Perfume"}
# destaques na página inicial, na ordem pedida (misturados para as três primeiras linhas terem todas as marcas)
FEATURED = [
    r"iphone 18 pro max", r"macbook air", r"shampoo.*fino", r"creed aventus",
    r"iphone duo", r"macbook pro", r"condicionador.*fino", r"initio.*oud for greatness",
    r"macbook neo", r"mascara.*fino", r"medicube", r"nishane.*hacivat",
    r"medicube", r"medicube", r"creed", r"initio", r"nishane",
]
# anúncio de atacado (preço para compra em quantidade): não é o preço que a loja cobra de quem compra um
WHOLESALE = r"\(atacado\)|\bwholesale\b|\bmayorista\b"
# marcadores de campanha e de compartilhamento que vêm no endereço do site da loja
TRACKING = re.compile(r"^(utm_\w+|fbclid|gclid|igsh|igshid|mibextid)$", re.I)


def norm(s):
    s = unicodedata.normalize("NFD", s or "").encode("ascii", "ignore").decode().lower()
    return re.sub(r"\s+", " ", s).strip()


def slug(s):
    return re.sub(r"[^a-z0-9]+", "-", norm(s)).strip("-")


def img_ok(url):
    try:
        u = urlparse(url or "")
    except ValueError:
        return False
    return u.scheme == "https" and u.hostname in IMG_HOSTS and u.path.lower().endswith(EXT) and "loading" not in u.path


def ext_of(url):
    e = os.path.splitext(urlparse(url).path)[1].lower()
    return ".jpg" if e == ".jpeg" else e


MONTHS = {m: i + 1 for i, m in enumerate("janeiro fevereiro marco abril maio junho julho agosto setembro outubro novembro dezembro".split())}


def listing_date(s, fallback):
    """'27 de Outubro de 2026' -> '2026-10-27'"""
    m = re.search(r"(\d{1,2}) de (\w+) de (\d{4})", norm(s or ""))
    if not m or m.group(2) not in MONTHS:
        return fallback
    return "%s-%02d-%02d" % (m.group(3), MONTHS[m.group(2)], int(m.group(1)))


def main():
    raw = json.load(open(RAW, encoding="utf8"))
    date = raw["read_at"]
    cat = json.load(open(CATALOG, encoding="utf8"))
    # tira a importação anterior (se houver), lembrando o id de cada produto: quem já existia fica com o
    # mesmo id sempre que der (os links antigos /#p<id> continuam abrindo o mesmo produto)
    prev_id = {p.get("key") or p["source_url"]: p["id"] for p in cat["products"] if p.get("source") == "comprasparaguai"}
    base = [p for p in cat["products"] if p.get("source") != "comprasparaguai"]
    assert all(p["id"] == i for i, p in enumerate(base)), "os produtos de exemplo precisam continuar com id = posição"
    fake_stores = [s for s in cat["stores"] if not s.get("real")]
    new_ids = {c for c, _ in NEW_CATS}
    old_cats = [c for c in cat["categories"] if c["id"] not in new_ids]

    # lojas do diretório /lojas/ (logo, especialidade, horário, site)
    directory = {}
    for s in raw["stores"]:
        sl = s["slug"].strip("/").split("/")[-1]
        if sl and sl not in directory:
            directory[sl] = s
    # página de cada loja (/lojas/<slug>/): cidade e, se o diretório não trouxe, logo, horário e site
    for s in raw.get("store_pages", []):
        if not s.get("page_read"):
            continue
        d = directory.setdefault(s["slug"], {"slug": s["slug"]})
        d["city"] = s.get("city")
        d["cities"] = s.get("cities") or []
        # o horário da página da loja vem completo (o cartão do diretório mostra só o primeiro dia)
        d["full_hours"] = s.get("hours")
        if s.get("website"):
            d["website"] = s["website"]
        for k in ("name", "logo_url", "specialty"):
            if not d.get(k) or (k == "logo_url" and not img_ok(d.get(k))):
                d[k] = s.get(k)
    warn = []
    # nome da loja -> slug, para as páginas que mostram a loja só pelo nome (sem link /lojas/<slug>/)
    by_name = {norm(d.get("name") or ""): sl for sl, d in directory.items() if d.get("name")}
    for g in raw["groups"]:
        for rp in g["products"]:
            for o in rp["offers"]:
                if o.get("store_slug") and o.get("store_name"):
                    by_name.setdefault(norm(o["store_name"]), o["store_slug"].strip("/").split("/")[-1])
    unknown = set()
    products, used = [], {}
    seen_urls = set()
    for g in raw["groups"]:
        for rp in g["products"]:
            url = rp["url"]
            m = re.search(r"_(\d+)/?$", url)
            if not m or url in seen_urls:
                warn.append("ignorado (sem id de modelo ou repetido): " + url)
                continue
            seen_urls.add(url)
            if not img_ok(rp.get("image_url")):
                warn.append("sem foto válida: " + rp["name"])
                continue
            best = {}
            for o in rp["offers"]:
                if not o.get("matches") or not isinstance(o.get("price_usd"), (int, float)) or o["price_usd"] <= 0:
                    continue
                if re.search(WHOLESALE, o.get("variant") or "", re.I):
                    continue
                sl = (o.get("store_slug") or "").strip("/").split("/")[-1] or by_name.get(norm(o.get("store_name") or ""))
                if not sl:  # loja que não dá para identificar com certeza: a oferta fica de fora
                    unknown.add(o.get("store_name") or "?")
                    continue
                if sl not in best or o["price_usd"] < best[sl]["price_usd"]:
                    best[sl] = {**o, "store_slug": sl}
            if not best:
                warn.append("sem ofertas do mesmo modelo: " + rp["name"])
                continue
            n = norm(rp["name"])
            category = next((c for pat, c in CAT_RULES if re.search(pat, n)), None)
            if not category:
                warn.append("sem categoria: " + rp["name"])
                continue
            upd = listing_date(rp.get("last_listing"), date)
            offers = sorted(({"store": sl, "price": round(float(o["price_usd"]), 2), "in_stock": True, "updated": upd} for sl, o in best.items()),
                            key=lambda o: o["price"])
            lo = offers[0]["price"]
            if rp.get("a_partir_de_usd") and abs(lo - rp["a_partir_de_usd"]) / rp["a_partir_de_usd"] > 0.15:
                warn.append("menor preço lido %.2f longe do 'a partir de' %.2f: %s" % (lo, rp["a_partir_de_usd"], rp["name"]))
            for sl, o in best.items():
                used.setdefault(sl, o.get("store_name") or sl)
            name = re.sub(STRIP, "", rp["name"].strip(), flags=re.I)
            # "Apple MacBook Air 2026 Apple M5 / Memória 16GB" -> "Apple MacBook Air 2026 M5 / 16GB"
            name = re.sub(r"\s+Apple\s+(?=[AM]\d)", " ", name)
            name = re.sub(r"\bMem[oó]ria\s+", "", name)
            name = re.sub(r"\bPafum\b", "Parfum", name)  # erro de digitação no título do site
            products.append({
                "key": "cp" + m.group(1),
                "name": name, "brand": rp.get("brand") or "", "color": "", "category": category,
                **({"kind": KIND[category]} if category in KIND else {}),
                "image": "img/cp/%s%s" % (m.group(1), ext_of(rp["image_url"])), "image_src": rp["image_url"],
                # sem página do modelo (só anúncios de uma loja cada, "__<n>/"): o link leva à busca do site
                "source": "comprasparaguai",
                "source_url": url if not re.search(r"__\d+/?$", url) else "https://www.comprasparaguai.com.br/busca/?q=" + quote_plus(name),
                "source_offers": rp.get("offers_claimed"), "source_stores": rp.get("stores_claimed"),
                "offers": offers, "history": None,
            })

    # destaques: cada padrão marca o primeiro produto ainda sem destaque que casar
    rank = 1
    for pat in FEATURED:
        hit = next((p for p in products if "featured" not in p and re.search(pat, norm(p["name"]))), None)
        if hit:
            hit["featured"] = rank
            rank += 1

    # lojas reais: as das ofertas e as outras do diretório do Compras Paraguai (essas só se tiverem logo)
    for sl, d in directory.items():
        if sl not in used and img_ok(d.get("logo_url")):
            used[sl] = d.get("name") or sl
    stores = []
    for sl, name in used.items():
        d = directory.get(sl)
        if not d:
            warn.append("loja fora do diretório e sem página lida: " + sl)
        logo_src = d.get("logo_url") if d else None
        logo_src = logo_src if img_ok(logo_src) else None
        # cidade da loja (a do primeiro endereço) e todas as cidades onde ela tem filial
        city = (d or {}).get("city") or None
        cities = [c for c in dict.fromkeys([city] + list((d or {}).get("cities") or [])) if c]
        if not city and any(o["store"] == sl for p in products for o in p["offers"]):
            warn.append("loja com ofertas e sem cidade: " + sl)
        # horário como a página da loja mostra, sem as observações que vieram junto na leitura (o do cartão do
        # diretório fica de fora: ele traz só o primeiro dia e pareceria o horário da semana toda)
        hours = re.sub(r"[,;]?\s*same for [\w ]*?branch(es)?\b", "", (d or {}).get("full_hours") or "", flags=re.I)
        hours = re.sub(r"\bBranches (\d+) and (\d+)", r"Filiais \1 e \2", hours)
        hours = re.sub(r"\bBranch (\d+)", r"Filial \1", hours)
        hours = re.sub(r"\(\s*Horário de Brasília\s*;\s*\)", "(Horário de Brasília)", hours)
        hours = re.sub(r"(^|;\s*)[-–·]+\s*", r"\1", hours).strip(" ;,-–·") or None
        site = (d or {}).get("website") or None
        if site and not re.match(r"^https?://", site):
            site = "https://" + site
        if site and (urlparse(site).hostname or "").endswith("comprasparaguai.com.br"):
            site = None
        if site:  # sem marcadores de campanha (?fbclid=..., ?utm_..., ?igsh=...)
            u = urlparse(site)
            q = urlencode([kv for kv in parse_qsl(u.query, keep_blank_values=True) if not TRACKING.match(kv[0])])
            site = u._replace(query=q).geturl()
        stores.append({
            "id": sl, "name": (d or {}).get("name") or name, "city": city, "cities": cities, "rating": None,
            "real": True, "specialty": re.sub(r"\s*\(.*\)$", "", re.sub(r"^Loja de\s+", "", ((d or {}).get("specialty") or "").strip())) or None, "hours": hours,
            "website": site, "premium": bool((d or {}).get("premium")),
            **({"logo": "img/lojas/%s%s" % (sl, ext_of(logo_src)), "logo_src": logo_src} if logo_src else {}),
        })
        if not logo_src:
            warn.append("loja sem logo válida: " + sl)
    clash = {s["id"] for s in fake_stores} & {s["id"] for s in stores}
    assert not clash, "id de loja repetido: %s" % clash

    # ids dos importados (id = posição na lista, como os de exemplo): quem já existia fica com o id de antes;
    # os novos (destaques primeiro) ocupam as vagas de quem saiu e depois entram no fim
    order = {c: i for i, (c, _) in enumerate(NEW_CATS)}
    ids = range(len(base), len(base) + len(products))
    for p in products:
        old = prev_id.get(p["key"], prev_id.get(p["source_url"]))
        p["id"] = old if old in ids else None
    taken = {p["id"] for p in products}
    free = iter(i for i in ids if i not in taken)
    for p in sorted((p for p in products if p["id"] is None), key=lambda p: (p.get("featured") or 1e9, order.get(p["category"], 99))):
        p["id"] = next(free)
    products.sort(key=lambda p: p["id"])
    used_cats = {p["category"] for p in products}
    cat["categories"] = [{"id": c, "name": nm} for c, nm in NEW_CATS if c in used_cats] + old_cats
    # lojas reais primeiro (as com mais produtos), depois as de exemplo
    count = {}
    for p in products:
        for o in p["offers"]:
            count[o["store"]] = count.get(o["store"], 0) + 1
    stores.sort(key=lambda s: (-count.get(s["id"], 0), norm(s["name"])))
    cat["stores"] = stores + fake_stores
    cat["products"] = base + products
    cat["imported"] = {"source": "comprasparaguai", "url": "https://www.comprasparaguai.com.br/", "date": date}
    json.dump(cat, open(CATALOG, "w", encoding="utf8"), ensure_ascii=False, separators=(",", ":"))

    print("produtos importados: %d (%d em destaque), lojas reais: %d, ofertas: %d" % (
        len(products), sum(1 for p in products if p.get("featured")), len(stores), sum(len(p["offers"]) for p in products)))
    print("lojas com ofertas: %d; com cidade: %d; com logo: %d" % (len(count), sum(1 for s in stores if s["city"]), sum(1 for s in stores if s.get("logo"))))
    for p in products:
        print("  %s#%d %-11s %-70s %d lojas, a partir de US$ %.2f" % (
            "*" if p.get("featured") else " ", p["id"], p["category"], p["name"][:70], len(p["offers"]), p["offers"][0]["price"]))
    if unknown:
        warn.append("ofertas sem loja identificada (ficaram de fora): " + ", ".join(sorted(unknown)))
    for w in warn:
        print("aviso:", w, file=sys.stderr)


if __name__ == "__main__":
    main()
