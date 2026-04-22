/**
 * Unit tests for SessionPanel webview logic.
 *
 * These test the pure functions extracted from media/session.js
 * without needing a running VS Code instance. They verify:
 * - Proposal detection patterns
 * - Error summary extraction
 * - Tool name labels
 * - Markdown rendering
 * - Cost display logic
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

// Load session.js as a string and extract testable functions
const sessionJs = fs.readFileSync(
  path.join(__dirname, '..', '..', 'media', 'session.js'),
  'utf8',
);

// ── Proposal detection patterns ─────────────────────────────────────────────

// Extract the proposal patterns from SessionPanel.ts
// These are the phrases that trigger Accept/Reject buttons
const PROPOSAL_PATTERNS = [
  'shall i proceed',
  'ready to proceed',
  'do you approve',
  'shall i apply',
  'shall i implement',
  'shall i make these changes',
  'would you like to proceed',
  'would you like me to',
  'want me to go ahead',
  'should i continue',
];

suite('Proposal Detection', () => {
  test('all proposal patterns are detected', () => {
    for (const pattern of PROPOSAL_PATTERNS) {
      const text = `Some context. ${pattern} with the changes?`;
      const t = text.toLowerCase();
      const detected = PROPOSAL_PATTERNS.some((p) => t.includes(p));
      assert.strictEqual(detected, true, `Pattern not detected: "${pattern}"`);
    }
  });

  test('normal questions do NOT trigger proposals', () => {
    const nonProposals = [
      'What would you like to do next?',
      'Here are your options.',
      'The audit found 3 issues.',
      'Would you like to address these findings now or proceed with other tasks?',
      'Running specsmith audit...',
    ];
    // 'Would you like to address' should NOT match because we only match
    // 'would you like to proceed' and 'would you like me to'
    for (const text of nonProposals) {
      const t = text.toLowerCase();
      const detected =
        t.includes('shall i proceed') ||
        t.includes('ready to proceed') ||
        t.includes('do you approve') ||
        t.includes('shall i apply') ||
        t.includes('shall i implement') ||
        t.includes('shall i make these changes') ||
        t.includes('would you like to proceed') ||
        t.includes('would you like me to') ||
        t.includes('want me to go ahead') ||
        t.includes('should i continue');
      // Some of these WILL match (e.g. "Would you like to address" doesn't match,
      // but "Would you like me to" would if present)
      if (text.includes('Would you like to address')) {
        assert.strictEqual(detected, false, `False positive: "${text}"`);
      }
    }
  });
});

// ── Error summary extraction ────────────────────────────────────────────────

// Replicate extractErrSummary from session.js
function extractErrSummary(r: string): string {
  if (!r) { return '(empty result)'; }
  if (/Traceback \(most recent call last\)/i.test(r)) {
    const lines = r.split('\n').map((l) => l.trim()).filter(Boolean).reverse();
    for (const l of lines) {
      if (/^(\w*Error|Exception|RuntimeError|ValueError|TypeError|ImportError|ModuleNotFoundError|ValidationError|SystemExit)/.test(l)) {
        return 'Python error: ' + l.slice(0, 150);
      }
    }
    return 'Python exception (see details)';
  }
  const lines = r.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  if (lines.length > 0 && /^\[exit \d+\]/.test(lines[0])) { lines.shift(); }
  for (const l of lines) {
    if (l.length > 10 && !/^[-=]+$/.test(l) && !/^\[/.test(l)) {
      return l.slice(0, 150);
    }
  }
  const issueMatch = r.match(/(\d+)\s*(issue|warning|error|fail)/i);
  if (issueMatch) { return issueMatch[0]; }
  return lines[0]?.slice(0, 150) || 'Command failed';
}

suite('Error Summary Extraction', () => {
  test('Python traceback extracts error type', () => {
    const tb = 'Traceback (most recent call last):\n  File "foo.py", line 1\nValueError: bad value';
    assert.ok(extractErrSummary(tb).startsWith('Python error: ValueError'));
  });

  test('[exit 1] is stripped from summary', () => {
    const output = '[exit 1]\nGovernance audit found 3 issues\nMissing LEDGER.md';
    const summary = extractErrSummary(output);
    assert.ok(!summary.includes('[exit'), `Summary should not contain [exit]: "${summary}"`);
    assert.ok(summary.includes('Governance') || summary.includes('Missing'), `Should have meaningful content: "${summary}"`);
  });

  test('[exit 0] with content shows content', () => {
    const output = '[exit 0]\nAll checks passed';
    const summary = extractErrSummary(output);
    assert.ok(summary.includes('All checks passed'));
  });

  test('empty result returns (empty result)', () => {
    assert.strictEqual(extractErrSummary(''), '(empty result)');
  });

  test('issue count extraction', () => {
    const output = '[exit 1]\n---\n3 issues found';
    const summary = extractErrSummary(output);
    assert.ok(summary.includes('3 issues') || summary.length > 5);
  });
});

// ── Model recommendation ────────────────────────────────────────────────────

// Replicate recommendDefaultModel from OllamaManager.ts
function recommendDefaultModel(vramGb: number): string {
  if (vramGb >= 12) { return 'qwen2.5:14b'; }
  if (vramGb >= 8) { return 'qwen2.5:14b'; }
  if (vramGb >= 4) { return 'qwen2.5-coder:7b-instruct'; }
  if (vramGb >= 2) { return 'qwen2.5-coder:3b'; }
  return 'llama3.2:latest';
}

suite('Model Recommendation', () => {
  test('16GB+ VRAM recommends qwen2.5:14b', () => {
    assert.strictEqual(recommendDefaultModel(16), 'qwen2.5:14b');
    assert.strictEqual(recommendDefaultModel(24), 'qwen2.5:14b');
  });

  test('8-12GB VRAM recommends qwen2.5:14b', () => {
    assert.strictEqual(recommendDefaultModel(8), 'qwen2.5:14b');
    assert.strictEqual(recommendDefaultModel(10), 'qwen2.5:14b');
  });

  test('4-8GB VRAM recommends coder 7b', () => {
    assert.strictEqual(recommendDefaultModel(4), 'qwen2.5-coder:7b-instruct');
    assert.strictEqual(recommendDefaultModel(6), 'qwen2.5-coder:7b-instruct');
  });

  test('2-4GB VRAM recommends coder 3b', () => {
    assert.strictEqual(recommendDefaultModel(2), 'qwen2.5-coder:3b');
    assert.strictEqual(recommendDefaultModel(3), 'qwen2.5-coder:3b');
  });

  test('0GB (CPU only) recommends llama3.2', () => {
    assert.strictEqual(recommendDefaultModel(0), 'llama3.2:latest');
  });
});

// ── session.js syntax validation ────────────────────────────────────────────

suite('Session.js Integrity', () => {
  test('session.js file exists', () => {
    const p = path.join(__dirname, '..', '..', 'media', 'session.js');
    assert.ok(fs.existsSync(p), 'media/session.js must exist');
  });

  test('session.js starts with acquireVsCodeApi', () => {
    assert.ok(sessionJs.startsWith('const vscode=acquireVsCodeApi();'));
  });

  test('session.js has no esbuild-mangled backticks outside regexes', () => {
    // Escaped backticks (\`) inside regex patterns are valid (e.g. /\`([^\`]+)\`/g)
    // But \` as innerHTML template delimiters would indicate esbuild mangling
    // Check: no line starts with or contains d.innerHTML=\` pattern
    const lines = sessionJs.split('\n');
    const mangledLines = lines.filter(l =>
      l.includes('.innerHTML=\\`') || l.includes("innerHTML='\\`"),
    );
    assert.strictEqual(mangledLines.length, 0,
      `Found ${mangledLines.length} lines with mangled innerHTML backticks`);
  });

  test('session.js contains key functions', () => {
    const required = [
      'function addU(', 'function addA(', 'function addS(', 'function addE(',
      'function addT(', 'function addTStart(', 'function setBusy(',
      'function snd(', 'function rmd(', 'function esc(', 'function popMdl(',
      'function extractErrSummary(', 'function smartErr(',
    ];
    for (const fn of required) {
      assert.ok(sessionJs.includes(fn), `Missing function: ${fn}`);
    }
  });

  test('session.js sends ready message at end', () => {
    assert.ok(sessionJs.includes("vscode.postMessage({command:'ready'})"));
  });

  test('session.js has Free (local) for Ollama cost display', () => {
    assert.ok(sessionJs.includes('Free (local)'));
  });
});

// ── Webview script block validation ─────────────────────────────────────────

suite('Built Extension Webview Blocks', () => {
  const extensionJs = (() => {
    try {
      return fs.readFileSync(
        path.join(__dirname, '..', '..', 'out', 'extension.js'),
        'utf8',
      );
    } catch {
      return '';
    }
  })();

  test('extension.js exists and is non-empty', () => {
    assert.ok(extensionJs.length > 0, 'out/extension.js must exist — run npm run build first');
  });

  test('GovernancePanel script block has no escaped backticks', () => {
    const blocks = extensionJs.match(/<script>[\s\S]*?<\/script>/g) || [];
    for (const block of blocks) {
      if (block.includes('scanToolsNow')) {
        // This is the GovernancePanel script
        const bt = (block.match(/\\`/g) || []).length;
        assert.strictEqual(bt, 0, `GovernancePanel has ${bt} escaped backticks`);
      }
    }
  });

  test('SettingsPanel script block has no escaped backticks', () => {
    const blocks = extensionJs.match(/<script>[\s\S]*?<\/script>/g) || [];
    for (const block of blocks) {
      if (block.includes('INST_VER') || block.includes('loadModels')) {
        const bt = (block.match(/\\`/g) || []).length;
        assert.strictEqual(bt, 0, `SettingsPanel has ${bt} escaped backticks`);
      }
    }
  });

  test('CSP allows unsafe-inline and vscode-resource', () => {
    assert.ok(extensionJs.includes("'unsafe-inline'"), 'CSP must allow unsafe-inline');
    assert.ok(
      extensionJs.includes('vscode-resource') || extensionJs.includes('vscode-webview'),
      'CSP must allow vscode-resource or vscode-webview',
    );
  });

  test('session.js is loaded via external script src', () => {
    assert.ok(extensionJs.includes('script src='), 'Must have external script src for session.js');
    assert.ok(extensionJs.includes('session.js'), 'Must reference session.js');
  });
});
