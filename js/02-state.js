/* ══════════════════════════════════════════ STATE ══ */
let showStress=true, showInton=true, showElision=true;
let rhythmSync=true;   /* リズム同期: チャンク内の語タイミングをテンポモデルで配分 */
let autoFollow=true;   /* 再生中、現在行へ自動スクロール追従 */
let fontScale=1;       /* トランスクリプト文字サイズ倍率 */
let currentPara=-1, prevLitKey=null;
let ytPlayer=null, tickTimer=null;
let totalDur = PARAS.length ? PARAS[PARAS.length-1].end : 0;
let timeOffset=0;
let chunkRepeatOn=false;
let chunkRepeatPi=-1;
let playSpeed=1;

/* チャンク（段落）ごとの自由メモ: paraIndex(number) -> 本文(string)。
   data.json/data.md とは別の notes.json に保存し、再翻訳の影響を受けない。
   _noteCtx = 保存先コンテキスト（backend: POST /notes、fsa: フォルダ書込）。*/
let NOTES = {};
window._noteCtx = null;

/* ══════════════════════════════════════════ SETTINGS（localStorage永続化） ══
   一元管理: 表示レイヤー・リズム同期・追従・文字サイズ・速度・オフセット・
   バックエンド/モデル設定を1つのキーに保存し、起動時に復元する。
══════════════════════════════════════════════════════════ */
const SETTINGS_KEY = 'lilt.settings.v1';
function loadSettings(){
  try{ return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}; }
  catch(e){ return {}; }
}
function saveSettings(patch){
  try{
    const next = {...loadSettings(), ...patch};
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
  }catch(e){ /* localStorage不可（プライベートモード等）は無視 */ }
}

