"""Bundle the offline frontend sample without third-party build dependencies."""
from pathlib import Path
import hashlib
import json

root = Path(__file__).resolve().parent.parent
source = root / "samples/conversation-workspace"
output = root / ".tmp/frontend-sample"
output.mkdir(parents=True, exist_ok=True)
html = (source / "index.html").read_text()
html = html.replace('<link rel="stylesheet" href="style.css">', '<style>\n' + (source / "style.css").read_text() + '\n</style>')
for name in ("core.js", "fixture.js", "ui.js"):
    script = (source / name).read_text()
    if "</script" in script.lower():
        raise ValueError(f"Unsafe inline script closing tag in {name}")
    html = html.replace(f'<script src="{name}"></script>', '<script>\n' + script + '\n</script>')
target = output / "Patchouli_Frontend_Sample.html"
target.write_text(html)
manifest = {"file": target.name, "sha256": hashlib.sha256(target.read_bytes()).hexdigest(), "transport": "synthetic MCP fixture", "real_host_verified": False, "browser_verified": False}
(output / "manifest.json").write_text(json.dumps(manifest, indent=2) + '\n')
print(target)
