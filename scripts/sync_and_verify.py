#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Sincroniza a pasta /app/ com a raiz, recalcula addons.xml.md5 e valida o projeto."""

import hashlib
import os
import shutil
import subprocess
import sys
import xml.etree.ElementTree as ET

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def main():
    # 1. Sincroniza /app/ com os arquivos principais da raiz
    app_dir = os.path.join(ROOT, "app")
    os.makedirs(app_dir, exist_ok=True)
    for fname in ("index.html", "app.css", "app.js", "sw.js", "manifest.webmanifest"):
        src = os.path.join(ROOT, fname)
        dst = os.path.join(app_dir, fname)
        if os.path.exists(src):
            shutil.copy2(src, dst)
    print("[OK] Pasta /app/ sincronizada com a raiz.")

    # 2. Valida addons.xml e atualiza addons.xml.md5
    addons_xml = os.path.join(ROOT, "addons.xml")
    addons_md5 = os.path.join(ROOT, "addons.xml.md5")
    ET.parse(addons_xml)
    with open(addons_xml, "rb") as fh:
        digest = hashlib.md5(fh.read()).hexdigest()
    with open(addons_md5, "w", encoding="utf-8") as fh:
        fh.write(digest)
    print(f"[OK] addons.xml validado e addons.xml.md5 atualizado ({digest}).")

    # 3. Valida sintaxe JS se o Node estiver instalado
    if shutil.which("node"):
        for js_file in ("app.js", "sw.js"):
            res = subprocess.run(["node", "--check", os.path.join(ROOT, js_file)], capture_output=True, text=True)
            if res.returncode != 0:
                print(f"[ERRO] Falha de sintaxe em {js_file}:\n{res.stderr}", file=sys.stderr)
                sys.exit(1)
        print("[OK] Sintaxe JavaScript (app.js, sw.js) verificada.")


if __name__ == "__main__":
    main()
