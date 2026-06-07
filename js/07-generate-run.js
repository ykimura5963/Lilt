/* ── 生成実行 ── */
async function runGeneration(){
  /* LLM接続先は「設定」タブの「LLM 接続先（翻訳・発音アノテーション 共通）」を使用 */
  let prov = resolveTranslateProvider();
  if(prov.provider !== 'ollama' && !prov.apiKey){
    showToast(`${prov.provider} のAPIキーを「設定」タブで入力してください`, true); return;
  }

  const rawText = prepTranscriptForAnnotation(document.getElementById('gen-transcript')?.value?.trim());
  if(!rawText){ showToast('文字起こしテキストを入力してください',true); return; }

  const speed = document.getElementById('gen-speed')?.value || 'fast';

  genAbort = false;
  document.getElementById('gen-modal').style.display='flex';
  document.getElementById('modal-para-list').innerHTML='';
  setModalStatus('段落を解析中...',0);

  /* 段落分割: 空行区切り or 改行区切りで最大200文字ずつ */
  const paras = parseTranscriptToParagraphs(rawText);
  setModalStatus(`${paras.length}段落を検出しました。生成開始...`,5);

  const results = [];
  let backendErrorShown = false;
  for(let i=0;i<paras.length;i++){
    if(genAbort){ setModalStatus('キャンセルしました',0); break; }
    const pct = 5 + Math.round((i/paras.length)*90);
    setModalStatus(`段落 ${i+1}/${paras.length} を処理中... (${prov.provider})`, pct);
    addModalParaItem(i, paras[i].en, 'processing');

    try{
      const annotated = await annotateOneParagraph(prov, paras[i], i, speed, paras.length);
      results.push(annotated);
      addModalParaItem(i, paras[i].en, 'done');
    } catch(err){
      const msg = err.name==='AbortError'
        ? `タイムアウト(240秒超過)` : err.message;
      const useFallback = err.name==='AbortError' ||
        (typeof err.message==='string' && err.message.startsWith('JSON parse error'));
      if(useFallback){
        results.push(makeFallbackPara(paras[i], i, speed));
        addModalParaItem(i, paras[i].en, 'done');
        setModalStatus(`段落${i+1}: 推定データで続行 — ${msg}`, pct, false);
      } else {
        /* バックエンド接続エラー — 初回のみフォールバックダイアログ表示 */
        if(!backendErrorShown && prov.provider !== 'ollama'){
          backendErrorShown = true;
          document.getElementById('gen-modal').style.display='none';
          const go = confirm(
            `【${prov.provider}】でエラーが発生しました。\n\n` +
            `Ollama（ローカル）で残り ${paras.length - i} 段落を続行しますか？\n` +
            `　OK     → Ollamaで続行\n` +
            `　キャンセル → 生成を中止\n\n` +
            `エラー: ${msg}`
          );
          document.getElementById('gen-modal').style.display='flex';
          if(go){
            prov = ollamaFallbackProvider();
          } else {
            genAbort = true;
          }
        }
        if(!genAbort){
          addModalParaItem(i, paras[i].en, 'error');
          setModalStatus(`エラー (段落${i+1}): ${msg}`, pct, true);
        }
        await sleep(500);
      }
    }
  }

  if(!genAbort && results.length>0){
    setModalStatus('完了！保存中...',98);
    /* PARAS を置き換えて即座に反映 */
    window.PARAS.length=0;
    results.forEach((p,i)=>{
      p.id=i;
      const end = p.end ?? (p.start + 5);
      p.words=assignWordTimings(enrichPronunciationWords(p.words||[], p.en), p.start, end);
      window.PARAS.push(p);
    });
    totalDur = results[results.length-1].end || totalDur;
    renderTranscript();

    const json = buildAnnotationJSON(results);
    await saveAnnotationJSON(json);
    setModalStatus(`✓ ${results.length}段落のアノテーションを生成・保存しました`,100);
    setTimeout(()=>{ document.getElementById('gen-modal').style.display='none'; },2000);
  }
}

/* ── アノテーションのみ再生成（既存チャンクの英文・和訳・時刻を保持） ── */
async function regenerateAnnotationsOnly(){
  if(!window.PARAS || !PARAS.length){
    showToast('再生成するチャンクがありません。\n先にプロジェクトを読み込むか自動処理を実行してください', true, 4500);
    return;
  }
  let prov = resolveTranslateProvider();
  if(prov.provider !== 'ollama' && !prov.apiKey){
    showToast(`${prov.provider} のAPIキーを「設定」タブで入力してください`, true); return;
  }
  const speed = document.getElementById('gen-speed')?.value || 'normal';

  /* 既存チャンクをスナップショット（英文・和訳・開始終了秒を保持） */
  const src = PARAS.map(p=>({en:p.en, ja:p.ja, start:p.start, end:p.end}));

  genAbort = false;
  document.getElementById('gen-modal').style.display='flex';
  document.getElementById('modal-para-list').innerHTML='';
  setModalStatus(`既存の${src.length}チャンクの発音アノテーションを再生成します...`, 5);

  const results = [];
  let backendErrorShown2 = false;
  for(let i=0;i<src.length;i++){
    if(genAbort){ setModalStatus('キャンセルしました',0); break; }
    const pct = 5 + Math.round((i/src.length)*90);
    setModalStatus(`チャンク ${i+1}/${src.length} を再生成中... (${prov.provider})`, pct);
    addModalParaItem(i, src[i].en, 'processing');
    try{
      const annotated = await annotateOneParagraph(prov, src[i], i, speed, src.length);
      /* 元の和訳・時刻を確実に保持（LLMが書き換えても上書き戻す） */
      annotated.ja    = src[i].ja;
      annotated.start = src[i].start;
      annotated.end   = src[i].end;
      results.push(annotated);
      addModalParaItem(i, src[i].en, 'done');
    } catch(err){
      const msg = err.name==='AbortError' ? 'タイムアウト(240秒超過)' : err.message;
      const isRetriable = err.name==='AbortError' ||
        (typeof err.message==='string' && err.message.startsWith('JSON parse error'));
      if(!isRetriable && !backendErrorShown2 && prov.provider !== 'ollama'){
        backendErrorShown2 = true;
        document.getElementById('gen-modal').style.display='none';
        const go = confirm(
          `【${prov.provider}】でエラーが発生しました。\n\n` +
          `Ollama（ローカル）で残り ${src.length - i} チャンクを続行しますか？\n` +
          `　OK     → Ollamaで続行\n` +
          `　キャンセル → 生成を中止\n\n` +
          `エラー: ${msg}`
        );
        document.getElementById('gen-modal').style.display='flex';
        if(go){ prov = ollamaFallbackProvider(); } else { genAbort = true; }
      }
      if(genAbort) break;
      const fb = makeFallbackPara(src[i], i, speed);
      fb.ja = src[i].ja;
      results.push(fb);
      addModalParaItem(i, src[i].en, isRetriable ? 'done' : 'error');
      setModalStatus(`チャンク${i+1}: 推定データで続行 — ${msg}`, pct, false);
      await sleep(400);
    }
  }

  if(!genAbort && results.length>0){
    setModalStatus('完了！保存中...',98);
    window.PARAS.length=0;
    results.forEach((p,i)=>{
      p.id=i;
      const end = p.end ?? (p.start + 5);
      p.words = assignWordTimings(enrichPronunciationWords(p.words||[], p.en), p.start, end);
      window.PARAS.push(p);
    });
    totalDur = results[results.length-1].end || totalDur;
    renderTranscript();

    const json = buildAnnotationJSON(results);
    await saveAnnotationJSON(json);
    setModalStatus(`✓ ${results.length}チャンクの発音アノテーションを再生成しました`,100);
    setTimeout(()=>{ document.getElementById('gen-modal').style.display='none'; },2000);
  }
}

/* ── タイムアウト時フォールバック（均等分割の推定データ） ── */
function makeFallbackPara(para, idx, speed){
  const estDurPerWord = {slow:0.55,normal:0.42,fast:0.32,veryfast:0.25}[speed]||0.35;
  const tokens = para.en.split(/\s+/).filter(Boolean);
  const estStart = para.start || 0;
  const estEnd = para.end ?? (estStart + tokens.length * estDurPerWord);
  const words = assignWordTimings(
    enrichPronunciationWords(tokens.map(t=>({t, ws:null, stress:null, inton:null, elision:false})), para.en),
    estStart, estEnd
  );
  return { id: idx, start: estStart, end: estEnd, en: para.en, ja: para.ja, words };
}

const FN_WORD_RE = /^(a|an|the|of|to|in|on|at|by|for|and|or|but|is|was|are|were|be|been|it|its|i|you|he|she|we|they|my|your|you're|they're|we're|he's|she's|it's|that|this|with|as|up|so|if|from|have|has|had|can|will|would|could|should|am|do|does|did|not|than|then|them|us|our|her|his|its|what|when|where|who|how|some|any|all|just|also|very|really|about|into|onto|over|under|out|off|no|yes|or|nor)$/i;

const ELISION_NOTES = {
  your:"jʊr→jər", "you're":"jʊr→jər", to:"tʊ→tə", of:"ɒv→əv", and:"ænd→ən",
  if:"ɪf→əf", for:"fɔːr→fər", the:"ði→ðə", a:"ə", an:"ən", into:"ˈɪntʊ→ˈɪnə",
  at:"æt→ət", that:"ðæt→ðət", can:"kæn→kən", have:"hæv→həv", has:"hæz→həz",
  had:"hæd→həd", was:"wɒz→wəz", were:"wɜː→wər", will:"wɪl→əl", would:"wʊd→əd",
  from:"frəm", than:"ðæn→ðən", them:"ðəm", him:"ɪm", her:"hər",
  probably:"ˈprɒbəbli→ˈprɒbli", because:"bɪˈkəz", about:"əˈbaʊt", today:"təˈdeɪ"
};

function normBare(token){ return (token||'').replace(/[^a-zA-Z'-]/g,'').toLowerCase(); }
function normInton(v){
  if(v==null||v===''||v==='null'||v==='none') return null;
  const s=String(v).toLowerCase().replace(/[^a-z]/g,'');
  if(s==='rise'||s==='fall'||s==='risefall') return s;
  return null;
}
function isFnWord(bare){ return FN_WORD_RE.test(bare); }

function detectElision(bare, raw, tokens, wi){
  if(ELISION_NOTES[bare]) return {elision:true, note:ELISION_NOTES[bare]};
  if(/n't$/i.test(raw)) return {elision:true, note:'t-drop / reduction'};
  if(bare==='going'&&normBare(tokens[wi+1])==='to') return {elision:true, note:'going to→ˈɡʊnə'};
  if(bare==='want'&&normBare(tokens[wi+1])==='to') return {elision:true, note:'want to→wanna'};
  if(bare==='got'&&normBare(tokens[wi+1])==='to') return {elision:true, note:'got to→ˈɡɑːtə'};
  if(bare==='kind'&&normBare(tokens[wi+1])==='of') return {elision:true, note:'kind of→ˈkaɪndə'};
  return {elision:false, note:''};
}

function inferInton(wi, n, raw, bare, stress, tokens){
  const isLast = wi === n - 1;
  const hasComma = /,$/.test(raw);
  const nextBare = wi < n - 1 ? normBare(tokens[wi+1]) : '';
  if(/[!?]$/.test(raw)) return /\?$/.test(raw) && isFnWord(bare) ? 'rise' : 'fall';
  if(hasComma) return 'fall';
  if(isLast) return 'fall';
  if(/can't|won't|shouldn't|don't|didn't|isn't|aren't|wasn't|weren't|couldn't|wouldn't|haven't|hasn't/i.test(raw)) return 'rise';
  if(stress==='s' && (nextBare==='and'||nextBare==='or'||nextBare==='but')) return 'rise';
  if(stress==='s' && wi < n - 2 && /,$/.test(tokens[wi+1]||'')) return 'rise';
  return null;
}

function enrichPronunciationWords(words, enText){
  const tokens = enText.split(/\s+/).filter(Boolean);
  return tokens.map((token, wi)=>{
    const w = words[wi] || {};
    const raw = token.trim();
    const bare = normBare(raw);
    const el = detectElision(bare, raw, tokens, wi);
    let stress = (w.stress==='s'||w.stress==='w') ? w.stress : (isFnWord(bare) ? 'w' : 's');
    let inton = normInton(w.inton);
    if(!inton) inton = inferInton(wi, tokens.length, raw, bare, stress, tokens);
    let elision = !!w.elision || el.elision;
    let note = w.note || (el.elision && el.note ? el.note : '');
    const out = {t:raw, ws:w.ws, stress, inton, elision};
    if(w.syl) out.syl = w.syl;
    if(note) out.note = note;
    if(typeof w.wsUniform==='number') out.wsUniform = w.wsUniform;  /* 焼き込み均等割りを保持 */
    return out;
  });
}

function assignWordTimings(words, start, end){
  const n = words.length;
  if(!n) return words;
  const span = Math.max(0.2, end - start);
  const step = span / n;
  return words.map((w, wi)=>{
    let ws = w.ws;
    if(typeof ws!=='number' || ws < start || ws >= end){
      ws = start + wi * step;
    }
    return {...w, ws: parseFloat(ws.toFixed(2))};
  });
}

