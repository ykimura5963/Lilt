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

/* ── フォルダ選択 → FileList を解析してプロジェクト一覧を構築 → モーダル表示 ── */
async function onLocalDirSelected(input){
  const files = Array.from(input.files || []);
  input.value = '';   /* 同じフォルダを選び直せるようリセット */
  if(!files.length) return;

  /* data.json を含むサブフォルダ＝プロジェクト。
     webkitRelativePath 例: "親/動画ID/data.json" → ファイルの1つ上の階層で束ねる。*/
  const projects = {};
  for(const f of files){
    const rel = f.webkitRelativePath || f.name;
    const segs = rel.split('/');
    if(segs.length < 2) continue;                 /* 親フォルダ名＋ファイル名は最低限必要 */
    const fname = segs[segs.length - 1];
    const id    = segs[segs.length - 2];
    const key   = segs.slice(0, segs.length - 1).join('/');
    (projects[key] || (projects[key] = { id, files: {} })).files[fname] = f;
  }

  const list = Object.values(projects).filter(p => p.files['data.json']);
  if(!list.length){
    showToast('data.json を含むプロジェクトフォルダが見つかりませんでした', true, 4500);
    return;
  }
  await Promise.all(list.map(async p => { p.title = await _readLocalTitle(p); }));
  list.sort((a, b) => (a.title || a.id).localeCompare(b.title || b.id));
  window._localProjItems = list;
  renderLocalLibrary();
}

/* ── 端末ローカルのプロジェクト一覧をライブラリモーダルに表示 ── */
function renderLocalLibrary(){
  /* バックエンド用のルート入力・説明は隠す */
  const descEl  = document.getElementById('lib-desc');     if(descEl)  descEl.style.display = 'none';
  const rootRow = document.getElementById('lib-root-row'); if(rootRow) rootRow.style.display = 'none';
  document.getElementById('lib-modal').style.display = 'flex';

  const statusEl = document.getElementById('lib-status');
  const listEl   = document.getElementById('lib-list');
  const items    = window._localProjItems || [];
  statusEl.textContent = `端末内: ${items.length}件`;
  statusEl.className    = 'gen-status ok';
  listEl.innerHTML = items.map((p, idx) => `
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
  const dataFile = proj.files['data.json'];
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
  const notesFile = proj.files['notes.json'];
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
  const media = _findLocalMedia(proj.files);
  if(media){
    if(window._localObjURL){ try{ URL.revokeObjectURL(window._localObjURL); }catch(e){} }
    window._localObjURL = URL.createObjectURL(media);
    vid.src = window._localObjURL;
    vid.load();
  }
  if(typeof applyPlaybackSpeed === 'function') applyPlaybackSpeed();
  document.getElementById('local-wrap').style.display = '';
  document.getElementById('yt-wrap').style.display    = 'none';
  document.getElementById('no-file').style.display    = media ? 'none' : 'flex';
  document.getElementById('file-name').textContent  = proj.title || proj.id;
  document.getElementById('header-sub').textContent = proj.title || proj.id;
  currentBase = proj.id;
  window._localVideoFile = null;
  return data.paras.length;
}
