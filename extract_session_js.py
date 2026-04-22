"""Extract SessionPanel webview JS from the git HEAD version of SessionPanel.ts
and un-escape it for use as a standalone .js file."""
import subprocess, re

# Get the original SessionPanel.ts from git HEAD (before our inline removal)
result = subprocess.run(
    ["git", "-C", r"C:\Users\trist\Development\BitConcepts\specsmith-vscode",
     "show", "HEAD:src/SessionPanel.ts"],
    capture_output=True, text=True, encoding="utf-8", errors="replace",
)
code = result.stdout
print(f"SessionPanel.ts from HEAD: {len(code)} chars")

# Extract the <script>...</script> content
marker = "<script>\nconst vscode=acquireVsCodeApi();"
s = code.find(marker)
e = code.find("\n</script>", s)
if s < 0 or e < 0:
    print("ERROR: Could not find script block")
    exit(1)

script = code[s + len("<script>\n") : e]
print(f"Extracted script: {len(script)} chars, {script.count(chr(10))} lines")

# Un-escape for standalone JS:
# In the TS template literal, these escape sequences produce:
#   \`  → literal backtick (template literal delimiter in JS)
#   \${ → literal ${ (template interpolation in JS)
#   \\  → literal backslash
#   \\n in strings → \n (the double-backslash produces one backslash)
#
# We need to convert the TS-escaped form to raw JS:
#   \` → `
#   \${ → ${
#   BUT: \\n should stay as \\n (it's already correct for JS strings)
#   AND: \\' should stay as \\' (correct JS escaping)

# Step 1: Replace \\` with \` FIRST (escaped backtick inside template → stays escaped)
fixed = script.replace("\\\\" + "`", "\x00ESCAPED_BT\x00")

# Step 2: Replace remaining \` with ` (template delimiters)
fixed = fixed.replace("\\" + "`", "`")

# Step 3: Restore escaped backticks inside templates
fixed = fixed.replace("\x00ESCAPED_BT\x00", "\\" + "`")

# Step 4: Replace \\${ with ${ (but preserve \\\\${ as \${)
fixed = fixed.replace("\\\\" + "${", "\x00ESCAPED_DI\x00")
fixed = fixed.replace("\\" + "${", "${")
fixed = fixed.replace("\x00ESCAPED_DI\x00", "\\" + "${")

# Step 5: Replace remaining \\\\ with \\ (double backslash → single)
fixed = fixed.replace("\\\\\\\\", "\\\\")

# Verify
bt_count = fixed.count("`")
interp_count = fixed.count("${")
print(f"After un-escaping: {bt_count} backticks, {interp_count} interpolations")

# Write
outpath = r"C:\Users\trist\Development\BitConcepts\specsmith-vscode\media\session.js"
with open(outpath, "w", encoding="utf-8") as f:
    f.write(fixed)
print(f"Written to {outpath}")

# Verify with node --check
r = subprocess.run(["node", "--check", outpath], capture_output=True, text=True)
if r.returncode == 0:
    print("✓ Node syntax check PASSED")
else:
    err_lines = r.stderr.strip().split("\n")
    print("✗ Node syntax check FAILED:")
    for ln in err_lines[:5]:
        print(f"  {ln}")
