/* ══ INIT ══ */
applySavedSettings();
if(typeof initShadowUI==='function') initShadowUI();
renderTranscript();
/* 既定タブ＝フレーズ（タブ順: フレーズ → 凡例 → 生成(PC) → 設定） */
document.getElementById('sbody').innerHTML=phrasesHTML();
updateChunkRepeatUI();
applyResponsive();
window.addEventListener('resize',applyResponsive);
/* 記憶済みの親フォルダ（FSA）を復元 */
if(typeof restoreSavedFolder==='function') restoreSavedFolder();
/* タブを閉じる/リロード時、進行中のRunPodジョブをキャンセル（課金停止） */
window.addEventListener('pagehide', cancelActiveRunpodJob);
