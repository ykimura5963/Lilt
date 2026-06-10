/* ══ LOCAL FILE ══ */
document.getElementById('local-file').addEventListener('change',function(){
  const file=this.files[0]; if(!file) return;
  window._localVideoFile = file;  /* 保存時に使用 */

  const vid=document.getElementById('vid');
  vid.volume=0.6;
  vid.src=URL.createObjectURL(file);
  vid.load(); vid.controls=false;
  applyPlaybackSpeed();   /* 保存済み速度＋ピッチ保持を適用（loadで1.0にリセットされるため） */
  document.getElementById('no-file').style.display='none';
  document.getElementById('file-name').textContent=file.name;
  document.getElementById('header-sub').textContent=file.name;
  document.getElementById('local-wrap').style.display='';
  document.getElementById('yt-wrap').style.display='none';
  if(tickTimer){clearInterval(tickTimer);tickTimer=null;}
  ytPlayer=null;

  /* MD読込ボタンとアノテーションボタンを表示 */
  document.getElementById('md-label').style.display='inline-flex';
  document.getElementById('anno-bar-label').style.display='inline-flex';
});

document.getElementById('vid').addEventListener('timeupdate',function(){
  if(this.duration&&totalDur!==this.duration) totalDur=this.duration;
  syncHighlight(this.currentTime);
  checkChunkRepeat(this.currentTime);
});

/* ネイティブcontrolsを廃したため、動画クリックで再生/一時停止をトグル */
document.getElementById('vid').addEventListener('click',function(){
  if(!this.src||this.src===location.href) return;
  if(this.paused) this.play().catch(()=>{}); else this.pause();
});

/* ── data.md テキスト → Generate テキストエリア用文字列に変換 ── */
function parseMdToTranscript(text){
  const lines = text.split('\n');
  const out = [];
  for(const line of lines){
    /* ## [MM:SS]  English text */
    const m = line.match(/^##\s*\[(\d+):(\d+)\]\s+(.+)/);
    if(m){
      const totalSec = parseInt(m[1],10)*60 + parseInt(m[2],10);
      out.push(String(Math.floor(totalSec/60)) + ':' + String(totalSec%60).padStart(2,'0'));
      out.push(m[3].trim());
    }
    /* **JA:** は無視 */
  }
  return out.length ? out.join('\n') : null;
}

/* ── PARAS → data.md テキスト生成 ── */
function buildDataMdText(base, paras){
  const lines = ['# Annotation Script: ' + (base||'unknown') + '\n'];
  for(const p of paras){
    const mm = String(Math.floor(p.start/60)).padStart(2,'0');
    const ss = String(Math.floor(p.start%60)).padStart(2,'0');
    lines.push('## [' + mm + ':' + ss + ']  ' + (p.en||''));
    lines.push('**JA:** ' + (p.ja||'') + '\n');
  }
  return lines.join('\n');
}

/* ── MD ファイルを手動選択して Generate テキストエリアに展開 ── */
function onMdFileLoad(input){
  const file = input.files[0]; if(!file) return;
  const reader = new FileReader();
  reader.onload = function(e){
    const parsed = parseMdToTranscript(e.target.result);
    if(!parsed){ showToast('MDファイルの形式が読み取れませんでした', true, 4000); return; }
    const ta = document.getElementById('gen-transcript');
    if(ta){ ta.value = parsed; }
    else   { window._pendingMdTranscript = parsed; }
    const chunks = parsed.split('\n').filter(l=>l.match(/^\d+:\d+$/)).length;
    showToast(`✓ ${file.name} を読み込みました（${chunks}チャンク）\n「生成」タブで確認してください`, false, 5000);
  };
  reader.readAsText(file, 'utf-8');
}

/* ══ YOUTUBE ══ */
let ytAPILoaded=false;
function toggleYT(on){
  const lw=document.getElementById('local-wrap'),yw=document.getElementById('yt-wrap');
  if(on){
    lw.style.display='none';yw.style.display='';
    const iframe=document.getElementById('yt-player');
    if(iframe.src==='about:blank') iframe.src=iframe.dataset.src;
    if(!ytAPILoaded){ytAPILoaded=true;const s=document.createElement('script');s.src='https://www.youtube.com/iframe_api';document.head.appendChild(s);}
  } else {
    lw.style.display='';yw.style.display='none';
    if(tickTimer){clearInterval(tickTimer);tickTimer=null;}ytPlayer=null;
  }
}
function onYouTubeIframeAPIReady(){
  ytPlayer=new YT.Player('yt-player',{events:{
    onReady:startYTTick,
    onStateChange:e=>{if(e.data===YT.PlayerState.PLAYING)startYTTick();}
  }});
}
function startYTTick(){
  if(tickTimer)clearInterval(tickTimer);
  tickTimer=setInterval(()=>{
    if(!ytPlayer||typeof ytPlayer.getCurrentTime!=='function')return;
    const t=ytPlayer.getCurrentTime();
    if(typeof t==='number'){syncHighlight(t);checkChunkRepeat(t);}
  },80);
}

/* ══ SEEK / SPEED / LAYERS / CHUNK REPEAT ══ */
function annToVideo(annSec){ return annSec - timeOffset; }

function jumpTo(annSec){
  const vid=document.getElementById('vid');
  const t=Math.max(0, annToVideo(annSec));
  const isLoc=document.getElementById('local-wrap').style.display!=='none';
  if(isLoc&&vid.src&&vid.src!==location.href){vid.currentTime=t;vid.play().catch(()=>{});syncHighlight(t);}
  else if(ytPlayer&&ytPlayer.seekTo){ytPlayer.seekTo(t,true);ytPlayer.playVideo();syncHighlight(t);}
}

function updateChunkRepeatUI(){
  const btn=document.getElementById('btn-chunk-repeat');
  if(btn) btn.classList.toggle('on', chunkRepeatOn);
  document.querySelectorAll('.para-repeat').forEach(el=>{
    const pi=parseInt(el.dataset.pi,10);
    el.classList.toggle('on', chunkRepeatOn && chunkRepeatPi===pi);
  });
  document.querySelectorAll('.pcard-repeat').forEach(el=>{
    const pi=parseInt(el.dataset.pi,10);
    el.classList.toggle('on', chunkRepeatOn && chunkRepeatPi===pi);
  });
}

function setChunkRepeat(pi, e){
  if(e){ e.stopPropagation(); }
  if(pi<0||pi>=PARAS.length) return;
  chunkRepeatOn=true;
  chunkRepeatPi=pi;
  updateChunkRepeatUI();
  jumpTo(PARAS[pi].start);
  showToast(`段落 ${pi+1} をリピート再生`, false, 2000);
}

function toggleChunkRepeat(){
  chunkRepeatOn=!chunkRepeatOn;
  if(chunkRepeatOn){
    chunkRepeatPi=currentPara>=0 ? currentPara : 0;
    updateChunkRepeatUI();
    jumpTo(PARAS[chunkRepeatPi].start);
    showToast(`段落 ${chunkRepeatPi+1} をリピート再生`, false, 2000);
  } else {
    chunkRepeatPi=-1;
    updateChunkRepeatUI();
    showToast('チャンクリピート OFF', false, 1500);
  }
}

function checkChunkRepeat(rawSec){
  if(!chunkRepeatOn||chunkRepeatPi<0||chunkRepeatPi>=PARAS.length) return;
  const p=PARAS[chunkRepeatPi];
  const annSec=rawSec+timeOffset;
  if(annSec>=p.end-0.06) jumpTo(p.start);
}
function seekByClick(e){
  const bg=document.getElementById('prog-bg'),r=bg.getBoundingClientRect();
  jumpTo(Math.max(0,Math.min(totalDur,(e.clientX-r.left)/r.width*totalDur)));
}
function playVideo(){
  const isLoc=document.getElementById('local-wrap').style.display!=='none';
  if(isLoc){ const vid=document.getElementById('vid'); if(vid&&vid.src&&vid.src!==location.href) vid.play().catch(()=>{}); }
  else if(ytPlayer&&ytPlayer.playVideo){ ytPlayer.playVideo(); }
}
function pauseVideo(){
  const isLoc=document.getElementById('local-wrap').style.display!=='none';
  if(isLoc){ const vid=document.getElementById('vid'); if(vid) vid.pause(); }
  else if(ytPlayer&&ytPlayer.pauseVideo){ ytPlayer.pauseVideo(); }
}
function applyPlaybackSpeed(){
  const vid=document.getElementById('vid');
  if(vid){
    /* ピッチ保持: スロー/早送りでも声の高さを変えない（シャドーイング用） */
    vid.preservesPitch = true;
    vid.mozPreservesPitch = true;
    vid.webkitPreservesPitch = true;
    vid.playbackRate=playSpeed;
  }
  if(ytPlayer&&ytPlayer.setPlaybackRate)ytPlayer.setPlaybackRate(playSpeed);
}
function setSpeed(v){
  playSpeed=parseFloat(v);
  applyPlaybackSpeed();
  saveSettings({playSpeed});
}
function toggleLayer(layer,btn){
  if(layer==='stress')showStress=!showStress;
  if(layer==='inton')showInton=!showInton;
  if(layer==='elision')showElision=!showElision;
  btn.classList.toggle('on',layer==='stress'?showStress:layer==='inton'?showInton:showElision);
  saveSettings({showStress, showInton, showElision});
  renderTranscript();
}
function toggleRhythmSync(btn){
  rhythmSync=!rhythmSync;
  btn.classList.toggle('on',rhythmSync);
  saveSettings({rhythmSync});
  buildIndex();                    /* 語タイミングを再計算 */
  prevLitKey=null; currentPara=-1; /* ハイライト状態をリセット */
  const v=document.getElementById('vid');
  if(v) syncHighlight(v.currentTime||0);
  showToast(rhythmSync?'♪ リズム同期: ON（話速モデルで配分）':'リズム同期: OFF（均等割り）',false,2500);
}

