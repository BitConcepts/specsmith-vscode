"""Convert escaped template literals (\`...\`) in SessionPanel.ts webview
script to string concatenation ('...'+expr+'...').

This is needed because esbuild outputs \` as a literal backtick in the 
JS string, which starts an unintended template literal in the browser.
"""
import re

path = r"src/SessionPanel.ts"
code = open(path, encoding="utf-8").read()

# Find the webview script section (between <script> and </script>)
script_start = code.find("<script>\nconst vscode=acquireVsCodeApi();")
script_end = code.find("</script>", script_start)

if script_start < 0 or script_end < 0:
    print("Could not find script block")
    exit(1)

before = code[:script_start]
script = code[script_start:script_end + len("</script>")]
after = code[script_end + len("</script>"):]

# Inside the script block, convert \`...\${expr}...\` to '...'+expr+'...'
# Strategy: find each \`...\` block and convert it

def convert_template(match):
    """Convert a \\`...\\` template literal to string concatenation."""
    inner = match.group(0)
    # Remove the opening \` and closing \`
    inner = inner[2:-2]  # strip \` from both ends
    
    # Split on \${...} interpolations
    parts = re.split(r'\\\$\{([^}]+)\}', inner)
    
    if len(parts) == 1:
        # No interpolations — just a plain string
        # Escape any single quotes
        escaped = parts[0].replace("'", "\\'")
        return "'" + escaped + "'"
    
    # Build concatenation: 'part0'+expr1+'part2'+expr3+...
    result_parts = []
    for i, part in enumerate(parts):
        if i % 2 == 0:
            # String part
            if part:
                escaped = part.replace("'", "\\'")
                result_parts.append("'" + escaped + "'")
        else:
            # Expression part
            result_parts.append(part)
    
    return "+".join(result_parts) if result_parts else "''"

# Pattern: \`...\` (escaped backtick template literal)
# This matches from \` to the next \`, handling \${...} inside
converted = re.sub(
    r'\\`((?:[^`\\]|\\[^`]|\\\\)*)\\`',
    convert_template,
    script
)

count = script.count("\\`") - converted.count("\\`")
print(f"Converted {count} escaped backticks")

result = before + converted + after
open(path, "w", encoding="utf-8").write(result)
print("Done — saved to", path)
