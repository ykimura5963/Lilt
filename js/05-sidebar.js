/* ══ SIDEBAR ══ */
function legendHTML(){return `
<div class="lcard">
  <div class="ltitle">強弱マーク</div>
  <div class="lrow"><span class="lsym" style="color:var(--accent)">●</span>強（Primary stress）</div>
  <div class="lrow"><span class="lsym" style="color:var(--bd2)">◯</span>弱（Unstressed）</div>
</div>
<div class="lcard">
  <div class="ltitle">イントネーション</div>
  <div class="lrow">${iSvg('rise')}<span>上昇調 rise</span></div>
  <div class="lrow">${iSvg('fall')}<span>下降調 fall</span></div>
  <div class="lrow">${iSvg('risefall')}<span>上昇下降 rise-fall</span></div>
</div>
<div class="lcard">
  <div class="ltitle">消える音</div>
  <div class="lrow"><span class="lsym" style="color:var(--danger)">×</span>脱落・弱化</div>
  <div class="lrow" style="font-size:11px;color:var(--muted)">点線下線 = 脱落語<br>ホバーで発音注記</div>
</div>
<div class="lcard">
  <div class="ltitle">同期オフセット</div>
  <div class="lrow" style="font-size:11px;color:var(--muted);display:block;line-height:1.8">音声が速い → マイナス<br>音声が遅い → プラス</div>
</div>`;}

function phrasesHTML(){return PARAS.map(p=>{
  const mm=String(Math.floor(p.start/60)).padStart(2,'0'),ss=String(Math.floor(p.start%60)).padStart(2,'0');
  const repOn=chunkRepeatOn&&chunkRepeatPi===p.id?' on':'';
  return `<div class="pcard" id="pc-${p.id}" onclick="jumpTo(${p.start})"><div class="pcard-actions"><div class="pt">${mm}:${ss}</div><button type="button" class="pcard-repeat${repOn}" data-pi="${p.id}" onclick="setChunkRepeat(${p.id},event)" title="リピート再生">🔁</button></div><div class="pen">${p.en}</div><div class="pja">${p.ja}</div></div>`;
}).join('');}

function switchTab(tab,el){
  document.querySelectorAll('.stab').forEach(t=>t.classList.remove('on'));
  el.classList.add('on');
  const b=document.getElementById('sbody');
  if(tab==='legend')  b.innerHTML=legendHTML();
  if(tab==='phrases'){
    b.innerHTML=phrasesHTML();
    updateChunkRepeatUI();
  }
  if(tab==='generate'){
    b.innerHTML=generateHTML();
    /* MD読込で一時保存していたテキストを反映 */
    if(window._pendingMdTranscript){
      const ta=document.getElementById('gen-transcript');
      if(ta){ ta.value=window._pendingMdTranscript; window._pendingMdTranscript=null; }
    }
    loadYouTubeProjects();
    checkBackendHealth();
  }
  if(tab==='settings'){
    b.innerHTML=settingsHTML();
    /* 復元した設定をUIへ反映 */
    onBackendChange(genBackend);
    const gb=document.getElementById('gen-backend'); if(gb) gb.value=genBackend;
    const ki=document.getElementById('gen-apikey'); if(ki) ki.value=genApiKey;
    refreshFolderStatus();
    checkBackendHealth();
  }
}

/* ══ MOBILE PANEL ══ */
function toggleMobilePanel(){
  const inner=document.getElementById('mp-inner');
  const tog=document.getElementById('mp-toggle');
  const isOpen=inner.style.display!=='none';
  inner.style.display=isOpen?'none':'block';
  tog.classList.toggle('open',!isOpen);
  if(!isOpen){
    document.getElementById('mp-content').innerHTML=legendHTML();
  }
}

function updateMobilePhrases(){
  const mp=document.getElementById('mobile-phrases');
  if(!mp) return;
  const isMobile=window.matchMedia('(max-width:640px)').matches;
  if(isMobile){
    mp.style.display='block';
    mp.innerHTML=`<div class="mp-phrase-title">フレーズ一覧</div>`+phrasesHTML();
  } else {
    mp.style.display='none';
  }
}

/* スマホ用モバイルパネルは640px以下のみ表示 */
function applyResponsive(){
  const isMobile=window.matchMedia('(max-width:640px)').matches;
  document.getElementById('mobile-panel').style.display=isMobile?'block':'none';
  updateMobilePhrases();
}

/* ══ TOAST ══ */
let toastTimer=null;
function showToast(msg,isErr=false,dur=3500){
  const t=document.getElementById('toast');
  t.textContent=msg;t.className='show'+(isErr?' err':'');
  if(toastTimer)clearTimeout(toastTimer);
  toastTimer=setTimeout(()=>{t.className='';},dur);
}


