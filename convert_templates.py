"""
Convert ALL escaped template literals (\`...\${expr}...\`) in the SessionPanel.ts
webview <script> block to string concatenation ('...'+expr+'...').

This fixes the esbuild issue where \` inside a TypeScript template literal
outputs a bare backtick in the JS, crashing the browser parser.

Strategy:
1. Find the <script>...</script> block in SessionPanel.ts
2. Process character-by-character to find \`...\` pairs
3. Inside each pair, convert \${expr} to '+expr+'
4. Replace \` delimiters with ' quotes
"""
import sys

path = r"C:\Users\trist\Development\BitConcepts\specsmith-vscode\src\SessionPanel.ts"
code = open(path, encoding="utf-8").read()

# Find the main webview script block
marker = "<script>\nconst vscode=acquireVsCodeApi();"
script_start = code.find(marker)
script_end = code.find("\n</script>", script_start)

if script_start < 0 or script_end < 0:
    print("ERROR: Could not find script block")
    sys.exit(1)

before = code[:script_start + len("<script>\n")]
script = code[script_start + len("<script>\n"):script_end]
after = code[script_end:]

print(f"Script block: {len(script)} chars")
print(f"Escaped backticks before: {script.count(chr(92) + chr(96))}")

# Process the script to convert \`...\` template literals to '...' + expr + '...'
result = []
i = 0
conversions = 0

while i < len(script):
    # Check for \` (escaped backtick = template literal start)
    if i < len(script) - 1 and script[i] == '\\' and script[i+1] == '`':
        # Found opening \` — scan for closing \`
        i += 2  # skip \`
        template_content = []
        found_close = False
        
        while i < len(script):
            if i < len(script) - 1 and script[i] == '\\' and script[i+1] == '`':
                # Found closing \`
                i += 2
                found_close = True
                break
            else:
                template_content.append(script[i])
                i += 1
        
        if not found_close:
            # Unclosed template — just output as-is (shouldn't happen)
            result.append('\\`')
            result.extend(template_content)
            continue
        
        # Convert the template content
        content = ''.join(template_content)
        
        # Split on \${...} interpolations
        # Pattern: \${ ... }
        parts = []
        j = 0
        current_str = []
        
        while j < len(content):
            if j < len(content) - 2 and content[j] == '\\' and content[j+1] == '$' and content[j+2] == '{':
                # Found \${ — extract the expression until }
                # Save current string part
                if current_str:
                    parts.append(('str', ''.join(current_str)))
                    current_str = []
                
                j += 3  # skip \${
                brace_depth = 1
                expr_chars = []
                while j < len(content) and brace_depth > 0:
                    if content[j] == '{':
                        brace_depth += 1
                    elif content[j] == '}':
                        brace_depth -= 1
                        if brace_depth == 0:
                            j += 1
                            break
                    expr_chars.append(content[j])
                    j += 1
                parts.append(('expr', ''.join(expr_chars)))
            else:
                current_str.append(content[j])
                j += 1
        
        if current_str:
            parts.append(('str', ''.join(current_str)))
        
        # Build the concatenated string
        segments = []
        for kind, val in parts:
            if kind == 'str':
                # Escape single quotes in the string content
                escaped = val.replace("'", "\\'")
                segments.append("'" + escaped + "'")
            else:
                segments.append(val)
        
        if not segments:
            result.append("''")
        elif len(segments) == 1:
            result.append(segments[0])
        else:
            result.append('+'.join(segments))
        
        conversions += 1
    else:
        result.append(script[i])
        i += 1

new_script = ''.join(result)
print(f"Conversions made: {conversions}")
print(f"Escaped backticks after: {new_script.count(chr(92) + chr(96))}")

new_code = before + new_script + after
open(path, "w", encoding="utf-8").write(new_code)
print(f"Written to {path}")
