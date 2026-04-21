"""Check all <script> blocks in built extension.js for syntax errors."""
import re, subprocess, os, tempfile

js = open("out/extension.js", encoding="utf-8", errors="replace").read()
blocks = list(re.finditer(r"<script>([\s\S]*?)</script>", js))
print(f"{len(blocks)} script blocks")

STUB = (
    "function acquireVsCodeApi(){return{postMessage:function(){}}}\n"
    "var document={getElementById:function(){return{style:{},dataset:{ver:''},textContent:'',value:'',classList:{toggle:function(){},add:function(){},remove:function(){}},closest:function(){return null},querySelector:function(){return null},querySelectorAll:function(){return[]},options:[],appendChild:function(){},innerHTML:'',disabled:false,checked:false,remove:function(){}}},querySelectorAll:function(){return[]},createElement:function(){return{style:{},className:'',textContent:'',onclick:null,appendChild:function(){},classList:{add:function(){}}}}}\n"
    "var window={addEventListener:function(){}}\n"
    "var navigator={clipboard:{writeText:function(){return{then:function(){return{catch:function(){}}}}}}}\n"
    "var confirm=function(){return true}\n"
    "var FileReader=function(){}\n"
    "var setTimeout=function(){}\n"
    "var clearTimeout=function(){}\n"
)

for i, m in enumerate(blocks):
    s = m.group(1)
    t = os.path.join(tempfile.gettempdir(), f"check_b{i}.js")
    with open(t, "w", encoding="utf-8") as f:
        f.write(STUB)
        f.write(s)
    r = subprocess.run(["node", "--check", t], capture_output=True, text=True, timeout=5)
    if r.returncode != 0:
        lines = r.stderr.strip().split("\n")
        print(f"BLOCK {i}: SYNTAX ERROR")
        for ln in lines[:3]:
            print(f"  {ln}")
    else:
        print(f"BLOCK {i}: OK ({len(s)} chars)")
    os.unlink(t)
