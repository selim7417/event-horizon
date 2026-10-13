#!/usr/bin/env python3
"""Bundle Event Horizon into a single self-contained HTML file.

No Node, no npm: each ES module becomes a function scope that returns its
exports, imports become destructuring assignments, and the stylesheet and
script are inlined into index.html.

    python3 tools/build.py            -> dist/event-horizon.html
                                         dist/embed.html  (body-only fragment)
"""
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
DIST = ROOT / 'dist'

IMPORT_RE = re.compile(r"^import\s*\{([^}]*)\}\s*from\s*['\"](.+?)['\"];?[ \t]*\n", re.M | re.S)
EXPORT_RE = re.compile(r"^export\s+(?:async\s+)?(?:const|let|function|class)\s+([A-Za-z_$][\w$]*)", re.M)


def module_id(path: pathlib.Path) -> str:
    rel = path.relative_to(ROOT).with_suffix('')
    return '__mod_' + re.sub(r'\W', '_', str(rel))


def collect(entry: pathlib.Path, order: list, seen: set):
    if entry in seen:
        return
    seen.add(entry)
    src = entry.read_text(encoding='utf-8')
    for _, spec in IMPORT_RE.findall(src):
        collect((entry.parent / spec).resolve(), order, seen)
    order.append(entry)


def transform(path: pathlib.Path) -> str:
    src = path.read_text(encoding='utf-8')
    lines = []

    def repl(m):
        names = [n.strip() for n in m.group(1).split(',') if n.strip()]
        dep = module_id((path.parent / m.group(2)).resolve())
        lines.append(f"const {{ {', '.join(names)} }} = {dep};")
        return ''

    body = IMPORT_RE.sub(repl, src)
    exports = EXPORT_RE.findall(body)
    body = re.sub(r'^export\s+', '', body, flags=re.M)
    head = '\n'.join(lines)
    ret = f"return {{ {', '.join(exports)} }};" if exports else ''
    rel = path.relative_to(ROOT)
    return f"// ---- {rel}\nconst {module_id(path)} = (() => {{\n{head}\n{body}\n{ret}\n}})();\n"


def bundle() -> str:
    order: list = []
    collect((ROOT / 'js' / 'main.js').resolve(), order, set())
    js = '\n'.join(transform(p) for p in order)
    return js.replace('</script', '<\\/script')


def main():
    html = (ROOT / 'index.html').read_text(encoding='utf-8')
    css = (ROOT / 'css' / 'style.css').read_text(encoding='utf-8')
    js = bundle()

    link = '<link rel="stylesheet" href="css/style.css">'
    script = '<script type="module" src="js/main.js"></script>'
    if link not in html or script not in html:
        sys.exit('index.html no longer contains the expected stylesheet/script tags')
    single = html.replace(link, f'<style>\n{css}</style>').replace(script, f'<script type="module">\n{js}</script>')
    single = re.sub(r'\s*<meta property="og:image"[^>]*>', '', single)

    DIST.mkdir(exist_ok=True)
    (DIST / 'event-horizon.html').write_text(single, encoding='utf-8')

    # Fragment for hosts that supply their own <html>/<head>/<body> skeleton.
    head = re.search(r'<head>(.*?)</head>', single, re.S).group(1)
    body = re.search(r'<body>(.*?)</body>', single, re.S).group(1)
    keep = [t for t in re.findall(r'<title>.*?</title>|<link[^>]*>|<style>.*?</style>', head, re.S)]
    (DIST / 'embed.html').write_text('\n'.join(keep) + '\n' + body.strip() + '\n', encoding='utf-8')

    kb = lambda p: f"{p.stat().st_size / 1024:.0f} KB"
    print(f"dist/event-horizon.html  {kb(DIST / 'event-horizon.html')}")
    print(f"dist/embed.html          {kb(DIST / 'embed.html')}")


if __name__ == '__main__':
    main()
