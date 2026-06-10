/* ══════════════════════════════════════════════════════════
   ANNOTATION GENERATOR
   フロー:
   1. 文字起こしテキストをペースト
   2. 段落ごとに LLM API へリクエスト
      - プロンプト: 文字起こし段落 + 話速推定 + アノテーションスキーマ
      - レスポンス: {words:[{t,ws,stress,inton,elision,syl,note},...]} のJSON
   3. 全段落完了後 PARAS を上書き → renderTranscript()
   4. Chrome/Edge: File System Access API でフォルダ保存
      Safari: Blob ダウンロード
   5. annotation.json のスキーマ:
      { version:"1", contentBase:"xxx", generatedAt:"ISO", paras:[...PARAS] }
══════════════════════════════════════════════════════════ */

let genOllamaUrl = 'http://localhost:11434';
let genAbort    = false;
let genAbortController = null;  /* アノテーション生成: 進行中リクエストの即時キャンセル用 */
let fsaDirHandle  = null;  /* 保存先フォルダハンドル */
let currentBase   = '';    /* 動画ファイルのベース名 */

/* ── YouTube自動処理 状態変数 ── */
let ytAutoUrl     = '';
let ytAutoController = null;       /* 全自動処理: 進行中リクエストの即時キャンセル用 */
let retranslateControllers = {};   /* 日本語訳再生成: video_id -> AbortController */
let ytBackendUrl  = 'http://localhost:8000';
let ytOllamaModel = 'qwen3.5:4b';
/* 翻訳LLMプロバイダ: 'ollama' | 'runpod' | 'openrouter' | 'openai' */
let ytLlmBackend  = 'ollama';
/* RunPod */
let runpodUrl     = 'https://api.runpod.ai/v2/<endpoint_id>/runsync';
let runpodApiKey  = '';
let runpodModel   = 'qwen/qwen3.5-9b';
/* OpenRouter */
let orApiKey      = '';
let orModel       = 'qwen/qwen-2.5-72b-instruct';
/* OpenAI（翻訳用・汎用OpenAI互換。endpoint空=公式） */
let oaiTransKey   = '';
let oaiTransModel = 'gpt-4o-mini';
let oaiTransUrl   = '';   /* 空=https://api.openai.com/v1/chat/completions */

/* ── プロジェクト一覧を取得してDOMに表示 ── */
async function loadYouTubeProjects(){
  const listEl = document.getElementById('yt-proj-list');
  if(!listEl) return;
  listEl.innerHTML = '<span style="font-size:11px;color:var(--muted);font-family:var(--mono)">読み込み中...</span>';
  const bkUrl = document.getElementById('yt-backend-url')?.value?.trim() || ytBackendUrl;
  try{
    const resp = await fetch(`${bkUrl}/projects`);
    if(!resp.ok) throw new Error('HTTP '+resp.status);
    const projects = await resp.json();
    if(!projects.length){
      listEl.innerHTML = '<span style="font-size:11px;color:var(--muted);font-family:var(--mono)">保存済みプロジェクトなし</span>';
      return;
    }
    listEl.innerHTML = projects.map(p=>`
      <div class="yt-proj-item" id="proj-row-${p.video_id}">
        <span class="yt-proj-name" title="${p.video_id}">${p.title||p.video_id}</span>
        <div style="display:flex;gap:4px;flex-shrink:0">
          ${p.has_data ? `<button class="yt-proj-load" onclick="loadYouTubeProject('${p.video_id}')">読込</button>` : '<span style="font-size:10px;color:var(--muted);padding:2px 4px">処理中</span>'}
          ${p.has_data ? `<button class="yt-proj-load" id="retrans-btn-${p.video_id}" onclick="retranslateProject('${p.video_id}')" title="日本語訳を再生成（DL・字幕取得なし）">🌐訳</button>` : ''}
          <button class="yt-proj-del" onclick="deleteYouTubeProject('${p.video_id}')" title="削除">🗑</button>
        </div>
      </div>`).join('');
  }catch(err){
    listEl.innerHTML = `<span style="font-size:11px;color:var(--danger,#f87171);font-family:var(--mono)">取得失敗（バックエンドが起動していますか？）</span>`;
  }
}

/* ── 指定プロジェクトのdata.jsonとvideoを読み込む ── */
async function loadYouTubeProject(videoId){
  const bkUrl   = document.getElementById('yt-backend-url')?.value?.trim() || ytBackendUrl;
  const dataUrl = `${bkUrl}/files/${videoId}/data.json`;
  const vidUrl  = `${bkUrl}/files/${videoId}/video.mp4`;
  try{
    const resp = await fetch(dataUrl);
    if(!resp.ok) throw new Error('data.json取得エラー: HTTP '+resp.status);
    const data = await resp.json();
    if(!Array.isArray(data.paras)) throw new Error('parasフィールドがありません');

    PARAS.length = 0;
    data.paras.forEach((p,i)=>{
      p.id  = i;
      const estEnd = p.end ?? (p.start + Math.max(2,(p.en||'').split(/\s+/).filter(Boolean).length*0.35));
      p.end = estEnd;
      p.words = buildWordsFromParsed(p.words||[], p, 0.35);
      PARAS.push(p);
    });

    const lastPara = PARAS[PARAS.length-1];
    if(lastPara) totalDur = lastPara.end;
    renderTranscript();

    /* 動画をバックエンドURLから読み込む */
    const vid = document.getElementById('vid');
    vid.src = vidUrl;
    vid.load();
    document.getElementById('local-wrap').style.display = '';
    document.getElementById('yt-wrap').style.display    = 'none';
    document.getElementById('chk-yt').checked = false;
    document.getElementById('no-file').style.display = 'none';
    document.getElementById('file-name').textContent  = videoId;
    document.getElementById('header-sub').textContent = data.contentBase || videoId;
    currentBase = videoId;

    /* data.md も取得して Generate テキストエリアへ */
    try{
      const mdResp = await fetch(`${bkUrl}/files/${videoId}/data.md`);
      if(mdResp.ok){
        const parsed = parseMdToTranscript(await mdResp.text());
        if(parsed) window._pendingMdTranscript = parsed;
      }
    } catch(e){ /* md取得失敗は無視 */ }

    window._localVideoFile = null; /* バックエンド動画はローカルFileではない */
    showToast(`✓ ${videoId} を読み込みました（${data.paras.length}段落）`, false, 4000);
  }catch(err){
    showToast('読み込みエラー: '+err.message, true, 5000);
  }
}

/* ── 既存プロジェクトの日本語訳のみ再生成（DL・字幕取得なし／ja のみ更新） ── */
async function retranslateProject(videoId){
  if(retranslateControllers[videoId]) return;   /* 既に実行中 */

  const bkUrl = document.getElementById('yt-backend-url')?.value?.trim() || ytBackendUrl;
  /* 一覧上のプロバイダ選択を優先（無ければ共通設定 ytLlmBackend） */
  const provName = document.getElementById('retrans-prov')?.value || ytLlmBackend || 'ollama';
  const prov  = resolveProviderByName(provName);
  if(prov.provider !== 'ollama' && !prov.apiKey){
    showToast(`${prov.provider} のAPIキー/設定を「設定」タブで入力してください`, true); return;
  }
  if(prov.provider === 'ollama' && !prov.model){
    showToast('Ollama のモデル名を「設定」タブで指定してください', true); return;
  }
  if(!confirm(`「${videoId}」の日本語訳を【${prov.provider}${prov.model?' / '+prov.model:''}】で再生成します。\n英文・タイミングはそのままで、日本語訳(ja)のみ更新します。\n\nよろしいですか？`)) return;

  const btn = document.getElementById(`retrans-btn-${videoId}`);
  const controller = new AbortController();
  retranslateControllers[videoId] = controller;
  if(btn){
    btn.textContent = '■';
    btn.title = '日本語訳の再生成をキャンセル';
    btn.className = 'yt-proj-cancel';
    btn.onclick = ()=>cancelRetranslateProject(videoId);
  }

  try{
    let resp;
    try{
      resp = await fetch(`${bkUrl}/retranslate/${videoId}`, {
        method:'POST',
        signal: controller.signal,
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify({
          translate_provider: prov.provider,
          translate_model:    prov.model,
          translate_endpoint: prov.endpoint,
          translate_api_key:  prov.apiKey,
          ollama_url:         genOllamaUrl || 'http://localhost:11434',
        })
      });
      if(!resp.ok){ const e = await resp.json().catch(()=>({})); throw new Error(e.detail || 'HTTP '+resp.status); }
    }catch(err){
      if(err.name==='AbortError'){ showToast('🌐 日本語訳の再生成をキャンセルしました', false, 3000); return; }
      showToast('再翻訳の開始に失敗: '+err.message, true, 5000); return;
    }

    const reader = resp.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    try{
      while(true){
        const {done, value} = await reader.read();
        if(done) break;
        buf += dec.decode(value, {stream:true});
        const lines = buf.split('\n'); buf = lines.pop();
        for(const line of lines){
          if(!line.startsWith('data: ')) continue;
          let evt; try{ evt = JSON.parse(line.slice(6)); }catch(e){ continue; }
          if(evt.type==='progress' || evt.type==='warning'){
            showToast('🌐 '+(evt.msg||''), evt.type==='warning', 8000);
          }else if(evt.type==='error'){
            showToast('再翻訳エラー: '+evt.msg, true, 6000);
          }else if(evt.type==='done'){
            showToast('✓ '+(evt.msg||'再翻訳が完了しました'), false, 5000);
            /* 現在表示中のプロジェクトなら再読込して訳を反映 */
            if(typeof currentBase!=='undefined' && currentBase===videoId){ loadYouTubeProject(videoId); }
          }
        }
      }
    }catch(err){
      if(err.name==='AbortError'){ showToast('🌐 日本語訳の再生成をキャンセルしました', false, 3000); }
      else { showToast('再翻訳ストリームエラー: '+err.message, true, 5000); }
    }
  } finally {
    delete retranslateControllers[videoId];
    if(btn){
      btn.textContent = '🌐訳';
      btn.title = '日本語訳を再生成（DL・字幕取得なし）';
      btn.className = 'yt-proj-load';
      btn.onclick = ()=>retranslateProject(videoId);
    }
  }
}

/* ── 進行中の日本語訳再生成をキャンセル ── */
function cancelRetranslateProject(videoId){
  const controller = retranslateControllers[videoId];
  if(controller) controller.abort();
}

/* ── 指定プロバイダの設定を解決（DOM入力 → 永続化変数の順でフォールバック） ── */
function resolveProviderByName(p){
  if(p === 'runpod'){
    return { provider:'runpod',
      endpoint: (document.getElementById('yt-runpod-url')?.value?.trim()   || runpodUrl),
      apiKey:   (document.getElementById('yt-runpod-key')?.value?.trim()   || runpodApiKey),
      model:    (document.getElementById('yt-runpod-model')?.value?.trim() || runpodModel) };
  }
  if(p === 'openrouter'){
    return { provider:'openrouter', endpoint:'',
      apiKey: (document.getElementById('yt-or-key')?.value?.trim()   || orApiKey),
      model:  (document.getElementById('yt-or-model')?.value?.trim() || orModel) };
  }
  if(p === 'openai'){
    return { provider:'openai',
      endpoint:(document.getElementById('yt-oai-url')?.value?.trim()   || oaiTransUrl),
      apiKey:  (document.getElementById('yt-oai-key')?.value?.trim()   || oaiTransKey),
      model:   (document.getElementById('yt-oai-model')?.value?.trim() || oaiTransModel) };
  }
  /* ollama */
  return { provider:'ollama', endpoint:'', apiKey:'',
    model: (document.getElementById('yt-ollama-model')?.value?.trim() || ytOllamaModel) };
}

/* ── 翻訳プロバイダ設定を解決（共通設定 ytLlmBackend を使用） ── */
function resolveTranslateProvider(){
  return resolveProviderByName(ytLlmBackend || 'ollama');
}

/* ── フォールバックプロバイダ（Ollama固定）を返す ── */
function ollamaFallbackProvider(){
  return { provider:'ollama', endpoint:'', apiKey:'', model: ytOllamaModel || 'qwen3.5:4b' };
}

/* ── YouTube全自動処理をSSEで実行 ── */
async function runYouTubeAutoProcess(overrideProvider = null){
  const url       = document.getElementById('yt-auto-url')?.value?.trim() || ytAutoUrl;
  const bkUrl     = document.getElementById('yt-backend-url')?.value?.trim() || ytBackendUrl;
  const ollamaUrl = genOllamaUrl || 'http://localhost:11434';
  const prov      = overrideProvider || resolveTranslateProvider();

  if(!url){ showToast('YouTube URLを入力してください', true); return; }
  if(prov.provider !== 'ollama' && !prov.apiKey){
    showToast(`${prov.provider} のAPIキーを「設定」タブで入力してください`, true); return;
  }

  ytBackendUrl = bkUrl;
  persistGenSettings();

  const btn       = document.getElementById('yt-auto-btn');
  const cancelBtn = document.getElementById('yt-auto-cancel-btn');
  const progWrp   = document.getElementById('yt-prog-wrap');
  const progFil   = document.getElementById('yt-prog-fill');
  const statusEl  = document.getElementById('yt-status-text');

  if(btn)       btn.disabled = true;
  if(cancelBtn) cancelBtn.style.display = '';
  if(progWrp){ progWrp.style.display='block'; }
  if(progFil) progFil.style.width='0%';
  if(statusEl){ statusEl.textContent=`処理を開始しています（${prov.provider}）...`; statusEl.className='yt-status'; }

  ytAutoController = new AbortController();

  let response;
  try{
    response = await fetch(`${bkUrl}/process`, {
      method:'POST',
      signal: ytAutoController.signal,
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({
        url,
        translate_model:    prov.model,
        ollama_url:         ollamaUrl,
        translate_provider: prov.provider,
        translate_endpoint: prov.endpoint,
        translate_api_key:  prov.apiKey,
      })
    });
    if(!response.ok){
      const errData = await response.json().catch(()=>({}));
      throw new Error(errData.detail || 'HTTP '+response.status);
    }
  }catch(err){
    if(err.name==='AbortError'){
      if(statusEl){ statusEl.textContent='キャンセルしました'; statusEl.className='yt-status'; }
      showToast('自動処理をキャンセルしました', false, 3000);
      resetYtAutoUI();
      return;
    }
    resetYtAutoUI();
    if(!overrideProvider && prov.provider !== 'ollama'){
      const go = confirm(
        `【${prov.provider}】への接続に失敗しました。\n\n` +
        `Ollama（ローカル）で続行しますか？\n` +
        `　OK     → Ollamaで続行\n` +
        `　キャンセル → 中止\n\n` +
        `エラー: ${err.message}`
      );
      if(go) return runYouTubeAutoProcess(ollamaFallbackProvider());
    }
    if(statusEl){ statusEl.textContent='接続エラー: '+err.message; statusEl.className='yt-status err'; }
    return;
  }

  const reader  = response.body.getReader();
  const decoder = new TextDecoder();
  let   buf     = '';
  try{
    while(true){
      const {done,value} = await reader.read();
      if(done) break;
      buf += decoder.decode(value,{stream:true});
      const lines = buf.split('\n');
      buf = lines.pop();
      for(const line of lines){
        if(!line.startsWith('data: ')) continue;
        try{ handleYtAutoEvent(JSON.parse(line.slice(6)), progFil, statusEl); }
        catch(e){ /* ignore malformed JSON */ }
      }
    }
  }catch(err){
    if(err.name==='AbortError'){
      if(statusEl){ statusEl.textContent='キャンセルしました'; statusEl.className='yt-status'; }
      showToast('自動処理をキャンセルしました', false, 3000);
    } else if(statusEl){ statusEl.textContent='ストリームエラー: '+err.message; statusEl.className='yt-status err'; }
  }finally{
    resetYtAutoUI();
  }
}

/* ── 全自動処理のキャンセル ── */
function cancelYouTubeAutoProcess(){
  if(ytAutoController) ytAutoController.abort();
}

/* ── 全自動処理ボタンの状態をリセット ── */
function resetYtAutoUI(){
  const btn       = document.getElementById('yt-auto-btn');
  const cancelBtn = document.getElementById('yt-auto-cancel-btn');
  if(btn)       btn.disabled = false;
  if(cancelBtn) cancelBtn.style.display = 'none';
  ytAutoController = null;
}

/* ── SSEイベントハンドラ ── */
function handleYtAutoEvent(evt, progFil, statusEl){
  if(evt.type==='progress'||evt.type==='warning'){
    if(progFil && typeof evt.pct==='number') progFil.style.width=evt.pct+'%';
    if(statusEl){ statusEl.textContent=evt.msg||''; statusEl.className='yt-status'+(evt.type==='warning'?' err':''); }
  }else if(evt.type==='error'){
    if(statusEl){ statusEl.textContent='エラー: '+evt.msg; statusEl.className='yt-status err'; }
    showToast('処理エラー: '+evt.msg, true, 6000);
  }else if(evt.type==='done'){
    if(progFil) progFil.style.width='100%';
    if(statusEl){ statusEl.textContent=evt.msg||'完了！'; statusEl.className='yt-status ok'; }
    showToast(evt.msg||'処理が完了しました！', false, 4000);
    if(evt.video_id){
      loadYouTubeProject(evt.video_id);
      loadYouTubeProjects();
    }
  }
}

/* ── プロジェクト削除 ── */
async function deleteYouTubeProject(videoId){
  if(!confirm(`「${videoId}」を削除しますか？\nフォルダごと完全に削除されます。`)) return;
  const bkUrl = document.getElementById('yt-backend-url')?.value?.trim() || ytBackendUrl;
  try{
    const resp = await fetch(`${bkUrl}/projects/${videoId}`, {method:'DELETE'});
    if(!resp.ok){
      const err = await resp.json().catch(()=>({}));
      throw new Error(err.detail || 'HTTP '+resp.status);
    }
    /* 行をフェードアウトして削除 */
    const row = document.getElementById('proj-row-'+videoId);
    if(row){ row.style.transition='opacity .3s'; row.style.opacity='0'; setTimeout(()=>row.remove(), 300); }
    showToast(`🗑 ${videoId} を削除しました`, false, 3000);
  }catch(err){
    showToast('削除エラー: '+err.message, true, 4000);
  }
}

/* ── FSA（File System Access API）対応判定 ── */
function fsaSupported(){ return typeof window.showDirectoryPicker === 'function'; }

/* ── 生成タブHTML（生成アクションのみ。設定は「設定」タブへ集約） ── */
function generateHTML(){
  return `
<div class="yt-auto-section">
  <div class="yt-auto-title">YouTube 全自動処理（PC）</div>
  <div class="gen-section">
    <div class="gen-label">YouTube URL</div>
    <input class="gen-input" id="yt-auto-url" placeholder="https://www.youtube.com/watch?v=..."
      oninput="ytAutoUrl=this.value">
  </div>
  <div class="gen-status" id="backend-health" style="margin-bottom:6px">接続確認中...</div>
  <div class="gen-row">
    <button class="gen-btn" id="yt-auto-btn" onclick="runYouTubeAutoProcess()"
      style="border-color:rgba(78,173,255,.4);background:rgba(78,173,255,.1);color:var(--a2)">
      ▶ 自動処理開始
    </button>
    <button class="gen-btn cancel" id="yt-auto-cancel-btn" onclick="cancelYouTubeAutoProcess()" style="display:none">
      ■ キャンセル
    </button>
  </div>
  <div class="yt-prog-wrap" id="yt-prog-wrap"><div class="yt-prog-fill" id="yt-prog-fill"></div></div>
  <div class="yt-status" id="yt-status-text"></div>
  <div style="font-size:10px;color:var(--muted);font-family:var(--mono);margin-top:6px">バックエンドURL・翻訳/注釈モデルは「設定」タブで変更できます</div>
  <hr class="gen-divider" style="margin-top:.75rem">
  <div class="gen-label" style="margin-bottom:6px">保存済みプロジェクト</div>
  <div style="display:flex;align-items:center;gap:6px;margin-bottom:6px">
    <span style="font-size:10px;color:var(--muted);font-family:var(--mono);white-space:nowrap">🌐訳 のプロバイダ</span>
    <select class="spd" id="retrans-prov" title="日本語訳の再生成に使うLLMプロバイダ（認証情報は「設定」タブの各項目を使用）">
      ${['ollama','runpod','openrouter','openai'].map(v=>`<option value="${v}"${(ytLlmBackend||'ollama')===v?' selected':''}>${v}</option>`).join('')}
    </select>
  </div>
  <div id="yt-proj-list"><span style="font-size:11px;color:var(--muted);font-family:var(--mono)">読み込み中...</span></div>
  <button class="gen-btn danger" onclick="loadYouTubeProjects()" style="margin-top:6px;font-size:10px">
    ↻ 一覧を更新
  </button>
</div>
<div class="lcard">
  <div class="gen-section">
    <div class="gen-label">文字起こしテキスト</div>
    <textarea class="gen-textarea" id="gen-transcript" rows="10"
      placeholder="ペースト or 動画バーの「📝 MD読込」から&#10;0:00&#10;Hi. After a chaotic few weeks...&#10;0:04&#10;And just real quick...&#10;&#10;※ 0:00 = 英文の開始秒。[Applause]等のみの区間はスキップ"></textarea>
  </div>
  <div class="gen-section">
    <div class="gen-label">動画の話速（参考情報）</div>
    <select class="gen-input" id="gen-speed">
      <option value="slow">ゆっくり（学習用・朗読）</option>
      <option value="normal" selected>普通（会話・講義）</option>
      <option value="fast">速め（Jesse Itzler等・自然な会話）</option>
      <option value="veryfast">かなり速い（ネイティブ同士の会話）</option>
    </select>
  </div>
  <hr class="gen-divider">
  <button class="gen-btn" id="gen-run-btn" onclick="runGeneration()">
    ✦ アノテーション生成を開始
  </button>
  <button class="gen-btn" id="gen-regen-btn" onclick="regenerateAnnotationsOnly()"
    style="margin-top:8px;border-color:rgba(78,173,255,.4);background:rgba(78,173,255,.08);color:var(--a2)"
    title="読み込み済みのチャンク（英文・和訳・時刻）はそのままに、発音アノテーションだけを再生成します">
    ♺ アノテーションのみ再生成
  </button>
  <div class="gen-status" id="gen-regen-hint" style="margin-top:4px">自動処理済みのプロジェクトを読み込んだ後、発音記号だけ作り直せます</div>
  <div class="gen-prog-wrap" id="gen-prog-wrap">
    <div class="gen-prog-bg"><div class="gen-prog-fill" id="gen-prog-fill"></div></div>
    <div class="gen-status" id="gen-status-text"></div>
  </div>
</div>
<div class="lcard">
  <div class="gen-label">既存アノテーションJSONを読み込む</div>
  <div class="gen-row">
    <button class="gen-btn danger" onclick="loadAnnotationFile()">📂 JSONを選択</button>
    <input type="file" id="anno-file-input" accept=".json,application/json" style="display:none" onchange="onAnnotationFileLoad(this)">
  </div>
  <div class="gen-status" id="anno-load-status"></div>
</div>`;
}

/* ── 設定を全フィールドから読み取ってlocalStorageに保存 ── */
function saveAllSettings(){
  const v = id => document.getElementById(id)?.value ?? null;
  const p = id => document.getElementById(id)?.value?.trim() ?? null;
  if(p('yt-ollama-url')    !== null) genOllamaUrl  = p('yt-ollama-url');
  if(p('yt-backend-url')   !== null) ytBackendUrl  = p('yt-backend-url');
  if(p('yt-llm-backend')   !== null) ytLlmBackend  = p('yt-llm-backend');
  if(p('yt-ollama-model')  !== null) ytOllamaModel = p('yt-ollama-model');
  if(p('yt-runpod-url')    !== null) runpodUrl     = p('yt-runpod-url');
  if(v('yt-runpod-key')    !== null) runpodApiKey  = v('yt-runpod-key').trim();
  if(p('yt-runpod-model')  !== null) runpodModel   = p('yt-runpod-model');
  if(v('yt-or-key')        !== null) orApiKey      = v('yt-or-key').trim();
  if(p('yt-or-model')      !== null) orModel       = p('yt-or-model');
  if(v('yt-oai-key')       !== null) oaiTransKey   = v('yt-oai-key').trim();
  if(p('yt-oai-model')     !== null) oaiTransModel = p('yt-oai-model');
  if(p('yt-oai-url')       !== null) oaiTransUrl   = p('yt-oai-url');
  persistGenSettings();
  showToast('✓ 設定を保存しました', false, 2000);
}

/* ── 設定タブHTML（全設定を集約） ── */
function settingsHTML(){
  const fsa = fsaSupported();
  return `
<div style="display:flex;justify-content:flex-end;padding:0 0 8px 0">
  <button class="gen-btn" onclick="saveAllSettings()"
    style="border-color:rgba(78,173,255,.4);background:rgba(78,173,255,.1);color:var(--a2);font-size:12px;padding:5px 14px">
    💾 設定を保存
  </button>
</div>
<div class="lcard">
  <div class="gen-section">
    <div class="gen-label">YouTube全自動 バックエンド（FastAPI）</div>
    <input class="gen-input" id="yt-backend-url" value="${ytBackendUrl}"
      oninput="ytBackendUrl=this.value" onchange="persistGenSettings();checkBackendHealth()" placeholder="http://localhost:8000">
    <div class="gen-status" id="backend-health" style="margin-top:6px">接続確認中...</div>
    <div class="gen-label" style="margin-top:10px">LLM 接続先（翻訳・発音アノテーション 共通）</div>
    <div style="font-size:10px;color:var(--muted);margin:-2px 0 6px">
      ✓ <b>YouTube全自動処理</b>の日本語訳と、<b>ブラウザ内のアノテーション生成・再生成</b>の両方でこの設定を使用します。
    </div>
    <select class="gen-input" id="yt-llm-backend" onchange="onYtLlmBackendChange(this.value)">
      <option value="ollama"     ${ytLlmBackend==='ollama'?'selected':''}>Ollama（ローカル）</option>
      <option value="runpod"     ${ytLlmBackend==='runpod'?'selected':''}>RunPod Serverless（vLLM）</option>
      <option value="openrouter" ${ytLlmBackend==='openrouter'?'selected':''}>OpenRouter</option>
      <option value="openai"     ${ytLlmBackend==='openai'?'selected':''}>OpenAI API（汎用OpenAI互換）</option>
    </select>

    <div id="yt-prov-ollama" style="${ytLlmBackend==='ollama'?'':'display:none'}">
      <div class="gen-label" style="margin-top:6px">Ollama URL</div>
      <input class="gen-input" id="yt-ollama-url" value="${genOllamaUrl}"
        oninput="genOllamaUrl=this.value" onchange="persistGenSettings();testOllamaConnection()" placeholder="http://localhost:11434">
      <div class="gen-label" style="margin-top:6px">モデル（インストール済みから選択）</div>
      <select class="gen-input" id="yt-ollama-model" onchange="ytOllamaModel=this.value;persistGenSettings()">
        <option value="${ytOllamaModel}">${ytOllamaModel || '(モデル未選択)'}</option>
      </select>
      <div class="gen-row" style="margin-top:8px">
        <button class="gen-btn danger" onclick="testOllamaConnection()">⚡ 接続テスト / モデル一覧取得</button>
      </div>
      <div class="gen-status" id="ollama-test-status" style="margin-top:4px"></div>
      <div style="margin-top:10px;padding:10px;background:rgba(245,200,66,.06);border:.5px solid rgba(245,200,66,.2);border-radius:6px;font-size:11px;font-family:var(--mono);line-height:2;color:var(--muted)">
        <div style="color:var(--accent);margin-bottom:2px">⚠ Failed to fetch の原因と対処</div>
        <div style="color:var(--text);margin-bottom:6px">file:// で開くとブラウザがlocalhost通信をブロックします。<br>このアプリを<b>ローカルサーバー経由</b>で開いてください：</div>
        <div style="background:var(--bg);padding:6px 8px;border-radius:4px;margin-bottom:4px;cursor:pointer;color:var(--text)" onclick="copyCmd('pyserver')" title="クリックでコピー">
          ① HTMLと同じフォルダでターミナルを開き実行<br>
          <span style="color:var(--accent)">python -m http.server 8080</span>
        </div>
        <div style="background:var(--bg);padding:6px 8px;border-radius:4px;margin-bottom:6px;cursor:pointer;color:var(--accent)" onclick="copyCmd('appurl')" title="クリックでコピー">
          ② ブラウザで開く URL（クリックでコピー）<br>
          http://localhost:8080/index.html
        </div>
        <div style="color:var(--text);margin-bottom:4px">③ Ollama も ORIGINS 設定が必要（一度だけ）：</div>
        <div style="background:var(--bg);padding:6px 8px;border-radius:4px;margin-bottom:4px;cursor:pointer;color:var(--text)" onclick="copyCmd('powershell')" title="クリックでコピー">
          <span style="color:var(--muted)">新しいターミナルで：</span><br>
          <span style="color:var(--accent)">$env:OLLAMA_ORIGINS="http://localhost:8080"; ollama serve</span>
        </div>
        <div style="color:var(--muted)">設定後「接続テスト」で確認してください</div>
      </div>
    </div>

    <div id="yt-prov-runpod" style="${ytLlmBackend==='runpod'?'':'display:none'}">
      <div class="gen-label" style="margin-top:6px">RunPod Endpoint URL（runsync可）</div>
      <input class="gen-input" id="yt-runpod-url" value="${runpodUrl}"
        oninput="runpodUrl=this.value" onchange="persistGenSettings()"
        placeholder="https://api.runpod.ai/v2/&lt;id&gt;/runsync">
      <div class="gen-label" style="margin-top:6px">RunPod API Key</div>
      <input class="gen-input" type="password" id="yt-runpod-key" value="${runpodApiKey}"
        oninput="runpodApiKey=this.value" onchange="persistGenSettings()"
        placeholder="rpa_..." autocomplete="off">
      <div class="gen-label" style="margin-top:6px">モデルID（vLLMにデプロイ済み）</div>
      <input class="gen-input" id="yt-runpod-model" value="${runpodModel}"
        oninput="runpodModel=this.value" onchange="persistGenSettings()" placeholder="qwen/qwen3.5-9b">
    </div>

    <div id="yt-prov-openrouter" style="${ytLlmBackend==='openrouter'?'':'display:none'}">
      <div class="gen-label" style="margin-top:6px">OpenRouter API Key</div>
      <input class="gen-input" type="password" id="yt-or-key" value="${orApiKey}"
        oninput="orApiKey=this.value" onchange="persistGenSettings()"
        placeholder="sk-or-..." autocomplete="off">
      <div class="gen-label" style="margin-top:6px">モデルID</div>
      <input class="gen-input" id="yt-or-model" value="${orModel}"
        oninput="orModel=this.value" onchange="persistGenSettings()" placeholder="qwen/qwen-2.5-72b-instruct">
    </div>

    <div id="yt-prov-openai" style="${ytLlmBackend==='openai'?'':'display:none'}">
      <div class="gen-label" style="margin-top:6px">OpenAI APIキー</div>
      <input class="gen-input" type="password" id="yt-oai-key" value="${oaiTransKey}"
        oninput="oaiTransKey=this.value" onchange="persistGenSettings()"
        placeholder="sk-..." autocomplete="off">
      <div class="gen-label" style="margin-top:6px">モデルID</div>
      <input class="gen-input" id="yt-oai-model" value="${oaiTransModel}"
        oninput="oaiTransModel=this.value" onchange="persistGenSettings()" placeholder="gpt-4o-mini">
      <div class="gen-label" style="margin-top:6px">エンドポイント（任意・空=公式）</div>
      <input class="gen-input" id="yt-oai-url" value="${oaiTransUrl}"
        oninput="oaiTransUrl=this.value" onchange="persistGenSettings()"
        placeholder="https://api.openai.com/v1/chat/completions">
    </div>
  </div>
</div>
<div class="lcard">
  <div class="gen-section">
    <div class="gen-label">親フォルダ（保存先）</div>
    <div class="gen-row">
      <button class="gen-btn danger" id="folder-pick-btn" onclick="selectSaveFolder()" ${fsa?'':'disabled style="opacity:.5;cursor:not-allowed"'}>📁 親フォルダを選択</button>
      <button class="gen-btn danger" onclick="clearSaveFolder()" style="font-size:10px">解除</button>
    </div>
    <div class="gen-status" id="folder-status"></div>
    <div style="font-size:10px;color:var(--muted);font-family:var(--mono);line-height:1.9;margin-top:6px">
      選択した親フォルダ内に<b>動画ごとのサブフォルダ</b>を自動作成し、<br>
      <span style="color:var(--a2)">動画 / data.json / data.md</span> を保存します（リロード後も記憶）。
      ${fsa?'':'<br><span style="color:var(--danger)">⚠ このブラウザはフォルダ保存に非対応です（Chrome/Edge 推奨）。保存は<b>ダウンロード</b>、読込は<b>ファイル選択</b>で全ブラウザ動作します。</span>'}
    </div>
  </div>
</div>`;
}

/* ── YouTube全自動の翻訳LLM切替（Ollama / RunPod / OpenRouter / OpenAI） ── */
function onYtLlmBackendChange(val){
  ytLlmBackend = val;
  ['ollama','runpod','openrouter','openai'].forEach(p=>{
    const sec = document.getElementById('yt-prov-'+p);
    if(sec) sec.style.display = (p === val) ? '' : 'none';
  });
  persistGenSettings();
  if(val==='ollama') testOllamaConnection();
}

/* ── Ollama接続テスト＋インストール済みモデル一覧の取得 ── */
async function testOllamaConnection(){
  const statusEl = document.getElementById('ollama-test-status');
  const sel = document.getElementById('yt-ollama-model');
  const url = (genOllamaUrl||'http://localhost:11434').replace(/\/$/,'');
  if(statusEl){ statusEl.textContent='テスト中...'; statusEl.className='gen-status'; }
  try{
    /* GET /api/tags でインストール済みモデル一覧を取得 → 接続確認 */
    const resp = await fetch(url+'/api/tags', {method:'GET'});
    if(!resp.ok) throw new Error('HTTP '+resp.status);
    const data = await resp.json();
    const models = (data.models||[]).map(m=>m.name);
    if(statusEl){
      statusEl.textContent = models.length
        ? `✓ 接続OK — ${models.length}個のモデルを取得しました`
        : '✓ 接続OK（インストール済みモデルがありません）';
      statusEl.className = 'gen-status ok';
    }
    /* モデル選択肢をインストール済み一覧で更新（現在の選択は可能なら維持） */
    if(sel && models.length){
      const current = ytOllamaModel;
      sel.innerHTML = models.map(m=>`<option value="${m}"${m===current?' selected':''}>${m}</option>`).join('');
      if(!models.includes(current)){
        sel.value = models[0];
        ytOllamaModel = models[0];
        persistGenSettings();
      }
    }
  } catch(err){
    if(statusEl){
      statusEl.textContent = '✗ 接続失敗: '+err.message+' → CORS設定を確認してください';
      statusEl.className = 'gen-status err';
    }
  }
}

/* ── コマンドをクリップボードにコピー ── */
function copyCmd(type){
  const cmds = {
    powershell: '$env:OLLAMA_ORIGINS="http://localhost:8080"; ollama serve',
    setx:       'setx OLLAMA_ORIGINS "http://localhost:8080" & ollama serve',
    pyserver:   'python -m http.server 8080',
    appurl:     'http://localhost:8080/index.html'
  };
  const text = cmds[type] || '';
  navigator.clipboard.writeText(text).then(()=>{
    showToast('コピーしました: '+text, false, 2500);
  }).catch(()=>{
    showToast(text, false, 4000);
  });
}

/* ── 親フォルダ選択（FSA API・非対応ブラウザはダウンロード保存にフォールバック） ── */
async function selectSaveFolder(){
  if(!fsaSupported()){
    showToast('このブラウザはフォルダ保存に非対応です（Chrome/Edge推奨）。\n保存はダウンロードになります。',false,4500);
    return;
  }
  try{
    fsaDirHandle = await window.showDirectoryPicker({mode:'readwrite'});
    await idbSetHandle(fsaDirHandle);   /* リロード後も記憶 */
    refreshFolderStatus();
    showToast('✓ 親フォルダを設定: '+fsaDirHandle.name,false,3000);
  } catch(e){
    if(e.name!=='AbortError') showToast('フォルダ選択キャンセル',false,2000);
  }
}

/* ── 親フォルダ設定を解除 ── */
async function clearSaveFolder(){
  fsaDirHandle = null;
  await idbDelHandle();
  refreshFolderStatus();
  showToast('親フォルダ設定を解除しました（以後はダウンロード保存）',false,3000);
}

