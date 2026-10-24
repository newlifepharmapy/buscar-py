"""Gera dist/artifact/index.html: a página com CSS e JS embutidos (para hospedagem estática restrita).
Os dados, o modelo e as imagens continuam como arquivos ao lado da página."""
import base64, json, os, re, shutil, subprocess
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PUB = os.path.join(ROOT, "public")
OUT = os.path.join(ROOT, "dist", "artifact")

# a página vem do modelo views/index.html, preenchida com as configurações padrão
html = subprocess.run(["node", os.path.join(ROOT, "scripts", "render_static.js"), "index.html"], check=True, capture_output=True, text=True).stdout
# a página de câmeras vira cameras.html ao lado da página principal: o link abre na mesma janela
html = html.replace('href="/cameras"', 'href="cameras.html"')
body = html.split("<!-- ARTIFACT:START -->")[1].split("<!-- ARTIFACT:END -->")[0]
body = body.replace("</head>\n<body>\n", "")
css = open(os.path.join(PUB, "css/app.css"), encoding="utf8").read()
body = body.replace('<link rel="stylesheet" href="css/app.css">', "<style>\n" + css + "</style>")
def inline(m):
    src = open(os.path.join(PUB, m.group(1)), encoding="utf8").read()
    assert "</script" not in src
    return "<script>\n" + src + "\n</script>"
body = re.sub(r'<script src="([^"]+)"></script>', inline, body)
body = body.replace("<script>\n", "<script>window.BUSCA_B64 = true;</script>\n<script>\n", 1)
os.makedirs(OUT, exist_ok=True)
open(os.path.join(OUT, "index.html"), "w", encoding="utf8").write(body)

# cameras.html: página completa (a hospedagem só embrulha a página principal), com CSS e JS embutidos.
# A demonstração não pode abrir vídeos de outros sites (window.BUSCA_DEMO): cada câmera explica isso.
cams = subprocess.run(["node", os.path.join(ROOT, "scripts", "render_static.js"), "cameras.html", "/cameras"], check=True, capture_output=True, text=True).stdout
cams = re.sub(r'<link rel="(icon|canonical)"[^>]*>\n', "", cams)
cams = cams.replace('<link rel="stylesheet" href="/css/app.css">', "<style>\n" + css + "</style>")
assert "/theme.css" not in cams and "/brand-logo" not in cams
cams = re.sub(r'<script src="/([^"]+)"></script>', inline, cams)
cams = cams.replace("<script>\n", "<script>window.BUSCA_B64 = true; window.BUSCA_DEMO = true;</script>\n<script>\n", 1)
cams = cams.replace('href="/cameras"', 'href="cameras.html"').replace('href="/"', 'href="index.html"').replace('action="/"', 'action="index.html"')
assert not re.search(r'(href|src|action)="/(?!/)', cams), "caminho absoluto sobrando em cameras.html"
open(os.path.join(OUT, "cameras.html"), "w", encoding="utf8").write(cams)
shutil.rmtree(OUT + "/img", ignore_errors=True)
for d in ("data", "model"):
    shutil.copytree(os.path.join(PUB, d), os.path.join(OUT, d), dirs_exist_ok=True)
# binários viram base64 em .b64.txt (a hospedagem de artifacts não serve octet-stream)
for rel in ["data/embeddings.bin", "data/colors.bin"] + ["model/group1-shard%dof4" % i for i in range(1, 5)]:
    src = os.path.join(OUT, rel)
    open(src + ".b64.txt", "w").write(base64.b64encode(open(src, "rb").read()).decode())
    os.remove(src)
# imagens embutidas no catálogo (data URI) para publicar poucos arquivos
cat = json.load(open(os.path.join(PUB, "data/catalog.json"), encoding="utf8"))
for p in cat["products"]:
    raw = open(os.path.join(PUB, p["image"]), "rb").read()
    p["image"] = "data:image/jpeg;base64," + base64.b64encode(raw).decode()
json.dump(cat, open(os.path.join(OUT, "data/catalog.json"), "w", encoding="utf8"), ensure_ascii=False, separators=(",", ":"))
print("ok", os.path.getsize(os.path.join(OUT, "index.html")) // 1024, "KB +", os.path.getsize(os.path.join(OUT, "cameras.html")) // 1024, "KB")
