/* ── JSON構築 ── */
function buildAnnotationJSON(paras){
  return JSON.stringify({
    version: '2',
    contentBase: currentBase || 'unknown',
    generatedAt: new Date().toISOString(),
    paras: bakeTempoTimings(paras)   /* ws=テンポ焼き込み + wsUniform=均等割り */
  }, null, 2);
}

/* ── 保存: 動画名フォルダを作成して data.json / data.md / 動画 を保存 ── */
async function saveAnnotationJSON(jsonStr){
  const base = currentBase || 'annotation';

  if(fsaDirHandle){
    try{
      /* 動画名フォルダを作成（既存なら取得） */
      const subDir = await fsaDirHandle.getDirectoryHandle(base, {create: true});

      /* data.json を保存 */
      const jFh = await subDir.getFileHandle('data.json', {create: true});
      const jW  = await jFh.createWritable();
      await jW.write(jsonStr);
      await jW.close();

      /* data.md を生成して保存 */
      const mdText = buildDataMdText(base, PARAS);
      const mFh = await subDir.getFileHandle('data.md', {create: true});
      const mW  = await mFh.createWritable();
      await mW.write(mdText);
      await mW.close();

      /* 動画ファイルを同フォルダにコピー（ローカルファイル読み込み時のみ） */
      if(window._localVideoFile){
        const vName = window._localVideoFile.name;
        const vFh = await subDir.getFileHandle(vName, {create: true});
        const vW  = await vFh.createWritable();
        await vW.write(window._localVideoFile);
        await vW.close();
        showToast(`✓ 保存完了: ${base}/\n data.json / data.md / ${vName}`, false, 5000);
      } else {
        showToast(`✓ 保存完了: ${base}/\n data.json / data.md`, false, 4000);
      }
      return;
    } catch(e){
      showToast('FSA保存失敗、ダウンロードに切替: '+e.message, false, 3000);
    }
  }

  /* ダウンロードフォールバック（FSA未選択時）*/
  const blob = new Blob([jsonStr], {type: 'application/json'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = base + '.annotation.json';
  a.click();
  URL.revokeObjectURL(a.href);
  showToast(`✓ ダウンロード: ${base}.annotation.json`, false, 3500);
}

/* ── 既存JSONを読み込む ── */
function loadAnnotationFile(){
  document.getElementById('anno-file-input').click();
}
function onAnnotationFileLoad(input){
  const file = input.files[0]; if(!file) return;
  const reader = new FileReader();
  reader.onload = e=>{
    try{
      const data = JSON.parse(e.target.result);
      if(!data.paras||!Array.isArray(data.paras)) throw new Error('parasフィールドが見つかりません');
      window.PARAS.length=0;
      data.paras.forEach((p,i)=>{
        p.id=i;
        const end = p.end ?? (p.start + Math.max(2, (p.en||'').split(/\s+/).filter(Boolean).length * 0.35));
        p.end = end;
        p.words=assignWordTimings(enrichPronunciationWords(p.words||[], p.en), p.start, end);
        window.PARAS.push(p);
      });
      totalDur = data.paras[data.paras.length-1]?.end || totalDur;
      renderTranscript();
      document.getElementById('anno-load-status').textContent = `✓ ${data.paras.length}段落を読み込みました (${file.name})`;
      document.getElementById('anno-load-status').className = 'gen-status ok';
      showToast(`✓ ${file.name} を読み込みました`, false, 3000);
    } catch(err){
      document.getElementById('anno-load-status').textContent = '読み込みエラー: '+err.message;
      document.getElementById('anno-load-status').className = 'gen-status err';
    }
  };
  reader.readAsText(file);
}

/* ── ローカルファイル選択時に currentBase を更新 ── */
const _origFileListener = document.getElementById('local-file');
_origFileListener.addEventListener('change', function(){
  const f = this.files[0]; if(!f) return;
  currentBase = f.name.replace(/\.[^.]+$/,'');
  /* 同名 annotation.json の自動読み込みを試みる（FSA経由） */
  tryAutoLoadAnnotation(currentBase);
});

/* ── 自動読み込み: 動画と同フォルダの data.json と data.md を同時読み込み ── */
async function tryAutoLoadAnnotation(base){
  if(!fsaDirHandle) return;

  /* サブフォルダ {base}/ があればそこを優先、なければ現在のFSAフォルダを使用 */
  let targetDir = fsaDirHandle;
  try{
    const sub = await fsaDirHandle.getDirectoryHandle(base);
    targetDir = sub;
  } catch(e){ /* サブフォルダなし → 現フォルダで探す */ }

  /* ── JSON 読み込み: data.json → {base}.annotation.json の順で探す ── */
  const jsonCandidates = ['data.json', base + '.annotation.json'];
  let jsonLoaded = false;
  for(const fname of jsonCandidates){
    try{
      const fh   = await targetDir.getFileHandle(fname);
      const data = JSON.parse(await (await fh.getFile()).text());
      if(data.paras && Array.isArray(data.paras)){
        window.PARAS.length=0;
        data.paras.forEach((p,i)=>{
          p.id=i;
          const end = p.end ?? (p.start + Math.max(2, (p.en||'').split(/\s+/).filter(Boolean).length*0.35));
          p.end = end;
          p.words = assignWordTimings(enrichPronunciationWords(p.words||[], p.en), p.start, end);
          window.PARAS.push(p);
        });
        totalDur = data.paras[data.paras.length-1]?.end || totalDur;
        renderTranscript();
        jsonLoaded = true;
        showToast(`✓ ${fname} を自動読み込みしました`, false, 3000);
        break;
      }
    } catch(e){ /* 次の候補へ */ }
  }

  /* ── MD 読み込み: data.md を探してGenerateテキストエリアへ ── */
  try{
    const mdFh   = await targetDir.getFileHandle('data.md');
    const mdText = await (await mdFh.getFile()).text();
    const parsed = parseMdToTranscript(mdText);
    if(parsed){
      window._pendingMdTranscript = parsed;
      if(jsonLoaded) showToast('✓ data.md も読み込みました（生成タブで確認）', false, 3000);
    }
  } catch(e){ /* data.md なし → 無視 */ }
}

/* switchTab は上で直接拡張済み */

/* ══ 親フォルダハンドルの永続化（IndexedDB） ══ */
const _IDB_DB='lilt', _IDB_STORE='handles', _IDB_KEY='parentDir';
function _idb(){
  return new Promise((res,rej)=>{
    const r=indexedDB.open(_IDB_DB,1);
    r.onupgradeneeded=()=>{ r.result.createObjectStore(_IDB_STORE); };
    r.onsuccess=()=>res(r.result);
    r.onerror=()=>rej(r.error);
  });
}
async function idbSetHandle(h){
  try{ const db=await _idb(); await new Promise((res,rej)=>{const tx=db.transaction(_IDB_STORE,'readwrite');tx.objectStore(_IDB_STORE).put(h,_IDB_KEY);tx.oncomplete=res;tx.onerror=()=>rej(tx.error);}); }catch(e){}
}
async function idbGetHandle(){
  try{ const db=await _idb(); return await new Promise((res,rej)=>{const tx=db.transaction(_IDB_STORE,'readonly');const rq=tx.objectStore(_IDB_STORE).get(_IDB_KEY);rq.onsuccess=()=>res(rq.result||null);rq.onerror=()=>rej(rq.error);}); }catch(e){ return null; }
}
async function idbDelHandle(){
  try{ const db=await _idb(); await new Promise((res,rej)=>{const tx=db.transaction(_IDB_STORE,'readwrite');tx.objectStore(_IDB_STORE).delete(_IDB_KEY);tx.oncomplete=res;tx.onerror=()=>rej(tx.error);}); }catch(e){}
}

/* ── フォルダ状態表示を更新（設定タブ） ── */
function refreshFolderStatus(){
  const el=document.getElementById('folder-status');
  if(!el) return;
  if(!fsaSupported()){
    el.textContent='非対応ブラウザ — ダウンロード保存／ファイル選択読込で動作します';
    el.className='gen-status';
  }else if(fsaDirHandle){
    el.textContent='✓ 親フォルダ: '+fsaDirHandle.name;
    el.className='gen-status ok';
  }else if(window._pendingDirHandle){
    el.innerHTML='⚠ 記憶済み「'+window._pendingDirHandle.name+'」に再接続が必要 → <a href="#" onclick="reconnectSaveFolder();return false" style="color:var(--a2)">再接続</a>';
    el.className='gen-status';
  }else{
    el.textContent='未選択 — 保存はダウンロードになります';
    el.className='gen-status';
  }
}

/* ── 起動時: 記憶済み親フォルダの復元（権限があれば即利用、なければ再接続待ち） ── */
async function restoreSavedFolder(){
  if(!fsaSupported()) return;
  const h=await idbGetHandle();
  if(!h) return;
  try{
    const perm=await h.queryPermission({mode:'readwrite'});
    if(perm==='granted'){ fsaDirHandle=h; }
    else { window._pendingDirHandle=h; }
  }catch(e){ /* 無視 */ }
  refreshFolderStatus();
}

/* ── 記憶済みフォルダへ再接続（ユーザー操作で権限要求） ── */
async function reconnectSaveFolder(){
  const h=window._pendingDirHandle; if(!h) return;
  try{
    const perm=await h.requestPermission({mode:'readwrite'});
    if(perm==='granted'){ fsaDirHandle=h; window._pendingDirHandle=null; showToast('✓ 親フォルダに再接続: '+h.name,false,2500); }
    else { showToast('権限が許可されませんでした',true,3000); }
  }catch(e){ showToast('再接続エラー: '+e.message,true,3000); }
  refreshFolderStatus();
}

/* ── モーダルヘルパー ── */
function setModalStatus(msg, pct, isErr=false){
  document.getElementById('modal-status').textContent = msg;
  document.getElementById('modal-prog').style.width = pct+'%';
}
function addModalParaItem(idx, text, state){
  const list = document.getElementById('modal-para-list');
  const id   = 'mp-item-'+idx;
  let el = document.getElementById(id);
  if(!el){
    el = document.createElement('div');
    el.id = id;
    list.appendChild(el);
  }
  const icon = state==='done' ? '✓' : state==='error' ? '✗' : '…';
  const col  = state==='done' ? 'var(--accent)' : state==='error' ? 'var(--danger)' : 'var(--muted)';
  el.style.color = col;
  el.textContent = `${icon} P${idx+1}: ${text.slice(0,50)}${text.length>50?'…':''}`;
}
function cancelGeneration(){
  genAbort = true;
  document.getElementById('gen-modal').style.display='none';
}
function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }

/* ── 生成タブ設定の永続化（バックエンド/モデル） ── */
function persistGenSettings(){
  saveSettings({
    ytBackendUrl, ytOllamaModel, ytLlmBackend,
    runpodUrl, runpodApiKey, runpodModel,
    orApiKey, orModel,
    oaiTransKey, oaiTransModel, oaiTransUrl,
    genOllamaUrl
  });
}

/* ── 保存済み設定を起動時に復元しUIへ反映 ── */
function applySavedSettings(){
  const s = loadSettings();
  if(typeof s.showStress  === 'boolean') showStress  = s.showStress;
  if(typeof s.showInton   === 'boolean') showInton   = s.showInton;
  if(typeof s.showElision === 'boolean') showElision = s.showElision;
  if(typeof s.rhythmSync  === 'boolean') rhythmSync  = s.rhythmSync;
  if(typeof s.autoFollow  === 'boolean') autoFollow  = s.autoFollow;
  if(typeof s.fontScale   === 'number')  fontScale   = Math.min(1.6, Math.max(0.8, s.fontScale));
  if(typeof s.timeOffset  === 'number')  timeOffset  = s.timeOffset;
  if(typeof s.playSpeed   === 'number')  playSpeed   = s.playSpeed;
  if(typeof s.ytBackendUrl  === 'string') ytBackendUrl  = s.ytBackendUrl;
  if(typeof s.ytOllamaModel === 'string') ytOllamaModel = s.ytOllamaModel;
  if(typeof s.ytLlmBackend  === 'string') ytLlmBackend  = s.ytLlmBackend;
  if(typeof s.runpodUrl     === 'string') runpodUrl     = s.runpodUrl;
  if(typeof s.runpodApiKey  === 'string') runpodApiKey  = s.runpodApiKey;
  if(typeof s.runpodModel   === 'string') runpodModel   = s.runpodModel;
  if(typeof s.orApiKey      === 'string') orApiKey      = s.orApiKey;
  if(typeof s.orModel       === 'string') orModel       = s.orModel;
  if(typeof s.oaiTransKey   === 'string') oaiTransKey   = s.oaiTransKey;
  if(typeof s.oaiTransModel === 'string') oaiTransModel = s.oaiTransModel;
  if(typeof s.oaiTransUrl   === 'string') oaiTransUrl   = s.oaiTransUrl;
  if(typeof s.genOllamaUrl  === 'string') genOllamaUrl  = s.genOllamaUrl;

  /* コントロールバーのトグル状態を反映 */
  const setOn=(id,on)=>{const b=document.getElementById(id); if(b) b.classList.toggle('on',!!on);};
  setOn('btn-stress',showStress); setOn('btn-inton',showInton); setOn('btn-elision',showElision);
  setOn('btn-rhythm',rhythmSync); setOn('btn-follow',autoFollow);

  /* 速度セレクト */
  const spd=document.getElementById('spd-sel');
  if(spd){ spd.value=String(playSpeed); }
  applyPlaybackSpeed();

  /* オフセット */
  const osl=document.getElementById('offset-slider'); if(osl) osl.value=timeOffset;
  const ovl=document.getElementById('offset-val');
  if(ovl) ovl.textContent=(timeOffset>=0?'+':'')+timeOffset.toFixed(1)+' s';
}

/* ── バックエンド健全性チェック（生成タブ表示時） ── */
async function checkBackendHealth(){
  const badge=document.getElementById('backend-health');
  if(!badge) return;
  const bkUrl=document.getElementById('yt-backend-url')?.value?.trim() || ytBackendUrl;
  badge.textContent='接続確認中...';
  badge.className='gen-status';
  try{
    const r=await fetch(`${bkUrl}/health`);
    if(!r.ok) throw new Error('HTTP '+r.status);
    const h=await r.json();
    const ff = h.ffmpeg ? '✓ ffmpeg' : '✗ ffmpeg(未検出: 動画DL不可の場合あり)';
    const ol = h.ollama ? `✓ Ollama(${(h.models||[]).length}モデル)` : '✗ Ollama未起動';
    badge.innerHTML = `${ff} ／ ${ol}`;
    badge.className = 'gen-status ' + ((h.ffmpeg && h.ollama) ? 'ok' : 'err');
  }catch(err){
    badge.textContent='✗ バックエンド未接続（uvicorn起動を確認）';
    badge.className='gen-status err';
  }
}

