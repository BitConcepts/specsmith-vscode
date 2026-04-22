const vscode=acquireVsCodeApi();
let curMdl='',busy=false,warned=false,lastU='',proposalCount=0;
const CTX={claude:200000,'gpt-4o':128000,o1:200000,o3:200000,gemini:1000000,mistral:128000};
function csize(m){const l=(m||'').toLowerCase();for(const[k,v]of Object.entries(CTX))if(l.includes(k))return v;return 128000}
function ts(){return new Date().toLocaleString([],{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit',second:'2-digit'})}
function esc(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}
function rmd(r){
  var s=esc(r);
  s=s.replace(/```(\S*)\n([\s\S]*?)```/g,function(_,_l,c){return '<pre><code>'+c+'</code></pre>';});
  s=s.replace(/`([^`]+)`/g,'<code>$1</code>');
  s=s.replace(/\*\*([^*]+)\*\*/g,'<strong>$1</strong>');
  s=s.replace(/\*([^*]+)\*/g,'<em>$1</em>');
  s=s.replace(/\n/g,'<br>');
  return s;
}
const C=document.getElementById('chat');
function sb2(){C.scrollTop=C.scrollHeight}
function addU(t,customTs){
  lastU=t;const d=document.createElement('div');d.className='mu';d.dataset.raw=t;
  d.innerHTML=`<div class="bbl">${esc(t)}</div><div class="mt">${customTs||ts()}</div>
  <div class="mact"><button class="ab" title="Copy" onclick="cp(this)">⎘</button>
  <button class="ab" title="Edit" onclick="ed(this)">✏</button></div>`;
  C.appendChild(d);sb2()}
function addA(t,customTs){const d=document.createElement('div');d.className='ma';d.dataset.raw=t;
  d.innerHTML=`<div class="rtag">🧠 AEE Agent</div><div class="bbl">${rmd(t)}</div>
  <div class="mt">${customTs||ts()}</div><div class="mact">
  <button class="ab" title="Copy" onclick="cp(this)">⎘</button>
  <button class="ab" title="Regenerate" onclick="regen()">&#x21BA;</button></div>`;
  C.appendChild(d);sb2()}
function extractErrSummary(r){
  if(!r)return'(empty result)';
  // Python traceback: find last exception line
  if(/Traceback \(most recent call last\)/i.test(r)){
    const lines=r.split('\n').map(l=>l.trim()).filter(Boolean).reverse();
    for(const l of lines){
      if(/^(\w*Error|Exception|RuntimeError|ValueError|TypeError|ImportError|ModuleNotFoundError|ValidationError|SystemExit)/.test(l))
        return 'Python error: '+l.slice(0,150);
    }
    return 'Python exception (see details)';
  }
  // Skip [exit N] prefix and find the first meaningful content line
  var lines=r.split('\n').map(function(l){return l.trim();}).filter(function(l){return l&&!l.startsWith('#');});
  // Remove the exit code line itself
  if(lines.length>0&&/^\[exit \d+\]/.test(lines[0]))lines.shift();
  // Look for lines with useful content (not just dashes or empty)
  for(var i=0;i<lines.length;i++){
    var l=lines[i];
    if(l.length>10&&!/^[-=]+$/.test(l)&&!/^\[/.test(l)){
      return l.slice(0,150);
    }
  }
  // Fallback: count issues if present
  var issueMatch=r.match(/(\d+)\s*(issue|warning|error|fail)/i);
  if(issueMatch)return issueMatch[0];
  return lines[0]?.slice(0,150)||'Command failed';
}
/* Human-readable tool name labels */
const _TLBL={audit:'Governance audit',validate:'Consistency check',doctor:'Tool check',
  epistemic_audit:'Epistemic audit',stress_test:'Stress test',belief_graph:'Belief graph',
  diff:'Drift check',export:'Compliance report',commit:'Commit',push:'Push',sync:'Sync',
  ledger_add:'Ledger entry',ledger_list:'Ledger list',read_file:'Reading file',
  write_file:'Writing file',list_dir:'Listing files',run_command:'Running command',
  req_list:'Requirements',req_gaps:'Coverage gaps',req_trace:'Traceability',
  read_wireframe:'Wireframe',retrieve_context:'Searching index',session_end:'Session end'};
function _tname(n){return _TLBL[n]||n}
/* Tool started: compact inline status — show meaningful context for each tool type */
function addTStart(n,args){
  const d=document.createElement('div');d.className='sl';
  const lbl=_tname(n);
  let hint='';
  if(n==='run_command'&&args&&args.command){
    // Show the actual command so the user knows what is running
    const cmd=String(args.command);
    hint=' \u2192 '+esc(cmd.length>80?cmd.slice(0,80)+'\u2026':cmd);
  }else if(args&&args.fix==='true'){hint=' (auto-fix)';}
  else if(args&&args.path){hint=' \u2014 '+String(args.path).split(/[\/]/).pop();}
  else if(args&&args.content&&n==='write_file'){hint=' \u2014 writing';}
  d.innerHTML=`<span style="color:var(--teal)">\u23f3 ${lbl}${hint}\u2026</span><span class="mts">${ts()}</span>`;
  C.appendChild(d);sb2()}
function addT(n,r,e){
  // Treat [exit N] (non-zero subprocess exit) as an error for expandable display
  if(!e&&r&&/^\[exit [1-9]/.test(r))e=true;
  // Strip [exit N] prefix — not useful to humans
  var cleanR=(r||'').replace(/^\[exit \d+\]\n?/,'').trim();
  const lbl=_tname(n);
  const d=document.createElement('div');d.className='tb'+(e?' er':'');
  if(e&&cleanR&&cleanR.length>20){
    const summary=extractErrSummary(cleanR);
    // Add a Report Bug button for Python-level crashes (Traceback, ImportError, etc.)
    const isPyCrash=/Traceback \(most recent call last\)|ImportError|ModuleNotFoundError|AttributeError:|TypeError: |RuntimeError:/i.test(r);
    const rptBtn=isPyCrash
      ?`<button onclick="rptTool(this,'${esc(n)}','${esc(r.slice(0,2000))}')"
          style="margin-top:6px;background:var(--red);color:#fff;border:none;border-radius:3px;padding:3px 8px;cursor:pointer;font-size:10px">\uD83D\uDC1B Report Bug</button>`
      :'';
    d.innerHTML=`<div class="thdr">\u274c ${esc(lbl)}</div>
      <details><summary class="tres" style="cursor:pointer;list-style:none">
        ${esc(summary)}<span style="font-size:9px;margin-left:4px;opacity:.6">(click for details)</span>
      </summary><pre class="err-detail" style="margin-top:4px;font-size:10px">${esc(cleanR.slice(0,3000))}${cleanR.length>3000?'\n\u2026(truncated)':''}</pre>${rptBtn}${cleanR.length>3000?'<button class="ab" style="margin-top:4px;font-size:10px;color:var(--dim)" onclick="vscode.postMessage({command:\'viewFull\',text:\''+esc(cleanR.replace(/'/g,"\'").slice(0,50000))+'\'})">' + '\uD83D\uDCC4 View Full</button>':''}</details>`;
  }else if(e){
    d.innerHTML=`<div class="thdr">\u274c ${esc(lbl)}</div><div class="tres">${esc(cleanR.slice(0,200))}</div>`;
  }else{
    // Success: one-line compact pill — no raw dump, just a status tick
    const brief=_toolBrief(n,r||'');
    d.innerHTML=`<div class="thdr" style="color:var(--teal)">✓ ${esc(lbl)} — ${esc(brief)}</div>`;
  }
  C.appendChild(d);sb2()}
/* Parse a one-line human summary from tool output */
function _toolBrief(n,r){
  if(!r||r==='(no output)')return'done';
  if(n==='audit'||n==='validate'){const m=r.match(/(\d+) (issue|check)/i);return m?m[0]:'done'}
  if(n==='doctor'){const m=r.match(/(\d+) tool/i);return m?m[0]:'done'}
  const first=r.split('\n').find(l=>l.trim()&&!l.startsWith('['));
  return(first||'done').trim().slice(0,60);}
/* Crash card: critical unexpected error — stop, show diagnostic, ask to report */
function addToolCrash(data){
  const repo=data.repo||'specsmith';
  const repoLabel=repo==='specsmith'?'specsmith CLI':'specsmith-vscode extension';
  const title=`[${repo}] ${data.tool||'tool'} crashed: ${(data.summary||'unexpected error').slice(0,80)}`;
  const detail=[
    'Tool: '+esc(data.tool||'?'),
    'Error: '+esc(data.summary||'?'),
    'specsmith: '+esc(data.specsmith_version||'?'),
    'Python: '+esc(data.python_version||'?'),
    'OS: '+esc(data.os_info||'?'),
    data.project_type?'Project type: '+esc(data.project_type):'',
  ].filter(Boolean).join(' | ');
  const fullDetail=[
    '**Tool:** '+esc(data.tool||'?'),
    '**Error:** '+esc(data.summary||'?'),
    '**specsmith version:** '+esc(data.specsmith_version||'unknown'),
    '**Python:** '+esc(data.python_version||'?'),
    '**OS:** '+esc(data.os_info||'?'),
    data.project_type?'**Project type:** '+esc(data.project_type):'',
    data.detail?'\n**Error detail:**\n'+(data.detail||'').slice(0,3000):'',
  ].filter(Boolean).join('\n');
  const d=document.createElement('div');
  d.style.cssText='background:rgba(244,71,71,.1);border:1px solid var(--red);border-left:4px solid var(--red);border-radius:6px;padding:10px 14px;margin:4px 0;';
  d.innerHTML=`
    <div style="font-weight:600;color:var(--red);margin-bottom:6px">🚨 Something went wrong in the ${esc(repoLabel)}</div>
    <div style="font-size:12px;color:var(--fg);margin-bottom:2px"><strong>${esc(data.tool||'?')}</strong> crashed: ${esc(data.summary||'unexpected error')}</div>
    <div style="font-size:11px;color:var(--dim);margin-bottom:8px">${esc(detail)}</div>
    <div style="font-size:11px;color:var(--dim);margin-bottom:8px">The session has stopped. This is an unexpected error — not something you did wrong.</div>
    <div style="display:flex;gap:8px;flex-wrap:wrap">
      <button onclick="rptCrash(this,'${esc(title)}','${esc(fullDetail)}','${esc(repo)}')"
        style="background:var(--red);color:#fff;border:none;border-radius:4px;padding:4px 10px;cursor:pointer;font-size:11px">🐛 Report Bug</button>
      <button onclick="this.closest('div[style]').remove()"
        style="background:none;border:1px solid var(--br);border-radius:4px;padding:4px 10px;cursor:pointer;font-size:11px;color:var(--dim)">Dismiss</button>
    </div>`;
  C.appendChild(d);sb2();}
function rptTool(btn,toolName,output){
  const title='[specsmith] '+toolName+' tool crashed';
  const detail='**Tool:** '+toolName+'\n**Error output:**\n'+output.slice(0,2000);
  if(!confirm('Report this tool error to GitHub (BitConcepts/specsmith)?\n\nData sent:\n\u2022 Tool name and error output\n\nNo personal data is included. Proceed?'))return;
  vscode.postMessage({command:'reportBug',bugTitle:title.slice(0,100),bugDetail:detail.slice(0,3000)});
  btn.textContent='\u2713 Reported';btn.disabled=true;}
function rptCrash(btn,title,detail,repo){
  if(!confirm('Report this bug to GitHub (BitConcepts/'+repo+')?\n\nData sent:\n• Tool name + error message\n• specsmith version, Python version, OS\n• Error detail text\n\nNo personal data is included. You can review the full report before it is filed.\n\nProceed?'))return;
  vscode.postMessage({command:'reportBug',bugTitle:'['+repo+'] '+title.slice(0,100),bugDetail:detail.slice(0,3000)});
  btn.textContent='✓ Reported';btn.disabled=true;}
function addS(m){
  const d=document.createElement('div');d.className='sl';
  d.innerHTML=`<span>${esc(m)}</span><span class="mts">${ts()}</span>`;
  C.appendChild(d);sb2()}
/* Known specsmith error patterns → short human-friendly message */
const ERR_MAP=[
  [/No such command 'run'/,                'specsmith version too old — upgrade: Ctrl+Shift+P → specsmith: Install or Upgrade'],
  [/No such option.*json-events/,          'specsmith < v0.3.1 — Ctrl+Shift+P → specsmith: Install or Upgrade'],
  [/invalid_api_key|Incorrect API key/i,   'Invalid API key — reset via: Ctrl+Shift+P → specsmith: Set API Key'],
  [/error code.*401|status.*401/i,         'Authentication failed (401) — check your API key: Ctrl+Shift+P → specsmith: Set API Key'],
  [/Provider error.*401/i,                 'Wrong API key (401) — Ctrl+Shift+P → specsmith: Set API Key'],
  [/ECONNREFUSED|connection refused/i,      'Ollama not running — start it: run ollama serve or open the Ollama app'],
  [/Provider error.*timed out|timed out/i,   'Ollama timed out — model may be loading. Wait and retry, or try a smaller model.'],
  [/404.*model|model.*not found/i,          'Model not downloaded — Ctrl+Shift+P → specsmith: Download Ollama Model'],
  [/Ollama model not found/i,               'Ollama model not installed — select a model from the dropdown or use: specsmith ollama pull <model>'],
  [/HTTP Error 404/i,                       'Ollama 404 — model not installed. Pick an installed model from the dropdown (Installed group)'],
  [/failed to load model/i,                 'Model failed to load — may need more VRAM or a smaller model'],
  [/insufficient_quota|exceeded.*quota/i,  'OpenAI quota exceeded — add credits at platform.openai.com/settings/billing'],
  [/Provider error.*429/i,                 'Rate limit (429) — quota exceeded, add billing credits or wait and retry'],
  [/error code.*429/i,                     'Rate limit (429) — quota exceeded or too many requests'],
  [/No API key/i,                          'No API key set — Ctrl+Shift+P → specsmith: Set API Key'],
  [/ANTHROPIC_API_KEY/,                    'Anthropic API key missing — Ctrl+Shift+P → specsmith: Set API Key'],
  [/OPENAI_API_KEY/,                       'OpenAI API key missing — Ctrl+Shift+P → specsmith: Set API Key'],
  [/GOOGLE_API_KEY/,                       'Google API key missing — Ctrl+Shift+P → specsmith: Set API Key'],
  [/MISTRAL_API_KEY/,                      'Mistral API key missing — Ctrl+Shift+P → specsmith: Set API Key'],
  [/Usage:.*specsmith.*COMMAND/s,          'specsmith CLI error — see details'],
  // Python tracebacks and crashes
  [/Traceback \(most recent call last\)/i,  'specsmith crashed — Python exception (click for details)'],
  [/ValidationError.*type|input should be.*ProjectType/i, 'scaffold.yml has an unsupported project type — open scaffold.yml and check the type field'],
  [/ModuleNotFoundError.*specsmith/i,       'specsmith is missing a module — try: specsmith: Install or Upgrade'],
  [/ImportError/i,                          'specsmith import error — try reinstalling via: pipx upgrade specsmith'],
  // Ollama 400
  [/HTTP Error 400|Bad Request/i,           'Ollama 400 — model does not support tool calling. Try a cloud provider (Anthropic/OpenAI) or a newer Ollama model.'],
  // Generic non-zero exit
  [/\[exit [1-9]/,                          'Command returned an error \u2014 expand for details'],
];
function smartErr(m){
  for(const[re,msg]of ERR_MAP){if(re.test(m))return{short:msg,long:m}}
  // Strip [exit N] prefix for cleaner display
  var clean=(m||'').replace(/^\[exit \d+\]\n?/,'').trim();
  var lines=clean.split('\n').map(function(l){return l.trim();}).filter(Boolean);
  if(lines.length>1)return{short:lines[0].slice(0,150),long:clean};
  return{short:clean||'Unknown error',long:''};
}
function addE(m){
  const{short,long}=smartErr(m||'?');
  const d=document.createElement('div');d.className='el';
  const bugBtn=`<button class="ab" title="Report this bug" style="margin-top:4px;font-size:10px;color:var(--dim)" onclick="rptBug(this)">🐛 Report</button>`;
  var vfBtn=long&&long.length>300?`<button class="ab" title="Open full error in editor" style="margin-top:4px;font-size:10px;color:var(--dim);margin-left:6px" onclick="vscode.postMessage({command:'viewFull',text:this.closest('.el').dataset.errDetail})">\uD83D\uDCC4 View Full</button>`:'';if(long){
    d.innerHTML=`<details><summary>\u26a0 ${esc(short)}</summary><pre class="err-detail">${esc(long)}</pre></details>${bugBtn}${vfBtn}`;
  }else{
    d.innerHTML=`<span>\u26a0 ${esc(short)}</span>${bugBtn}`;
  }
  d.dataset.errTitle=short;
  d.dataset.errDetail=long||'';
  C.appendChild(d);sb2()}
function rptBug(btn){
  const el=btn.closest('.el');const t=el?.dataset.errTitle||'specsmith error';const det=el?.dataset.errDetail||'';
  // Show consent summary before sending anything
  const preview=det?t.slice(0,80)+'\n\nError detail will be included (may contain file paths).':t.slice(0,80);
  if(!confirm('Report this bug to GitHub?\n\nWhat will be sent:\n• Error summary\n• specsmith version\n• VS Code version + OS\n• Error detail text (may include local file paths)\n\n'+preview+'\n\nThis will search BitConcepts/specsmith-vscode for a duplicate issue and either comment on it or create a new one. Proceed?'))return;
  vscode.postMessage({command:'reportBug',bugTitle:'[specsmith-vscode] '+t.slice(0,100),bugDetail:det.slice(0,3000)});
  btn.textContent='✓ Reported';btn.disabled=true;}
function addImg(u,l){const d=document.createElement('div');d.className='mu';
  d.innerHTML=`<div class="bbl"><div style="font-size:11px;color:var(--dim);margin-bottom:4px">📎 ${esc(l)}</div>
  <img class="iprev" src="${u}" alt="${esc(l)}"></div><div class="mt">${ts()}</div>`;
  C.appendChild(d);sb2()}
function updTok(i,o,c){const t=i+o,sz=csize(curMdl),p=Math.min(100,Math.round(t/sz*100));
  const f=document.getElementById('cfil');f.style.width=p+'%';
  f.style.background=p>=90?'var(--red)':p>=70?'var(--amb)':'var(--grn)';
  document.getElementById('cpct').textContent=p+'%';
  document.getElementById('tcnt').textContent=i.toLocaleString()+'+'+o.toLocaleString();
  var isLocal=document.getElementById('ps').value==='ollama';
  document.getElementById('tcst').textContent=isLocal?'Free (local)':'$'+Number(c||0).toFixed(4);
  if(p>=70&&!warned){warned=true;document.getElementById('obn').classList.add('show');
    document.getElementById('obt').textContent=`Context ${p}% — /clear or Audit/Compress`}}
function mainAct(){if(busy)stp();else snd()}
function setBusy(v){busy=v;var pb=document.querySelector('.proposal-btns');if(pb&&v)pb.remove();document.getElementById('it').disabled=v;
  document.getElementById('typ').className=v?'show':'';
  const b=document.getElementById('mainbtn');
  b.textContent=v?'◼':'↑';b.title=v?'Stop agent (click or Esc)':'Send (Enter)';
  if(v)b.classList.add('busy');else b.classList.remove('busy');
  document.querySelectorAll('.tb2').forEach(b=>b.disabled=v)}
function snd(){if(busy)return;const i=document.getElementById('it'),t=i.value.trim();if(!t)return;
  i.value='';addU(t);setBusy(true);vscode.postMessage({command:'send',text:t})}
function stp(){vscode.postMessage({command:'stop'});setBusy(false)}
function q(c){if(busy)return;addS('> '+c);setBusy(true);vscode.postMessage({command:'send',text:c})}
function openProj(){const l=document.getElementById('dlbl').title;if(l)vscode.postMessage({command:'openFile',filePath:l})}
function cp(btn){const c=btn.closest('[data-raw]');navigator.clipboard.writeText(c?.dataset.raw||c?.querySelector('.bbl')?.textContent||'').catch(()=>{})}
function ed(btn){const c=btn.closest('[data-raw]'),t=c?.dataset.raw||'';document.getElementById('it').value=t;document.getElementById('it').focus()}
function regen(){if(busy||!lastU)return;setBusy(true);vscode.postMessage({command:'send',text:lastU})}
function exportChat(){const ms=[];C.querySelectorAll('[data-raw]').forEach(el=>{const u=el.classList.contains('mu');ms.push((u?'**You:** ':'**Agent:** ')+(el.dataset.raw||''))});
  const md='# specsmith Chat\n'+new Date().toISOString()+'\n\n'+ms.join('\n\n---\n\n');
  vscode.postMessage({command:'exportChat',markdown:md})}
function pf(){vscode.postMessage({command:'pickFile'})}
function copyAll(){
  const ms=[];C.querySelectorAll('[data-raw]').forEach(el=>{
    const u=el.classList.contains('mu');
    ms.push((u?'**You ('+el.querySelector('.mt')?.textContent+'):** ':'**Agent:** ')+(el.dataset.raw||''))});
  const txt=ms.join('\n\n---\n\n');
  navigator.clipboard.writeText(txt).then(()=>{
    const b=document.getElementById('cab');if(!b)return;
    const prev=b.textContent;b.textContent='✓';
    setTimeout(()=>b.textContent=prev,1200);
  }).catch(()=>{});
}
function doClearHistory(){
  if(busy&&!confirm('Agent is running. Clear anyway?'))return;
  vscode.postMessage({command:'clearHistory'});
}
document.getElementById('it').addEventListener('keydown',e=>{
  /* Enter alone = send; Ctrl+Enter or Shift+Enter = insert newline (default) */
  if(e.key==='Enter'&&!e.shiftKey&&!e.ctrlKey&&!e.metaKey&&!e.altKey){e.preventDefault();snd();return}
  if(e.key==='Escape'&&busy){e.preventDefault();stp();return}
  if(e.key==='ArrowUp'&&!e.target.value.trim()){e.preventDefault();e.target.value=lastU;e.target.setSelectionRange(lastU.length,lastU.length)}
  if(e.key==='@'&&!e.target.value.trim()){e.preventDefault();pf()}})
function popMdl(prov,mdls,sel){
  const s=document.getElementById('ms');const pr=sel||s.value;s.innerHTML='';
  const list=mdls&&mdls.length?mdls:[];
  /* Group by category into <optgroup> */
  const groups={};
  for(const m of list){const c=m.category||'Models';(groups[c]=groups[c]||[]).push(m)}
  const cats=Object.keys(groups);
  if(cats.length>1){
    for(const cat of cats){
      const og=document.createElement('optgroup');og.label=cat;
      for(const m of groups[cat]){
        const o=document.createElement('option');o.value=m.id;
        o.textContent=m.name||m.id;
        const ctx=m.contextWindow?(m.contextWindow>=1000000?Math.round(m.contextWindow/1000000)+'M ctx':Math.round(m.contextWindow/1000)+'K ctx'):'';
        o.title=[m.description||'',ctx].filter(Boolean).join(' • ');
        og.appendChild(o);
      }
      s.appendChild(og);
    }
  }else{
    for(const m of list){
      const o=document.createElement('option');o.value=m.id;o.textContent=m.name||m.id;
      const ctx=m.contextWindow?(m.contextWindow>=1000000?Math.round(m.contextWindow/1000000)+'M ctx':Math.round(m.contextWindow/1000)+'K ctx'):'';
      o.title=[m.description||'',ctx].filter(Boolean).join(' • ');
      s.appendChild(o);
    }
  }
  if(pr&&[...s.options].some(o=>o.value===pr))s.value=pr;
  curMdl=s.value;updDesc()}
function updDesc(){const s=document.getElementById('ms'),o=s.options[s.selectedIndex],d=document.getElementById('mdesc');d.textContent=o?.title||'';d.title=o?.title||''}
document.getElementById('ps').addEventListener('change',e=>{const p=e.target.value;
  vscode.postMessage({command:'setProvider',provider:p});vscode.postMessage({command:'getModels',provider:p})});
document.getElementById('ms').addEventListener('change',e=>{
  const val=e.target.value;
  if(val.startsWith('dl:')){
    // Not downloaded yet — restore previous selection and ask host to download
    e.target.value=curMdl;
    const realId=val.slice(3);
    vscode.postMessage({command:'downloadModel',model:realId});
  }else{
    curMdl=val;updDesc();
    vscode.postMessage({command:'setModel',model:curMdl});
  }
});
/* Drag and drop — uses dragover polling (reliable; no stuck-overlay bug) */
const _IB=document.getElementById('ibar');let _dt;
function _dsh(){_IB.classList.add('da')}
function _dhd(){clearTimeout(_dt);_IB.classList.remove('da')}
document.addEventListener('dragover',e=>{
  e.preventDefault();
  _dsh();
  clearTimeout(_dt);
  _dt=setTimeout(_dhd,400); // auto-hide if drag stops/leaves without drop
});
document.addEventListener('drop',e=>{
  e.preventDefault();_dhd();
  const f=e.dataTransfer?.files;if(f)for(const fi of f)inj(fi);
});
document.addEventListener('dragleave',e=>{
  // Only hide when cursor leaves the entire document (not just an element)
  if(!e.relatedTarget||e.relatedTarget===document.documentElement)_dhd();
});
/* Paste images + text */
document.addEventListener('paste',e=>{
  const items=e.clipboardData?.items||[];
  for(const it of items){
    if(it.type.startsWith('image/')){const f=it.getAsFile();if(f){e.preventDefault();inj(f)}}
    else if(it.type==='text/plain'){
      // Allow default paste for plain text in the textarea
    }
  }
});
/* Smart injection — handles images, text, large files, PDFs, and binaries.
   file.path is a VS Code webview extension to DataTransfer File that gives
   the absolute local path for files dragged from the OS or VS Code explorer. */
const _INLINE_LIMIT=50*1024; // 50 KB — above this use path reference
const _TEXT_EXTS=/\.(md|txt|py|pyi|ts|tsx|js|jsx|json|yaml|yml|toml|sh|bash|zsh|ps1|go|rs|c|cc|cpp|cxx|h|hpp|cs|java|kt|swift|rb|php|sql|xml|css|scss|less|html|htm|vue|svelte|vhd|vhdl|sv|v|tcl|cmake|makefile|dockerfile|conf|ini|env|gitignore|editorconfig)$/i;
function _ext(name){return(name.split('.').pop()||'').toLowerCase()}
function _kb(sz){return sz<1024?sz+'B':(sz<1048576?(sz/1024).toFixed(0)+'KB':(sz/1048576).toFixed(1)+'MB')}
function inj(file){
  const im=file.type.startsWith('image/');
  const isPdf=file.type==='application/pdf'||/\.pdf$/i.test(file.name);
  const isTxt=file.type.startsWith('text/')||_TEXT_EXTS.test(file.name);
  const fp=file.path||''; // VS Code webview provides full OS path for local file drops
  const it=document.getElementById('it');
  const rd=new FileReader();
  if(im){
    // Images: thumbnail in chat + [Image:] prefix in input
    rd.onload=ev=>{const u=ev.target.result;addImg(u,file.name);it.value=`[Image: ${fp||file.name}]\n${it.value}`};
    rd.readAsDataURL(file);
  }else if(isPdf){
    // PDFs: path reference with read_file note (no binary inline)
    const ref=fp||file.name;
    it.value=`[PDF: ${ref} (${_kb(file.size)}) — use read_file tool to parse content]\n\n${it.value}`;
    addS(`📎 PDF attached: ${file.name}`);
  }else if(isTxt&&file.size<=_INLINE_LIMIT){
    // Small text files: inline as fenced code block
    rd.onload=ev=>{
      const c=ev.target.result;
      const lang=_ext(file.name);
      it.value=`[File: ${fp||file.name}]\n\`\`\`${lang}\n${c}\n\`\`\`\n\n${it.value}`;
      it.focus();
    };
    rd.readAsText(file);
  }else if(isTxt&&file.size>_INLINE_LIMIT){
    // Large text files: path reference + short preview
    rd.onload=ev=>{
      const preview=ev.target.result.split('\n').slice(0,6).join('\n');
      const ref=fp||file.name;
      it.value=`[Large file: ${ref} (${_kb(file.size)}) — use read_file tool for full content]\nPreview:\n${preview}\n…\n\n${it.value}`;
    };
    rd.readAsText(file);
  }else if(fp){
    // Binary with known path: inject reference
    it.value=`[File: ${fp} (binary ${_kb(file.size)}) — use read_file tool to access]\n\n${it.value}`;
    addS(`📎 Binary attached: ${file.name}`);
  }else{
    addS(`Cannot inject ${file.name} (binary ${_kb(file.size)}) — drag from VS Code explorer to get a path reference`);
  }
}
/* Resize handle — controls TEXTAREA height. Drag UP = bigger textarea, drag DOWN = smaller.
   Chat takes all remaining space (flex:1) so it auto-shrinks as textarea grows. */
(()=>{
  const h=document.getElementById('rh'),ta=document.getElementById('it');
  let dr=false,sy=0,sh=0;
  h.addEventListener('mousedown',e=>{dr=true;sy=e.clientY;sh=parseFloat(ta.style.height)||ta.getBoundingClientRect().height;h.classList.add('drag');e.preventDefault()});
  document.addEventListener('mousemove',e=>{
    if(!dr)return;
    const delta=sy-e.clientY; // drag UP = positive delta = bigger textarea
    const nh=Math.max(38,Math.min(320,sh+delta));
    ta.style.height=nh+'px';
  });
  document.addEventListener('mouseup',()=>{dr=false;h.classList.remove('drag')});
  h.addEventListener('dblclick',()=>{
    const cur=parseFloat(ta.style.height)||38;
    ta.style.height=(cur<=42?120:38)+'px';
  });
})();
/* Messages from host */
window.addEventListener('message',({data})=>{switch(data.type){
  case 'init':if(data.provider){document.getElementById('ps').value=data.provider;popMdl(data.provider,data.models||[],data.model)}
    if(data.projectDir){const l=document.getElementById('dlbl');l.textContent=data.projectDir.split(/[\/]/).pop()||data.projectDir;l.title=data.projectDir}
    if(data.availableProviders){const ps=document.getElementById('ps');for(const o of ps.options){if(!data.availableProviders.includes(o.value)){o.disabled=true;o.textContent=o.value+' (no key)'}}}break;
  case 'models':popMdl(document.getElementById('ps').value,data.models,curMdl);break;
  case 'ready':setBusy(true);addS(`AEE Agent ready — ${data.provider||''}/${data.model||''} (${data.tools||0} tools)`);
    if(data.project_dir){const l=document.getElementById('dlbl');l.textContent=data.project_dir.split(/[\/]/).pop();l.title=data.project_dir}break;
  case 'llm_chunk':addA(data.text||'');break;
  case 'tool_started':addTStart(data.name||'?',data.args||{});break;
  case 'tool_finished':addT(data.name||'?',data.result||'',!!data.is_error);break;
  case 'tool_crash':addToolCrash(data);setBusy(false);break;
  case 'tokens':updTok(data.in_tokens||0,data.out_tokens||0,data.cost_usd||0);break;
  case 'turn_done':setBusy(false);break;
  case 'error':addE(data.message);setBusy(false);break;
  case 'system':addS(data.message||'');break;
  case 'vcs_state':{
    const vb=document.getElementById('vb'),vc=document.getElementById('vchg'),vw=document.getElementById('vwd');
    if(vb)vb.textContent=data.branch||'\u2014';
    if(vc){const n=data.changes||0;vc.textContent=n>0?n+' change'+(n!==1?'s':''):'clean';vc.className=n>0?'vc':'';}
    if(vw&&data.projectDir){const p=data.projectDir.replace(/\\/g,'/');const short=p.split('/').slice(-2).join('/');vw.textContent=short;vw.title=p;}
    break;}
  case 'clear_display':
    C.innerHTML='';
    warned=false;
    proposalCount=0;
    document.getElementById('obn').classList.remove('show');
    addS(data.message||'Chat cleared.');
    setBusy(false);
    break;
  case 'history_user':
    addU(data.text||'', data.message); // data.message = historical timestamp
    break;
  case 'history_agent':
    addA(data.text||'', data.message);
    break;
  case 'file_picked':if(data.isImage&&data.dataUrl){addImg(data.dataUrl,data.fileName||'img');const i=document.getElementById('it');i.value=`[Image: ${data.fileName}]\n${i.value}`}
    else if(data.fileContent!==undefined){
      const i=document.getElementById('it');
      // Path/reference blocks start with '[' — inject verbatim without fenced block wrapper
      if(data.fileContent.startsWith('[')){
        i.value=`${data.fileContent}\n\n${i.value}`;
      }else{
        const lang=(data.fileName||'').split('.').pop()||'';
        i.value=`[File: ${data.fileName}]\n\`\`\`${lang}\n${data.fileContent}\n\`\`\`\n\n${i.value}`;
      }
      i.focus();
    }break;
  case 'proposal':{
    proposalCount++;
    // Remove any existing proposal buttons first
    var old=document.querySelector('.proposal-btns');
    if(old)old.remove();
    var pd=document.createElement('div');
    pd.className='proposal-btns';
    pd.style.cssText='display:flex;gap:6px;padding:6px 8px;margin:2px 0;align-self:flex-start;background:var(--sf);border:1px solid var(--br);border-radius:6px';
    var ab=document.createElement('button');
    ab.textContent='\u2713 Accept';
    ab.style.cssText='background:var(--bb);color:var(--bf);border:none;border-radius:4px;padding:3px 10px;cursor:pointer;font-size:11px;font-weight:600';
    ab.onclick=function(){pd.remove();setBusy(true);vscode.postMessage({command:'send',text:'yes, proceed'});};
    var rb=document.createElement('button');
    rb.textContent='\u2717 Reject';
    rb.style.cssText='background:none;border:1px solid var(--br);color:var(--dim);border-radius:4px;padding:3px 10px;cursor:pointer;font-size:11px';
    rb.onclick=function(){pd.remove();setBusy(true);vscode.postMessage({command:'send',text:'no, skip this'});};
    pd.appendChild(ab);pd.appendChild(rb);
    // Only show Accept All after 2+ proposals in the session
    if(proposalCount>=2){
      var aab=document.createElement('button');
      aab.textContent='\u2713\u2713 Accept All';
      aab.style.cssText='background:rgba(78,201,176,.15);border:1px solid var(--teal);color:var(--teal);border-radius:4px;padding:3px 10px;cursor:pointer;font-size:11px;font-weight:600';
      aab.onclick=function(){pd.remove();setBusy(true);vscode.postMessage({command:'setAutoAccept'});vscode.postMessage({command:'send',text:'yes, proceed with everything'});};
      pd.appendChild(aab);
    }
    C.appendChild(pd);sb2();
    break;}
}});
vscode.postMessage({command:'ready'});