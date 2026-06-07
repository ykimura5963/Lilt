/* ══ WORD INDEX ══ */
let WIDX=[];
function buildIndex(){
  WIDX=[];
  PARAS.forEach((p,pi)=>{
    /* ON: テンポモデルで再配分（旧ファイルでも常に最新で計算）
       OFF: 保存済みの均等割り wsUniform を使用（無ければ ws にフォールバック）*/
    const starts = rhythmSync
      ? tempoWordStarts(p.words, p.start, p.end)
      : p.words.map(w=> (typeof w.wsUniform==='number' ? w.wsUniform : w.ws));
    p.words.forEach((w,wi)=>{
      const ws = starts[wi];
      const we = wi+1<p.words.length ? starts[wi+1] : p.end;
      WIDX.push({pi,wi,ws,we});
    });
  });
}
function findWord(sec){
  for(let i=WIDX.length-1;i>=0;i--){
    const e=WIDX[i];
    if(sec>=e.ws && sec<e.we) return e;
  }
  return null;
}

/* ══ SVG ══ */
function iSvg(type){
  const w=32,h=16,col=type==='rise'?'var(--rise)':type==='fall'?'var(--fall)':'var(--rf)';
  const d=type==='rise'?`M2 13 Q${w/2} 3 ${w-2} 7`:type==='fall'?`M2 5 Q${w/2} 11 ${w-2} 13`:`M2 13 Q${w*.35} 2 ${w/2} 7 Q${w*.65} 12 ${w-2} 5`;
  return `<svg class="inton-svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><path d="${d}" fill="none" stroke="${col}" stroke-width="1.5" stroke-linecap="round"/></svg>`;
}

/* ══ ELEMENT CACHE（同期ホットパスのDOMルックアップを排除） ══ */
let EL = { paraEls:[], jaEls:[], wordEls:[] };
function cacheElements(){
  EL.paraEls = PARAS.map(p=>document.getElementById(`para-${p.id}`));
  EL.jaEls   = PARAS.map(p=>document.getElementById(`ja-${p.id}`));
  EL.wordEls = PARAS.map(p=>p.words.map((_,wi)=>document.getElementById(`w-${p.id}-${wi}`)));
}
function wordEl(pi,wi){ const row=EL.wordEls[pi]; return row ? (row[wi]||null) : null; }

/* ══ 文字サイズ ══ */
function applyFontScale(){
  const panel=document.getElementById('transcript');
  if(panel) panel.style.zoom = fontScale;
}

/* ══ RENDER ══ */
function renderTranscript(){
  const panel=document.getElementById('transcript');
  let html='';
  PARAS.forEach(p=>{
    const mm=String(Math.floor(p.start/60)).padStart(2,'0');
    const ss=String(Math.floor(p.start%60)).padStart(2,'0');
    html+=`<div class="para" id="para-${p.id}" onclick="jumpTo(${p.start})">`;
    html+=`<div class="para-head">`;
    html+=`<div class="para-time">${mm}:${ss}</div>`;
    html+=`<button type="button" class="para-repeat${chunkRepeatOn&&chunkRepeatPi===p.id?' on':''}" data-pi="${p.id}" onclick="setChunkRepeat(${p.id},event)" title="この段落をリピート再生">🔁</button>`;
    html+=`<button type="button" class="sh-rec" data-pi="${p.id}" onclick="shadowRecordToggle(${p.id},event)" title="このチャンクを録音（クリックで開始/停止）">🎤</button>`;
    html+=`<span class="sh-controls" id="sh-${p.id}"></span>`;
    html+=`</div>`;
    html+=`<div class="sentence" id="sent-${p.id}">`;
    p.words.forEach((w,wi)=>{
      const display=w.syl||w.t;
      const isE=w.elision, isS=w.stress==='s', isW=w.stress==='w';
      let sym='';
      if(isE&&showElision) sym=`<span class="stress-sym x" title="${w.note||''}">×</span>`;
      else if(isS&&showStress) sym=`<span class="stress-sym s">●</span>`;
      else if(isW&&showStress) sym=`<span class="stress-sym w">◯</span>`;
      const sv=(!!w.inton&&showInton)?iSvg(w.inton):'';
      const anno=`<div class="anno">${sv}${sym}</div>`;
      let cls='wt';
      if(isS) cls+=' stressed'; else if(isW) cls+=' reduced';
      if(isE) cls+=' elided';
      const tip=w.note?` title="${w.note}"`:'';
      html+=`<span class="w" id="w-${p.id}-${wi}">${anno}<span class="wt-slot"><span class="${cls}"${tip}>${display}</span></span></span>`;
    });
    html+=`</div><div class="ja-line" id="ja-${p.id}">${p.ja}</div></div>`;
  });
  panel.innerHTML=html;
  buildIndex();
  cacheElements();
  applyFontScale();
  prevLitKey=null; currentPara=-1;

  /* シャドーイング操作群（録音済みなら ▶/A·B を復元） */
  if(typeof refreshAllShadowControls==='function') refreshAllShadowControls();

  /* スマホ用フレーズ更新 */
  updateMobilePhrases();
}

/* ══ SYNC ══ */
function syncHighlight(rawSec){
  const sec=rawSec+timeOffset;

  /* progress & time */
  const fill=document.getElementById('prog-fill');
  if(fill) fill.style.width=Math.min(100,(rawSec/totalDur)*100).toFixed(1)+'%';
  const td=document.getElementById('time-disp');
  if(td){const m=Math.floor(rawSec/60),s=Math.floor(rawSec%60);td.textContent=`${m}:${String(s).padStart(2,'0')}`;}

  /* active paragraph */
  let ap=-1;
  for(let i=PARAS.length-1;i>=0;i--){if(sec>=PARAS[i].start){ap=i;break;}}

  if(ap!==currentPara){
    currentPara=ap;
    EL.paraEls.forEach((el,i)=>{ if(el) el.classList.toggle('active',i===ap); });
    EL.jaEls.forEach((el,i)=>{ if(el) el.classList.toggle('on',i===ap); });
    document.querySelectorAll('.pcard').forEach((el,i)=>el.classList.toggle('on',i===ap));
    if(autoFollow && EL.paraEls[ap]) EL.paraEls[ap].scrollIntoView({behavior:'smooth',block:'center'});
    EL.wordEls.forEach((row,pi)=>{
      row.forEach(el=>{
        if(!el) return;
        if(pi<ap){el.classList.add('passed');el.classList.remove('lit');}
        else if(pi>ap) el.classList.remove('lit','passed');
      });
    });
    prevLitKey=null;
  }

  /* word highlight */
  const aw=findWord(sec);
  const key=aw?`${aw.pi}-${aw.wi}`:null;
  if(key===prevLitKey) return;
  if(prevLitKey){
    const [ppi,pwi]=prevLitKey.split('-').map(Number);
    const el=wordEl(ppi,pwi);
    if(el){el.classList.remove('lit');el.classList.add('passed');}
  }
  if(aw){
    const el=wordEl(aw.pi,aw.wi);
    if(el){el.classList.add('lit');el.classList.remove('passed');}
    if(aw.pi===currentPara){
      const row=EL.wordEls[aw.pi]||[];
      for(let wi=0;wi<aw.wi;wi++){
        const pel=row[wi];
        if(pel&&!pel.classList.contains('passed')){pel.classList.add('passed');pel.classList.remove('lit');}
      }
    }
  }
  prevLitKey=key;
}

/* ══ OFFSET ══ */
function updateOffset(v){
  timeOffset=parseFloat(v);
  document.getElementById('offset-val').textContent=(timeOffset>=0?'+':'')+timeOffset.toFixed(1)+' s';
  saveSettings({timeOffset});
}
function resetOffset(){
  timeOffset=0;
  document.getElementById('offset-slider').value=0;
  document.getElementById('offset-val').textContent='0.0 s';
  saveSettings({timeOffset:0});
}

/* ══ 追従 / 文字サイズ トグル ══ */
function toggleAutoFollow(btn){
  autoFollow=!autoFollow;
  if(btn) btn.classList.toggle('on',autoFollow);
  saveSettings({autoFollow});
  showToast(autoFollow?'📌 追従 ON':'追従 OFF（手動スクロール優先）',false,1800);
}
function adjustFontScale(dir){
  fontScale = Math.min(1.6, Math.max(0.8, +(fontScale + dir*0.1).toFixed(2)));
  applyFontScale();
  saveSettings({fontScale});
  showToast(`文字サイズ ${Math.round(fontScale*100)}%`, false, 1500);
}

