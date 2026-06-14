/* ══════════════════════════════════════════════════════════
   スマホ（Android）ローカルプレイヤー
   ・生成系・バックエンドは使わず、端末ローカルに保存したフォルダを対象に再生する。
   ・<input type="file" webkitdirectory> で親フォルダを選ぶと配下の全ファイルが
     webkitRelativePath 付きで取得できる。data.json を含むサブフォルダ＝プロジェクト
     として一覧化し（PCのバックエンド /projects 相当）、選択時に各ファイル
     （video.* / data.json / notes.json）を File から直接読み込む。
   ・読み取り専用（書き戻し不可）のためメモ等の保存は行わない（表示のみ）。
   公開関数: pickLocalDir / onLocalDirSelected / loadLocalProject
══════════════════════════════════════════════════════════ */

/* ── 親フォルダ選択ダイアログを開く（openLibrary からスマホ時に呼ばれる） ── */
function pickLocalDir(){
  const inp = document.getElementById('local-dir');
  if(inp) inp.click();
}

/* ── プロジェクト内の動画ファイルを探す（video.* 優先、無ければ任意の動画/音声） ── */
function _findLocalMedia(files){
  const names = Object.keys(files);
  const exts = /\.(mp4|m4a|webm|mov|mkv|ogg|ogv|mp3|wav|aac)$/i;
  let n = names.find(x => /^video\./i.test(x) && exts.test(x));
  if(!n) n = names.find(x => exts.test(x));
  return n ? files[n] : null;
}

/* ── 表示名: title.txt（先頭の非空行）→ フォルダ名 ── */
async function _readLocalTitle(proj){
  const t = proj.files['title.txt'];
  if(t){
    try{
      const txt = await t.text();
      const line = txt.split('\n').map(s => s.trim()).find(Boolean);
      if(line) return line;
    }catch(e){ /* 読めなければフォルダ名 */ }
  }
  return proj.id;
}

/* ── フォルダ選択 → FileList を解析してプロジェクト一覧を構築 → モーダル表示 ──
   優先順: ① 親フォルダ直下の video_index.json（バックエンドが書き出す静的一覧）
           ② 無ければ data.json を含むサブフォルダを走査（後方互換） */
async function onLocalDirSelected(input){
  const files = Array.from(input.files || []);
  input.value = '';   /* 同じフォルダを選び直せるようリセット */
  if(!files.length) return;

  /* 選んだフォルダ直下を基準にした相対パス → File のマップ。
     webkitRelativePath 例 "親/動画ID/data.json" の先頭セグメント（選択フォルダ名）を除く。*/
  const byRel = {};
  for(const f of files){
    const segs = (f.webkitRelativePath || f.name).split('/');
    byRel[segs.slice(1).join('/')] = f;          /* → "動画ID/data.json" */
  }

  /* ① video_index.json があれば最優先（順序・表示名・読込ファイル名を尊重、走査不要） */
  const idxFile = byRel['video_index.json'];
  if(idxFile){
    try{
      const idx  = JSON.parse(await idxFile.text());
      const list = _buildLocalListFromIndex(idx, byRel);
      if(list.length){ window._localProjItems = list; renderLocalLibrary(); return; }
    }catch(e){ /* インデックス不正 → 走査にフォールバック */ }
  }

  /* ② フォールバック: data.json を含むサブフォルダ＝プロジェクトとして束ねる */
  const projects = {};
  Object.keys(byRel).forEach(rel=>{
    const segs = rel.split('/');
    if(segs.length < 2) return;                   /* 直下のファイルは対象外 */
    const fname = segs[segs.length - 1];
    const id    = segs[segs.length - 2];
    const key   = segs.slice(0, segs.length - 1).join('/');
    (projects[key] || (projects[key] = { id, files: {} })).files[fname] = byRel[rel];
  });

  const list = Object.values(projects).filter(p => p.files['data.json']);
  if(!list.length){
    showToast('video_index.json も data.json を含むフォルダも見つかりませんでした', true, 4500);
    return;
  }
  await Promise.all(list.map(async p => { p.title = await _readLocalTitle(p); }));
  list.sort((a, b) => (a.title || a.id).localeCompare(b.title || b.id));
  window._localProjItems = list;
  renderLocalLibrary();
}

/* ── video_index.json（{version,projects:[...]} か素の配列）→ ローカル読込用の配列 ──
   各プロジェクトのフォルダ配下の File を集め、loadProjectBundleLocal が使う形に整える。*/
function _buildLocalListFromIndex(idx, byRel){
  const projs = Array.isArray(idx) ? idx : (idx && idx.projects) || [];
  const out = [];
  projs.forEach(p=>{
    const dir    = String(p.dir || p.id || '').replace(/^\/+|\/+$/g, '');
    const prefix = dir ? dir + '/' : '';
    /* このプロジェクトフォルダ配下の File を、フォルダ内相対名をキーに集める */
    const pfiles = {};
    Object.keys(byRel).forEach(rel=>{
      if(prefix && rel.indexOf(prefix) === 0) pfiles[rel.slice(prefix.length)] = byRel[rel];
    });
    if(!Object.keys(pfiles).length) return;       /* 実体の無い項目はスキップ */
    out.push({
      id:    p.id || dir,
      title: p.title || p.id || dir,
      files: pfiles,
      _names:{ data: p.data || 'data.json', video: p.video || null,
               notes: p.notes || 'notes.json', md: p.md || 'data.md' },
    });
  });
  return out;
}

/* ── ローカル（バックエンド不要）ライブラリを開く（スマホの「動画を開く」入口） ── */
function openLocalLibrary(){
  renderLocalLibrary();   /* 選択済みなら一覧、未選択ならフォルダ選択を促す */
}

/* ── 端末ローカルのプロジェクト一覧をライブラリモーダルに表示 ── */
function renderLocalLibrary(){
  /* バックエンド用のルート入力・説明は隠す（PCでフォルダ選択した場合も同様） */
  const descEl  = document.getElementById('lib-desc');     if(descEl)  descEl.style.display = 'none';
  const rootRow = document.getElementById('lib-root-row'); if(rootRow) rootRow.style.display = 'none';
  document.getElementById('lib-modal').style.display = 'flex';

  const statusEl = document.getElementById('lib-status');
  const listEl   = document.getElementById('lib-list');
  const items    = window._localProjItems || [];

  /* 常に先頭へ「親フォルダを選択」ボタンを置く（再選択も可能） */
  const pickBtn = `<div style="display:flex;gap:6px;margin-bottom:8px;flex-wrap:wrap">
      <button class="file-btn" onclick="pickLocalDir()">📁 親フォルダを選択</button>
    </div>`;

  if(!items.length){
    statusEl.textContent = '親フォルダを選択してください';
    statusEl.className    = 'gen-status';
    listEl.innerHTML = pickBtn +
      `<div style="font-size:11px;color:var(--muted);font-family:var(--mono);line-height:1.7;padding:4px">`
      + `端末内の親フォルダを選ぶと、配下の data.json を持つフォルダを動画一覧として表示します。`
      + `</div>`;
    return;
  }

  statusEl.textContent = `端末内: ${items.length}件`;
  statusEl.className    = 'gen-status ok';
  listEl.innerHTML = pickBtn + items.map((p, idx) => `
    <div class="lib-item">
      <span class="lib-name" title="${_esc(p.id)}">${_esc(p.title || p.id)}</span>
      <button class="yt-proj-load" onclick="loadLocalProject(${idx})">読込</button>
    </div>`).join('');
}

/* ── 選択したローカルプロジェクトを読み込む ── */
async function loadLocalProject(idx){
  const proj = (window._localProjItems || [])[idx];
  if(!proj) return;
  try{
    const n = await loadProjectBundleLocal(proj);
    closeLibrary();
    showToast(`✓ ${proj.title || proj.id} を読み込みました（${n}段落）`, false, 4000);
  }catch(err){
    showToast('読み込みエラー: ' + err.message, true, 5000);
  }
}

/* ── ローカル File 群からプロジェクトを読み込む（loadProjectBundle のローカル版） ── */
async function loadProjectBundleLocal(proj){
  const nm = proj._names || {};   /* video_index.json で指定された読込ファイル名（無ければ既定） */
  const dataFile = proj.files[nm.data || 'data.json'] || proj.files['data.json'];
  if(!dataFile) throw new Error('data.json がありません');
  const data = JSON.parse(await dataFile.text());
  if(!Array.isArray(data.paras)) throw new Error('parasフィールドがありません');

  PARAS.length = 0;
  data.paras.forEach((p, i) => {
    p.id  = i;
    const estEnd = p.end ?? (p.start + Math.max(2, (p.en || '').split(/\s+/).filter(Boolean).length * 0.35));
    p.end = estEnd;
    p.words = buildWordsFromParsed(p.words || [], p, 0.35);
    PARAS.push(p);
  });
  const lastPara = PARAS[PARAS.length - 1];
  if(lastPara) totalDur = lastPara.end;

  /* チャンクメモ: フォルダの notes.json（読み取り専用）を基に、端末ローカル（localStorage）の
     編集分を重ねる。編集の保存先は localStorage（書き戻し不可のため）。 */
  NOTES = {};
  const notesFile = proj.files[nm.notes || 'notes.json'] || proj.files['notes.json'];
  if(notesFile && typeof _applyNotesText === 'function'){
    try{ _applyNotesText(await notesFile.text()); }catch(e){ /* メモ無し扱い */ }
  }
  if(typeof _loadNotesLS === 'function'){
    /* localStorage に編集履歴があればそれを優先で重ねる（保存時は全件書き出しのため最新状態） */
    _mergeNotesMap(_loadNotesLS(proj.id));
  }
  window._noteCtx = { mode: 'localstorage', id: proj.id };

  renderTranscript();

  /* 動画を Blob URL で読み込む（前回の Blob URL は解放） */
  const vid = document.getElementById('vid');
  vid.controls = false;
  /* 動画ファイル名: インデックス指定があれば優先、無ければ video.* を自動検出 */
  const media = (nm.video && proj.files[nm.video]) || _findLocalMedia(proj.files);
  if(media){
    if(window._localObjURL){ try{ URL.revokeObjectURL(window._localObjURL); }catch(e){} }
    window._localObjURL = URL.createObjectURL(media);
    vid.src = window._localObjURL;
    vid.load();
  }
  if(typeof applyPlaybackSpeed === 'function') applyPlaybackSpeed();
  document.getElementById('local-wrap').style.display = '';
  document.getElementById('yt-wrap').style.display    = 'none';
  document.getElementById('file-name').textContent  = proj.title || proj.id;
  document.getElementById('header-sub').textContent = proj.title || proj.id;
  currentBase = proj.id;
  window._localVideoFile = null;
  return data.paras.length;
}
