/* ══════════════════════════════════════════════════════════
   チャンク（段落）ごとの自由メモ
   ・動画フォルダの notes.json に保存。data.json / data.md とは独立しているため、
     再翻訳・再生成で上書きされない。
   ・配置はボタンセット（.para-head）とアノテーション（.sentence）の間。
   ・未入力チャンクのトリガーは hover 時のみ表示（CSS）。入力中はデバウンス自動保存。
   公開関数:
     loadNotes / loadNotesFSA（読込）, renderNoteBlock（03 から描画）,
     startNoteEdit / onNoteInput / endNoteEdit（編集ハンドラ）
══════════════════════════════════════════════════════════ */

let _notesSaveTimer = null;   /* 自動保存のデバウンスタイマー */
let _lastNotePi     = -1;     /* 直近に編集したチャンク（保存インジケータ用） */
const NOTES_SAVE_DEBOUNCE_MS = 600;

/* ── notes.json テキストを NOTES に反映（壊れていれば空扱い） ── */
function _applyNotesText(text){
  NOTES = {};
  try{
    const data = JSON.parse(text);
    if(data && data.notes && typeof data.notes === 'object'){
      Object.keys(data.notes).forEach(k=>{
        const t = data.notes[k];
        if(t != null && String(t).trim()) NOTES[Number(k)] = String(t);
      });
    }
  }catch(e){ /* 解析失敗はメモ無し扱い */ }
}

/* ── backend: notes.json を fetch して反映（404・失敗は空扱い） ── */
async function loadNotes(ctx){
  NOTES = {};
  window._noteCtx = ctx || null;
  if(!ctx || ctx.mode !== 'backend') return;
  try{
    const resp = await fetch(libFileUrl(ctx.bkUrl, ctx.root || '', ctx.id, 'notes.json'));
    if(resp.ok) _applyNotesText(await resp.text());
  }catch(e){ /* 読み込み失敗はメモ無し扱い */ }
}

/* ── FSA: フォルダハンドルから notes.json を読む ── */
async function loadNotesFSA(dirHandle){
  NOTES = {};
  window._noteCtx = { mode: 'fsa' };
  try{
    const fh = await dirHandle.getFileHandle('notes.json');
    _applyNotesText(await (await fh.getFile()).text());
  }catch(e){ /* notes.json 無し → 空 */ }
}

/* ── 取得 / 更新 ── */
function getNote(pi){ return NOTES[pi] || ''; }

function setNote(pi, text){
  if(text && text.trim()) NOTES[pi] = text;
  else                    delete NOTES[pi];
  _scheduleSaveNotes();
}

/* ── デバウンス自動保存 ── */
function _scheduleSaveNotes(){
  if(_notesSaveTimer) clearTimeout(_notesSaveTimer);
  _notesSaveTimer = setTimeout(persistNotes, NOTES_SAVE_DEBOUNCE_MS);
}

async function persistNotes(){
  _notesSaveTimer = null;
  const ctx = window._noteCtx;
  if(!ctx) return;
  /* {indexString: text}（空白のみは除外） */
  const notes = {};
  Object.keys(NOTES).forEach(k=>{ const t = (NOTES[k]||'').trim(); if(t) notes[k] = t; });
  try{
    if(ctx.mode === 'backend'){
      const url = `${ctx.bkUrl}/notes/${encodeURIComponent(ctx.id)}`
                + (ctx.root ? `?root=${encodeURIComponent(ctx.root)}` : '');
      const resp = await fetch(url, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ notes }),
      });
      if(!resp.ok) throw new Error('HTTP ' + resp.status);
    }else if(ctx.mode === 'fsa'){
      await _saveNotesFSA(notes);
    }
    _flashNoteSaved();
  }catch(e){
    showToast('メモの保存に失敗: ' + e.message, true, 3000);
  }
}

/* ── FSA 書き込み（動画名サブフォルダの notes.json） ── */
async function _saveNotesFSA(notes){
  if(!fsaDirHandle) return;
  const base   = currentBase || 'annotation';
  const subDir = await fsaDirHandle.getDirectoryHandle(base, { create: true });
  const fh     = await subDir.getFileHandle('notes.json', { create: true });
  const w      = await fh.createWritable();
  await w.write(JSON.stringify({
    version:     '1',
    contentBase: base,
    updatedAt:   new Date().toISOString(),
    notes,
  }, null, 2));
  await w.close();
}

/* ── 保存完了の控えめなフィードバック（編集中の textarea を一瞬ハイライト） ── */
function _flashNoteSaved(){
  const ta = document.querySelector('.para-note.editing[data-pi="' + _lastNotePi + '"] textarea');
  if(!ta) return;
  ta.classList.add('saved');
  setTimeout(()=>{ ta.classList.remove('saved'); }, 700);
}

/* ── 表示モードの中身（renderNoteBlock と endNoteEdit で共用） ── */
function _noteViewInner(pi){
  const txt = getNote(pi);
  const inner = txt
    ? `<span class="para-note-text">${_esc(txt)}</span>`
    : `<span class="para-note-add">＋ メモ</span>`;
  /* onclick stopPropagation: .para の jumpTo（シーク）を抑止 */
  return `<div class="para-note-view" onclick="startNoteEdit(${pi});event.stopPropagation()">${inner}</div>`;
}

/* ── 描画: .para-head と .sentence の間に挿入するメモブロック ── */
function renderNoteBlock(pi){
  const has = !!getNote(pi);
  return `<div class="para-note${has ? ' has-note' : ''}" data-pi="${pi}">${_noteViewInner(pi)}</div>`;
}

/* ── 表示 → 編集（inline textarea） ── */
function startNoteEdit(pi){
  const box = document.querySelector('.para-note[data-pi="' + pi + '"]');
  if(!box) return;
  const cur = getNote(pi);
  box.classList.add('editing');
  box.innerHTML =
      '<textarea class="para-note-edit" rows="1"'
    + ' placeholder="この段落のメモ（自動保存）"'
    + ' oninput="onNoteInput(' + pi + ',this)"'
    + ' onblur="endNoteEdit(' + pi + ')"'
    + ' onclick="event.stopPropagation()"'
    + ' onkeydown="if(event.key===\'Escape\'){this.blur()}">'
    + _esc(cur)
    + '</textarea>';
  const ta = box.querySelector('textarea');
  if(ta){
    ta.focus();
    _autoGrowNote(ta);
    try{ ta.setSelectionRange(ta.value.length, ta.value.length); }catch(e){}
  }
}

function onNoteInput(pi, ta){
  _lastNotePi = pi;
  setNote(pi, ta.value);
  _autoGrowNote(ta);
}

/* ── 編集終了（blur）→ 表示モードへ戻す ──
   innerHTML 差し替え（outerHTML ではない）でボックスをDOMに残し、
   focus 中の textarea 除去による blur 再入が起きても無害にする。 */
function endNoteEdit(pi){
  const box = document.querySelector('.para-note[data-pi="' + pi + '"]');
  if(!box || !box.classList.contains('editing')) return;
  box.classList.remove('editing');
  box.classList.toggle('has-note', !!getNote(pi));
  box.innerHTML = _noteViewInner(pi);
}

/* ── textarea を内容に合わせて高さ自動調整 ── */
function _autoGrowNote(ta){
  ta.style.height = 'auto';
  ta.style.height = ta.scrollHeight + 'px';
}
