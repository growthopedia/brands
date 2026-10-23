"""Turn data/products.csv into src/seed.json (the list the app loads on first run).

Run after replacing data/products.csv:  python3 tools/build_seed.py
You can also skip this and upload the new CSV in the app: Settings -> Import product list.
"""
import csv, json, pathlib, sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
COLS = ["Section", "Type", "Brand", "Product", "Model", "List price (USD)", "Status", "Past recall", "Maker page", "Site page"]

src = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "data" / "products.csv"
rows = []
with open(src, encoding="utf-8-sig", newline="") as f:
    for r in csv.DictReader(f):
        if not (r.get("Brand") or "").strip() or not (r.get("Product") or "").strip():
            continue
        rows.append([(r.get(c) or "").strip() for c in COLS])
out = ROOT / "src" / "seed.json"
out.write_text(json.dumps({"columns": COLS, "rows": rows}, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
print(f"{len(rows)} products -> {out.relative_to(ROOT)} ({out.stat().st_size // 1024} KB)")
