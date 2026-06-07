/* ══════════════════════════════════════════════════════════
   シャドーイング Tier 1 / Step 1 — チャンク録音 + A/B 比較
   ・録音はすべてブラウザ内（メモリ）に留まり、サーバー送信はしない。
   ・既存の jumpTo（区間シーク）／playSpeed（ピッチ保持）を再利用。
   公開関数（インラインハンドラから呼ぶ）：
     shadowRecordToggle / startRec / stopRec
     playModel / playRecording / toggleAB
     refreshShadowControls / refreshAllShadowControls
══════════════════════════════════════════════════════════ */

let _shadowStream   = null;   /* 取得済みマイクストリーム（再利用） */
let _shadowRec      = null;   /* MediaRecorder インスタンス */
let _shadowRecPi    = -1;     /* 録音中（カウントイン含む）のチャンクID, -1=非録音 */
let _shadowMime     = '';     /* 採用した mimeType */
let _shadowStopTimer  = null; /* 録音の自動停止タイマー */
let _shadowCountTimer = null; /* カウントインのタイマー */
let _modelStopTimer = null;   /* モデル区間再生の停止タイマー */
const _recStore = new Map();  /* paraId -> { blob, url, sec } */
const _abNext   = new Map();  /* paraId -> 'model' | 'rec'（A/B交互再生） */

/* VU メーター（録音中の入力レベル可視化） */
let _vuRAF = null, _vuCtx = null, _vuAnalyser = null;

const REC_TAIL_MS = 600;      /* 自動停止時にチャンク末尾へ足す余白(ms) */
const COUNT_IN    = 3;        /* 録音前カウントイン秒（0で無効） */

/* ── 録音形式の選択（ブラウザ差をフォールバックで吸収） ── */
function _pickMime(){
  if(typeof MediaRecorder === 'undefined' || !MediaRecorder.isTypeSupported) return '';
  const cands = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
  for(const c of cands){ if(MediaRecorder.isTypeSupported(c)) return c; }
  return '';
}

/* ── マイク取得（初回のみ。以降は保持したストリームを再利用） ── */
async function _ensureMic(){
  if(_shadowStream) return _shadowStream;
  if(!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia){
    const e = new Error('NotSupported'); e.name = 'NotSupportedError'; throw e;
  }
  _shadowStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  return _shadowStream;
}

/* ── 🎤 トグル：同じチャンクなら停止、別チャンクなら切替録音 ── */
function shadowRecordToggle(pi, e){
  if(e) e.stopPropagation();
  if(_shadowRecPi === pi){ stopRec(); return; }
  if(_shadowRecPi !== -1){ stopRec(); }
  startRec(pi);
}

/* ── 録音開始（カウントイン → 録音 → チャンク長で自動停止） ── */
async function startRec(pi){
  if(pi < 0 || pi >= PARAS.length) return;
  _shadowRecPi = pi;
  refreshShadowControls(pi);

  let stream;
  try{
    stream = await _ensureMic();
  }catch(err){
    const msg = err.name === 'NotAllowedError' ? 'マイクの使用が許可されませんでした（ブラウザの許可を確認してください）'
              : err.name === 'NotFoundError'   ? 'マイクが見つかりません'
              : err.name === 'NotSupportedError' ? 'このブラウザはマイク録音に対応していません'
              : ('マイク取得エラー: ' + (err.message || err.name));
    showToast(msg, true, 4500);
    _shadowRecPi = -1; refreshShadowControls(pi);
    return;
  }
  if(_shadowRecPi !== pi) return;            /* 取得中に停止された */

  _shadowMime = _shadowMime || _pickMime();
  await _countIn();
  if(_shadowRecPi !== pi) return;            /* カウントイン中に停止された */
  _beginRecording(pi, stream);
}

/* ── 録音の実処理（マイク取得済み前提・カウントインなし）。
      onDone は保存完了後に呼ばれる（練習ループのステップ解決に使用） ── */
function _beginRecording(pi, stream, onDone){
  const chunks = [];
  try{
    _shadowRec = _shadowMime ? new MediaRecorder(stream, { mimeType: _shadowMime })
                             : new MediaRecorder(stream);
  }catch(err){
    showToast('録音の初期化に失敗しました: ' + err.message, true, 4000);
    _shadowRecPi = -1; refreshShadowControls(pi);
    if(onDone) onDone();
    return;
  }
  _shadowRec.ondataavailable = ev => { if(ev.data && ev.data.size) chunks.push(ev.data); };
  _shadowRec.onstop = () => {
    const type = _shadowMime || 'audio/webm';
    const blob = new Blob(chunks, { type });
    const prev = _recStore.get(pi);
    if(prev && prev.url) URL.revokeObjectURL(prev.url);    /* 旧テイクのObjectURLを解放 */
    _recStore.set(pi, { blob, url: URL.createObjectURL(blob), sec: PARAS[pi].end - PARAS[pi].start });
    refreshShadowControls(pi);
    if(onDone) onDone();
  };
  _shadowRecPi = pi;
  _shadowRec.start();
  _startVU(stream);
  refreshShadowControls(pi);

  /* チャンク長（実時間）＋余白で自動停止。録音は実時間なので playSpeed の影響を受けない */
  const durMs = (PARAS[pi].end - PARAS[pi].start) * 1000 + REC_TAIL_MS;
  _shadowStopTimer = setTimeout(() => stopRec(), durMs);
}

/* ── 録音停止（カウントイン中／録音中いずれにも対応） ── */
function stopRec(){
  const pi = _shadowRecPi;
  if(_shadowCountTimer){ clearTimeout(_shadowCountTimer); _shadowCountTimer = null; }
  if(_shadowStopTimer){ clearTimeout(_shadowStopTimer);  _shadowStopTimer = null; }
  const ov = document.getElementById('sh-countin'); if(ov) ov.classList.remove('show');
  _stopVU();
  if(_shadowRec && _shadowRec.state !== 'inactive'){ try{ _shadowRec.stop(); }catch(e){} }
  _shadowRecPi = -1;
  if(pi >= 0) refreshShadowControls(pi);
}

/* ── カウントイン（3·2·1）。停止されたら即解決 ── */
function _countIn(){
  return new Promise(resolve => {
    if(!COUNT_IN){ resolve(); return; }
    const ov = document.getElementById('sh-countin');
    let n = COUNT_IN;
    const tick = () => {
      if(_shadowRecPi === -1){ if(ov) ov.classList.remove('show'); resolve(); return; }
      if(n <= 0){ if(ov) ov.classList.remove('show'); resolve(); return; }
      if(ov){ ov.textContent = String(n); ov.classList.add('show'); }
      _beep(660, 0.07);
      n--;
      _shadowCountTimer = setTimeout(tick, 1000);
    };
    tick();
  });
}

/* ── 短いビープ（カウントイン用・任意） ── */
function _beep(freq, dur){
  try{
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator(), gain = ctx.createGain();
    osc.frequency.value = freq; osc.type = 'sine';
    gain.gain.value = 0.06;
    osc.connect(gain); gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + dur);
    osc.onended = () => { try{ ctx.close(); }catch(e){} };
  }catch(e){ /* 無音環境等は無視 */ }
}

/* ── VU メーター ── */
function _startVU(stream){
  try{
    _vuCtx = new (window.AudioContext || window.webkitAudioContext)();
    const src = _vuCtx.createMediaStreamSource(stream);
    _vuAnalyser = _vuCtx.createAnalyser();
    _vuAnalyser.fftSize = 512;
    src.connect(_vuAnalyser);
    const data = new Uint8Array(_vuAnalyser.frequencyBinCount);
    const draw = () => {
      _vuAnalyser.getByteTimeDomainData(data);
      let sum = 0;
      for(let i = 0; i < data.length; i++){ const v = (data[i] - 128) / 128; sum += v * v; }
      const rms = Math.sqrt(sum / data.length);
      const pct = Math.min(100, Math.round(rms * 180));
      const bar = document.getElementById('sh-vu-bar-' + _shadowRecPi);
      if(bar) bar.style.width = pct + '%';
      _vuRAF = requestAnimationFrame(draw);
    };
    draw();
  }catch(e){ /* VU失敗は録音に影響させない */ }
}
function _stopVU(){
  if(_vuRAF){ cancelAnimationFrame(_vuRAF); _vuRAF = null; }
  if(_vuCtx){ try{ _vuCtx.close(); }catch(e){} _vuCtx = null; _vuAnalyser = null; }
}

/* ── モデル（動画）のチャンク区間を再生し、終端で停止 ── */
function playModel(pi){
  if(pi < 0 || pi >= PARAS.length) return;
  _stopRecAudio();
  _clearModelStop();
  jumpTo(PARAS[pi].start);                 /* 既存：timeOffset補正・local/YT両対応 */
  const durMs = (PARAS[pi].end - PARAS[pi].start) * 1000 / (playSpeed || 1) + 80;
  _modelStopTimer = setTimeout(_pauseModel, durMs);
}
function _pauseModel(){
  _clearModelStop();
  const vid = document.getElementById('vid');
  const isLoc = document.getElementById('local-wrap').style.display !== 'none';
  if(isLoc && vid){ vid.pause(); }
  else if(ytPlayer && ytPlayer.pauseVideo){ ytPlayer.pauseVideo(); }
}
function _clearModelStop(){ if(_modelStopTimer){ clearTimeout(_modelStopTimer); _modelStopTimer = null; } }

/* ── 学習者の録音を再生（隠し <audio> 経由・ピッチ保持） ── */
function playRecording(pi){
  const rec = _recStore.get(pi);
  if(!rec){ showToast('まだ録音がありません', true, 2000); return; }
  _pauseModel();
  const a = document.getElementById('rec-audio');
  if(!a) return;
  a.src = rec.url;
  a.preservesPitch = true; a.mozPreservesPitch = true; a.webkitPreservesPitch = true;
  a.playbackRate = playSpeed || 1;
  try{ a.currentTime = 0; }catch(e){}
  a.play().catch(() => {});
}
function _stopRecAudio(){ const a = document.getElementById('rec-audio'); if(a) a.pause(); }

/* ── A/B：モデル↔自分 を押すたび交互に再生 ── */
function toggleAB(pi){
  if(!_recStore.has(pi)){ showToast('まだ録音がありません', true, 2000); return; }
  const next = _abNext.get(pi) || 'model';
  if(next === 'model'){ playModel(pi);    _abNext.set(pi, 'rec'); }
  else               { playRecording(pi); _abNext.set(pi, 'model'); }
}

/* ── チャンクヘッダの操作群を状態に合わせて更新 ── */
function refreshShadowControls(pi){
  const recBtn = document.querySelector('.sh-rec[data-pi="' + pi + '"]');
  if(recBtn) recBtn.classList.toggle('recording', _shadowRecPi === pi);
  const box = document.getElementById('sh-' + pi);
  if(!box) return;
  if(_shadowRecPi === pi){
    box.innerHTML = '<span class="sh-ind">● REC</span>'
                  + '<span class="sh-vu"><i id="sh-vu-bar-' + pi + '"></i></span>';
  }else if(_recStore.has(pi)){
    box.innerHTML =
      '<button type="button" class="sh-btn" title="モデルを再生" onclick="playModel(' + pi + ');event.stopPropagation()">▶モデル</button>'
    + '<button type="button" class="sh-btn" title="自分の声を再生" onclick="playRecording(' + pi + ');event.stopPropagation()">▶自分</button>'
    + '<button type="button" class="sh-btn" title="モデル↔自分を交互再生" onclick="toggleAB(' + pi + ');event.stopPropagation()">A·B</button>'
    + _statsBadge(pi);
  }else{
    box.innerHTML = _statsBadge(pi);
  }
}

/* 練習統計バッジ（試行回数・自己評価） */
function _statsBadge(pi){
  const st = _loadStats()[pi];
  if(!st || (!st.attempts && !st.rating)) return '';
  const stars = st.rating ? ' ' + '★'.repeat(st.rating) : '';
  const tries = st.attempts ? ' ×' + st.attempts : '';
  return '<span class="sh-badge" title="練習回数 / 自己評価">' + tries + stars + '</span>';
}
function refreshAllShadowControls(){
  if(typeof PARAS === 'undefined') return;
  PARAS.forEach(p => refreshShadowControls(p.id));
}

/* ══════════════════════════════════════════════════════════
   Step 2 — 練習ループ（聴く → 間 → 録音 → 比較）
   await ベースの状態機械。各ステップは _stepResolve に解決関数を持ち、
   stopPractice / skip 時に _cancelStep() で確実に解放する。
══════════════════════════════════════════════════════════ */
let _practiceOn = false, _practiceAbort = false, _practicePaused = false;
let _practicePi = -1, _practicePhase = '', _practiceLoop = 0;
let _stepResolve = null, _gapTimer = null;
let _prevChunkRepeat = null;

/* 設定（localStorage から初期化。0=∞） */
let practiceLoops, practiceListenReps, practiceGapMs, _practiceAutoAdvance;
(function _initPracticeSettings(){
  const s = (typeof loadSettings === 'function') ? loadSettings() : {};
  practiceLoops      = Number.isFinite(s.practiceLoops)      ? s.practiceLoops      : 2;
  practiceListenReps = Number.isFinite(s.practiceListenReps) ? s.practiceListenReps : 1;
  practiceGapMs      = Number.isFinite(s.practiceGapMs)      ? s.practiceGapMs      : 1200;
  _practiceAutoAdvance = !!s.practiceAutoAdvance;
})();

function setPracticeLoops(v){ practiceLoops = parseInt(v, 10) || 0; saveSettings({ practiceLoops }); }
function setPracticeListen(v){ practiceListenReps = Math.max(1, parseInt(v, 10) || 1); saveSettings({ practiceListenReps }); }
function setPracticeGap(v){ practiceGapMs = Math.max(0, parseInt(v, 10) || 0); saveSettings({ practiceGapMs }); }
function togglePracticeAuto(btn){
  _practiceAutoAdvance = !_practiceAutoAdvance;
  if(btn) btn.classList.toggle('on', _practiceAutoAdvance);
  saveSettings({ practiceAutoAdvance: _practiceAutoAdvance });
  showToast(_practiceAutoAdvance ? '連続練習: ON（チャンクを自動で進む）' : '連続練習: OFF', false, 1800);
}

/* 起動時に設定値をUIへ反映（11-init.js から呼ぶ） */
function initShadowUI(){
  const setV = (id, v) => { const el = document.getElementById(id); if(el) el.value = String(v); };
  setV('sh-loops', practiceLoops);
  setV('sh-listen', practiceListenReps);
  setV('sh-gap', practiceGapMs);
  const ab = document.getElementById('btn-sh-auto');
  if(ab) ab.classList.toggle('on', _practiceAutoAdvance);
}

function _micError(err){
  const msg = err && err.name === 'NotAllowedError' ? 'マイクの使用が許可されませんでした'
            : err && err.name === 'NotFoundError'   ? 'マイクが見つかりません'
            : 'マイクを利用できません';
  showToast(msg, true, 4000);
}

/* ── await ステップ群 ── */
function _finishStep(){ const r = _stepResolve; _stepResolve = null; if(r) r(); }

function _waitModel(pi){
  return new Promise(resolve => {
    _stepResolve = resolve;
    _stopRecAudio(); _clearModelStop();
    jumpTo(PARAS[pi].start);
    const durMs = (PARAS[pi].end - PARAS[pi].start) * 1000 / (playSpeed || 1) + 80;
    _modelStopTimer = setTimeout(() => { _pauseModel(); _finishStep(); }, durMs);
  });
}
function _waitRecPlay(pi){
  return new Promise(resolve => {
    _stepResolve = resolve;
    const rec = _recStore.get(pi);
    const a = document.getElementById('rec-audio');
    if(!rec || !a){ _finishStep(); return; }
    a.onended = () => { a.onended = null; _finishStep(); };
    playRecording(pi);
  });
}
function _waitGap(ms){
  return new Promise(resolve => {
    _stepResolve = resolve;
    _gapTimer = setTimeout(() => { _gapTimer = null; _finishStep(); }, ms);
  });
}
async function _waitRecord(pi){
  await _ensureMic();                       /* 失敗時は例外（呼び出し側で捕捉） */
  _shadowMime = _shadowMime || _pickMime();
  return new Promise(resolve => {
    _stepResolve = resolve;
    _beginRecording(pi, _shadowStream, () => _finishStep());
  });
}
/* 一時停止ゲート：再開 or 中止まで待つ */
async function _gate(){ while(_practicePaused && !_practiceAbort){ await sleep(150); } }

/* 進行中ステップを強制解放（停止／スキップ用） */
function _cancelStep(){
  if(_gapTimer){ clearTimeout(_gapTimer); _gapTimer = null; }
  _clearModelStop(); _pauseModel(); _stopRecAudio();
  const a = document.getElementById('rec-audio'); if(a) a.onended = null;
  if(_shadowRec && _shadowRec.state !== 'inactive'){ try{ _shadowRec.stop(); }catch(e){} }
  if(_shadowStopTimer){ clearTimeout(_shadowStopTimer); _shadowStopTimer = null; }
  _finishStep();
}

function _setPhase(pi, phase){ _practicePi = pi; _practicePhase = phase; _updatePracticeBar(); }

/* ── 1チャンクを practiceLoops 回まわす。完走 true / 中止 false ── */
async function _runChunk(pi){
  const loops = practiceLoops > 0 ? practiceLoops : Infinity;
  for(let loop = 0; loop < loops; loop++){
    _practiceLoop = loop;
    await _gate(); if(_practiceAbort) return false;
    _setPhase(pi, 'listen');
    for(let r = 0; r < Math.max(1, practiceListenReps); r++){
      if(_practiceAbort) return false;
      await _waitModel(pi);
    }
    await _gate(); if(_practiceAbort) return false;
    _setPhase(pi, 'gap');    await _waitGap(practiceGapMs);  if(_practiceAbort) return false;
    await _gate(); if(_practiceAbort) return false;
    _setPhase(pi, 'record');
    try{ await _waitRecord(pi); }
    catch(err){ _micError(err); _practiceAbort = true; return false; }
    if(_practiceAbort) return false;
    await _gate(); if(_practiceAbort) return false;
    _setPhase(pi, 'compare');
    await _waitRecPlay(pi); if(_practiceAbort) return false;
    await _waitModel(pi);   if(_practiceAbort) return false;
  }
  return true;
}

/* ── 練習開始（指定チャンクから。連続練習ONなら末尾まで自動で進む） ── */
async function startPractice(pi){
  if(pi < 0 || pi >= PARAS.length) return;
  if(_practiceOn){ stopPractice(); await sleep(100); }
  try{ await _ensureMic(); }catch(err){ _micError(err); return; }

  _practiceOn = true; _practiceAbort = false; _practicePaused = false;
  _prevChunkRepeat = { on: chunkRepeatOn, pi: chunkRepeatPi };
  chunkRepeatOn = false; updateChunkRepeatUI();   /* 練習中はチャンクリピートを無効化 */
  _showPracticeBar(true);

  let cur = pi;
  while(cur < PARAS.length && !_practiceAbort){
    const ok = await _runChunk(cur);
    if(!ok) break;                                 /* 中止 */
    _incAttempt(cur);
    if(_practiceAutoAdvance){
      _setPhase(cur, 'next');
      await sleep(700);
      cur++;
    }else{
      _setPhase(cur, 'rate');
      _promptRating(cur);
      break;
    }
  }
  _endPractice(_practiceAbort);
}

function stopPractice(){
  if(!_practiceOn) return;
  _practiceAbort = true; _practicePaused = false;
  _cancelStep();
}
function practiceTogglePause(){
  if(!_practiceOn) return;
  _practicePaused = !_practicePaused;
  if(_practicePaused){ _pauseModel(); _stopRecAudio(); }
  _updatePracticeBar();
}
function practiceSkip(){
  if(!_practiceOn) return;
  const nx = _practicePi + 1;
  stopPractice();
  setTimeout(() => { if(nx < PARAS.length) startPractice(nx); }, 150);
}

function _endPractice(aborted){
  _practiceOn = false; _practicePaused = false; _practiceAbort = false;
  if(_prevChunkRepeat){
    chunkRepeatOn = _prevChunkRepeat.on; chunkRepeatPi = _prevChunkRepeat.pi;
    updateChunkRepeatUI(); _prevChunkRepeat = null;
  }
  _pauseModel(); _stopRecAudio(); _stopVU();
  _shadowRecPi = -1;
  _showPracticeBar(false);
  refreshAllShadowControls();
}

/* ── 練習ステータスバー ── */
function _showPracticeBar(show){
  const b = document.getElementById('sh-practice-bar');
  if(b) b.style.display = show ? 'flex' : 'none';
  if(show) _updatePracticeBar();
}
function _updatePracticeBar(){
  const t = document.getElementById('sh-practice-phase');
  if(t){
    const names = { listen:'🔊 聴く', gap:'⏸ 間', record:'🎤 録音', compare:'🆎 比較', next:'⏭ 次へ', rate:'⭐ 評価' };
    const loopInfo = practiceLoops > 0 ? ` ループ${_practiceLoop + 1}/${practiceLoops}` : ` ループ${_practiceLoop + 1}`;
    t.textContent = `チャンク ${_practicePi + 1}：${names[_practicePhase] || ''}${loopInfo}`;
  }
  const pb = document.getElementById('sh-pause-btn'); if(pb) pb.textContent = _practicePaused ? '▶' : '⏸';
}

/* ── 練習統計（チャンク別・Tier 3 SRS の種） ── */
function _statsKey(){ return 'lilt.shadow.' + ((typeof currentBase !== 'undefined' && currentBase) || 'unknown'); }
function _loadStats(){ try{ return JSON.parse(localStorage.getItem(_statsKey())) || {}; }catch(e){ return {}; } }
function _saveStat(pi, patch){
  const s = _loadStats();
  s[pi] = { ...(s[pi] || {}), ...patch };
  try{ localStorage.setItem(_statsKey(), JSON.stringify(s)); }catch(e){}
}
function _incAttempt(pi){
  const cur = (_loadStats()[pi] || {}).attempts || 0;
  _saveStat(pi, { attempts: cur + 1, lastAt: Date.now() });
}
function rateChunk(pi, n){
  _saveStat(pi, { rating: n, lastAt: Date.now() });
  showToast('自己評価を記録: ' + '★'.repeat(n), false, 1500);
  refreshShadowControls(pi);
}
function _promptRating(pi){
  const box = document.getElementById('sh-' + pi);
  if(!box) return;
  box.innerHTML =
      '<span class="sh-ind" style="color:var(--accent)">自己評価</span>'
    + [1, 2, 3].map(n => '<button type="button" class="sh-btn" title="' + n + '段階" onclick="rateChunk(' + pi + ',' + n + ');event.stopPropagation()">' + '★'.repeat(n) + '</button>').join('')
    + '<button type="button" class="sh-btn" title="モデルを再生" onclick="playModel(' + pi + ');event.stopPropagation()">▶モデル</button>'
    + '<button type="button" class="sh-btn" title="自分の声を再生" onclick="playRecording(' + pi + ');event.stopPropagation()">▶自分</button>';
}
