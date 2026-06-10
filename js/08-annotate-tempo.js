/* ══════════════════════════════════════════════════════════
   リズム同期エンジン（テンポモデルによる語タイミング配分）
   ステップ①: 標準的な話速（リズム）を定義
   ステップ②: 連続タイムスタンプ間の長さ（チャンク区間）を取得
   ステップ③: テンポ×区間で各語に長さを割り当て
   ステップ④: その配分で同期表示（buildIndexが使用）
══════════════════════════════════════════════════════════ */

/* ステップ① 標準的な話速（リズム）の定義 ── 1音節あたりの基準秒と重み係数 */
const SPEECH_TEMPO = {
  basePerWord:  0.08,   /* 語ごとの立ち上がり・遷移コスト(秒) */
  perSyllable:  0.17,   /* 1音節あたりの基準長(秒) */
  stressMult:   1.35,   /* 強勢（内容語）は伸びる */
  reducedMult:  0.70,   /* 弱化（機能語）は縮む */
  elisionMult:  0.55,   /* 消音・連結はさらに短い */
  commaPause:   0.16,   /* カンマ後の間 */
  periodPause:  0.28    /* 文末(.!?)後の間 */
};

/* 簡易英語音節カウンタ（母音グループ数ベース） */
function countSyllables(word){
  const w = (word||'').toLowerCase().replace(/[^a-z]/g,'');
  if(!w) return 1;
  if(w.length <= 3) return 1;
  let s = w.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/,'').replace(/^y/,'');
  const m = s.match(/[aeiouy]{1,2}/g);
  return m ? Math.max(1, m.length) : 1;
}

/* 1語の推定発話長（重み）を算出 ── テンポモデルの中核 */
function wordWeight(w){
  /* 音節数: syl（中点/ピリオド区切り）があれば優先、なければ推定 */
  const syl = w.syl
    ? Math.max(1, w.syl.split(/[·.・]/).filter(Boolean).length)
    : countSyllables(w.t);
  let mult = 1;
  if(w.elision)            mult = SPEECH_TEMPO.elisionMult;
  else if(w.stress==='w')  mult = SPEECH_TEMPO.reducedMult;
  else if(w.stress==='s')  mult = SPEECH_TEMPO.stressMult;
  let weight = SPEECH_TEMPO.basePerWord + syl * SPEECH_TEMPO.perSyllable * mult;
  const raw = w.t || '';
  if(/[,;:]$/.test(raw))       weight += SPEECH_TEMPO.commaPause;
  else if(/[.!?]+$/.test(raw)) weight += SPEECH_TEMPO.periodPause;
  return weight;
}

/* ステップ②③: チャンク区間[start,end]を語の重み比で配分し、各語の開始秒配列を返す */
function tempoWordStarts(words, start, end){
  const n = words.length;
  if(!n) return [];
  const span = Math.max(0.3, (end ?? start) - start);
  const weights = words.map(wordWeight);
  const total = weights.reduce((a,b)=>a+b, 0) || n;
  const starts = new Array(n);
  let t = start;
  for(let i=0;i<n;i++){
    starts[i] = parseFloat(t.toFixed(3));
    t += span * (weights[i] / total);
  }
  return starts;
}

/* 均等割りの開始秒配列（リズムOFF / 比較用） */
function uniformWordStarts(words, start, end){
  const n = words.length;
  if(!n) return [];
  const span = Math.max(0.2, (end ?? start) - start);
  const step = span / n;
  return Array.from({length:n}, (_,i)=>parseFloat((start + i*step).toFixed(3)));
}

/* 保存用: 各語に ws=テンポ配分（オフライン互換）と wsUniform=均等割り を焼き込む */
function bakeTempoTimings(paras){
  return paras.map(p=>{
    const tempo   = tempoWordStarts(p.words, p.start, p.end);
    const uniform = uniformWordStarts(p.words, p.start, p.end);
    return {
      ...p,
      words: p.words.map((w,wi)=>({
        ...w,
        ws:        tempo[wi],
        wsUniform: uniform[wi]
      }))
    };
  });
}

function buildWordsFromParsed(parsedWords, para, estDurPerWord){
  const tokens = para.en.split(/\s+/).filter(Boolean);
  const estStart = para.start || 0;
  const estEnd = para.end ?? (estStart + tokens.length * estDurPerWord);
  const base = tokens.map((token, wi)=>{
    const pw = parsedWords[wi] || {};
    return {
      t: token,
      ws: typeof pw.ws==='number' ? pw.ws : null,
      wsUniform: typeof pw.wsUniform==='number' ? pw.wsUniform : undefined,
      stress: pw.stress, inton: pw.inton, elision: pw.elision,
      syl: pw.syl, note: pw.note
    };
  });
  return assignWordTimings(enrichPronunciationWords(base, para.en), estStart, estEnd);
}

/* ── LLM応答からJSON文字列を抽出 ── */
function extractJsonFromLlm(raw){
  let s = (raw||'').replace(/[\s\S]*?<\/think>/gi,'').trim();
  s = s.replace(/```json\s*|```/g,'').trim();
  const m = s.match(/\{[\s\S]*\}/);
  return m ? m[0] : s;
}

/* RunPodエンドポイントURLから https://api.runpod.ai/v2/{id} を抽出（/run・/runsync・/openai/v1/... いずれも可） */
function runpodEndpointBase(url){
  const m = (url || '').trim().match(/(https?:\/\/[^\/\s]+\/v2\/[^\/\s]+)/);
  if(!m) throw new Error('RunPod URLからエンドポイントを特定できません: '+url);
  return m[1];
}

/* ── OpenAI互換プロバイダ(OpenRouter/OpenAI)のURLを解決 ── */
function resolveOpenAiCompatUrl(prov){
  if(prov.provider === 'openrouter') return (prov.endpoint||'').trim() || 'https://openrouter.ai/api/v1/chat/completions';
  return (prov.endpoint||'').trim() || 'https://api.openai.com/v1/chat/completions';
}

/* ── 1段落アノテーション (Ollama / RunPod / OpenRouter / OpenAI 切替対応) ── */
async function annotateOneParagraph(prov, para, idx, speed, totalCount){
  const estDurPerWord = {slow:0.55, normal:0.42, fast:0.32, veryfast:0.25}[speed] || 0.35;
  const wordList = para.en.replace(/[,\.!?;:—–]/g,'').split(/\s+/).filter(Boolean);
  const estStart = para.start || 0;
  const estEnd   = para.end ?? (estStart + wordList.length * estDurPerWord);
  const numPredict = Math.min(4096, 200 + wordList.length * 120);
  const wordCount = wordList.length;

  const prompt =
`Pronunciation annotation for ENGLISH ONLY. Annotate every English word below.
English: "${para.en}"
Words (${wordCount}): ${wordList.join(' | ')}
Time: ${estStart.toFixed(1)}s to ${estEnd.toFixed(1)}s

Output ONLY valid JSON with exactly ${wordCount} items in "words":
{"start":${estStart.toFixed(1)},"end":${estEnd.toFixed(1)},"words":[{"t":"word","ws":0.0,"stress":"s","inton":"rise","elision":false,"note":""}]}

Required for EVERY word (no omissions):
- t: exact English word from the list above (never Japanese)
- ws: word start time in seconds, increasing
- stress: "s"=stressed content word, "w"=unstressed function word
- inton: "rise"|"fall"|"risefall"|null — rise before lists/clauses, fall at phrase end
- elision: true if reduced/linked (to→tə, of→əv, your→jər, and→ən, into→ɪnə, going to→gonna)
- note: IPA reduction when elision=true, else ""

Example word: {"t":"to","ws":1.2,"stress":"w","inton":null,"elision":true,"note":"tʊ→tə"}`;

  /* ── タイムアウト付きfetch (240秒) ── */
  const controller = new AbortController();
  const timeoutId  = setTimeout(()=> controller.abort(), 240000);
  /* 経過時間を表示 */
  const startedAt  = Date.now();
  const timerDisp  = setInterval(()=>{
    const sec = Math.floor((Date.now()-startedAt)/1000);
    setModalStatus(`段落 ${idx+1}/${totalCount} 処理中… ${sec}秒経過`, 5 + Math.round((idx/Math.max(totalCount,1))*90));
  }, 1000);

  let rawText2 = '';
  try{
    if(prov.provider === 'ollama'){
      const ollamaUrl = (genOllamaUrl||'http://localhost:11434').replace(/\/$/,'');
      const model     = prov.model || 'qwen3.5:4b';
      const resp = await fetch(ollamaUrl+'/api/chat',{
        method:'POST',
        signal: controller.signal,
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify({
          model,
          stream: false,
          think: false,
          options:{ temperature:0, num_predict:numPredict },
          messages:[
            {role:'system', content:'Pronunciation annotator. JSON only. Every word needs stress, inton, elision, note. English words only. Start with {'},
            {role:'user',   content: prompt}
          ]
        })
      });
      if(!resp.ok) throw new Error('HTTP '+resp.status+': '+(await resp.text().catch(()=>'')).slice(0,80));
      const data = await resp.json();
      rawText2 = data.message?.content || data.response || '';
    } else if(prov.provider === 'runpod'){
      /* RunPod: /run でジョブ投入 → /status をポーリング → 切断/タイムアウト時は /cancel */
      const base    = runpodEndpointBase(prov.endpoint);
      const model   = prov.model || 'qwen/qwen3.5-9b';
      const headers = {'Content-Type':'application/json','Authorization':'Bearer '+prov.apiKey};
      const runResp = await fetch(base+'/run', {
        method:'POST',
        signal: controller.signal,
        headers,
        body: JSON.stringify({
          input: {
            openai_route: '/v1/chat/completions',
            openai_input: {
              model, max_tokens:numPredict, temperature:0,
              chat_template_kwargs:{enable_thinking:false},
              messages:[
                {role:'system', content:'You are a pronunciation annotator. Output valid JSON only.'},
                {role:'user',   content: prompt}
              ]
            }
          }
        })
      });
      if(!runResp.ok){
        const err = await runResp.json().catch(()=>({}));
        throw new Error(err.error?.message||'HTTP '+runResp.status);
      }
      const job   = await runResp.json();
      const jobId = job.id;
      if(!jobId) throw new Error('RunPod /run のレスポンスにjob idがありません');

      window._activeRunpodJob = {base, apiKey: prov.apiKey, jobId};
      try{
        while(true){
          await new Promise(r=>setTimeout(r, 1500));
          const stResp = await fetch(base+'/status/'+jobId, {signal: controller.signal, headers});
          if(!stResp.ok) continue;
          const st = await stResp.json();
          if(st.status === 'COMPLETED'){
            const choices = st.output?.choices || [];
            if(!choices.length) throw new Error('RunPodの出力にchoicesがありません');
            rawText2 = choices[0].message?.content || '';
            break;
          }
          if(st.status==='FAILED' || st.status==='CANCELLED' || st.status==='TIMED_OUT'){
            throw new Error('RunPodジョブが'+st.status+'になりました');
          }
          /* IN_QUEUE / IN_PROGRESS → 次のポーリングへ継続 */
        }
      } catch(e){
        if(e.name === 'AbortError'){
          fetch(base+'/cancel/'+jobId, {method:'POST', headers, keepalive:true}).catch(()=>{});
        }
        throw e;
      } finally {
        window._activeRunpodJob = null;
      }
    } else {
      /* OpenAI互換 (OpenRouter / OpenAI) — バックエンドの _translate_chat と揃える */
      const url   = resolveOpenAiCompatUrl(prov);
      const model = prov.model || 'gpt-4o-mini';
      const extra = prov.provider === 'openrouter' ? {reasoning:{enabled:false}} : null;
      const headers = {'Content-Type':'application/json','Authorization':'Bearer '+prov.apiKey};
      if(url.includes('openrouter.ai')){
        headers['HTTP-Referer'] = 'http://localhost:8080';
        headers['X-Title']      = 'Lilt';
      }
      const resp = await fetch(url, {
        method:'POST',
        signal: controller.signal,
        headers,
        body: JSON.stringify({
          model, max_tokens:numPredict, temperature:0,
          ...(extra || {}),
          messages:[
            {role:'system', content:'You are a pronunciation annotator. Output valid JSON only.'},
            {role:'user',   content: prompt}
          ]
        })
      });
      if(!resp.ok){
        const err = await resp.json().catch(()=>({}));
        throw new Error(err.error?.message||'HTTP '+resp.status);
      }
      rawText2 = (await resp.json()).choices?.[0]?.message?.content||'';
    }
  } finally {
    clearTimeout(timeoutId);
    clearInterval(timerDisp);
  }

  const clean = extractJsonFromLlm(rawText2);

  let parsed;
  try{ parsed = JSON.parse(clean); }
  catch(e){ throw new Error('JSON parse error: '+clean.slice(0,80)); }

  const start = parsed.start ?? estStart;
  const end   = parsed.end   ?? estEnd;
  const words = buildWordsFromParsed(parsed.words||[], {...para, start, end}, estDurPerWord);
  return { id: idx, start, end, en: para.en, ja: para.ja, words };
}

const TS_LINE_RE = /^(\d+):(\d{2})$/;

function parseClockToSec(m, s){ return parseInt(m,10)*60 + parseInt(s,10); }

function isTimestampTranscript(text){
  return /^\d+:\d{2}$/m.test((text||'').replace(/\r\n/g,'\n'));
}

/* ── 生成用: 改行正規化のみ ── */
function prepTranscriptForAnnotation(text){
  return (text||'').replace(/\r\n/g,'\n').trim();
}

/* ── [Applause] / [Music] 等 [括弧] 舞台指示を除去 ── */
function stripStageTags(text){
  return (text||'').replace(/\[[^\]]*\]/g,'').replace(/\s+/g,' ').trim();
}

function hasAnnotatableEnglish(text){
  const en = stripStageTags(text);
  if(!en || !/[a-zA-Z]/.test(en)) return false;
  return en.split(/\s+/).some(w=>{
    const bare = w.replace(/[^a-zA-Z']/g,'');
    return bare.length >= 2 || /^[iIaA]$/.test(bare);
  });
}

/* ── 0:00 + 英文 形式（タイムスタンプ = チャンク開始秒） ── */
function parseTimestampTranscript(text){
  const body = prepTranscriptForAnnotation(text);
  if(!isTimestampTranscript(body)) return null;

  const lines = body.split('\n').map(l=>l.trim());
  const chunks = [];
  let i = 0;

  while(i < lines.length){
    const tm = lines[i].match(TS_LINE_RE);
    if(!tm){ i++; continue; }
    const start = parseClockToSec(tm[1], tm[2]);
    i++;
    const parts = [];
    while(i < lines.length && !TS_LINE_RE.test(lines[i])){
      const line = lines[i];
      if(line && !/[\u3040-\u9fff]/.test(line)){
        const cleaned = stripStageTags(line.replace(/[\u3040-\u9fff]+/g,'').trim());
        if(hasAnnotatableEnglish(cleaned)) parts.push(cleaned);
      }
      i++;
    }
    const en = stripStageTags(parts.join(' '));
    if(hasAnnotatableEnglish(en)) chunks.push({ en, ja: '', start });
  }
  if(!chunks.length) return null;

  chunks.forEach((c, j)=>{
    c.end = j < chunks.length - 1
      ? chunks[j+1].start
      : c.start + Math.max(2, c.en.split(/\s+/).filter(Boolean).length * 0.35);
  });
  return chunks;
}

/* ── 文字起こしテキストを段落配列に変換 ── */
function splitEnJa(block){
  const lines = block.split(/\n/).map(l=>l.trim()).filter(Boolean);
  const enLines = [], jaLines = [];
  lines.forEach(line=>{
    if(/[\u3040-\u9fff]/.test(line)) jaLines.push(line);
    else if(/[a-zA-Z]/.test(line)) enLines.push(line);
  });
  if(enLines.length || jaLines.length){
    return {
      en: enLines.join(' ').replace(/[\u3040-\u9fff]+/g,'').replace(/\s+/g,' ').trim(),
      ja: jaLines.join(' ').trim()
    };
  }
  const js = block.search(/[\u3040-\u9fff]/);
  if(js >= 0){
    return {
      en: block.slice(0, js).replace(/[\u3040-\u9fff]+/g,'').replace(/\s+/g,' ').trim(),
      ja: block.slice(js).trim()
    };
  }
  return { en: block.replace(/[\u3040-\u9fff]+/g,'').replace(/\s+/g,' ').trim(), ja: '' };
}

function parseTranscriptToParagraphs(text){
  const tsChunks = parseTimestampTranscript(text);
  if(tsChunks && tsChunks.length) return tsChunks;

  const blocks = prepTranscriptForAnnotation(text).split(/\n{2,}/).map(b=>b.trim()).filter(Boolean);
  const result = [];
  let cursor = 0;

  blocks.forEach(block=>{
    const {en, ja} = splitEnJa(block);
    const cleanEn = stripStageTags(en);
    if(!hasAnnotatableEnglish(cleanEn)) return;
    result.push({ en: cleanEn, ja, start: cursor });
    cursor += Math.max(5, en.split(/\s+/).filter(Boolean).length * 0.38);
  });

  if(result.length){
    result.forEach((p, j)=>{
      p.end = j < result.length - 1
        ? result[j+1].start
        : p.start + Math.max(5, p.en.split(/\s+/).filter(Boolean).length * 0.38);
    });
    return result;
  }
  return [{en:text.replace(/[\u3040-\u9fff]+/g,' ').replace(/\s+/g,' ').trim().slice(0,500), ja:'', start:0, end:30}];
}

