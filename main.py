import os
import re
import json
import shutil
import asyncio
import logging
import datetime
from typing import AsyncGenerator, Optional

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
import yt_dlp
from youtube_transcript_api import YouTubeTranscriptApi, NoTranscriptFound, TranscriptsDisabled
import requests as http_requests

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

LILT_VERSION = "1.0.0"

app = FastAPI(title="Lilt API")

# CORS: 既定は全許可（localhost開発用）。本番では ALLOWED_ORIGINS="http://a,http://b" で制限可能
_origins_env = os.environ.get("ALLOWED_ORIGINS", "*").strip()
ALLOWED_ORIGINS = ["*"] if _origins_env in ("", "*") else [o.strip() for o in _origins_env.split(",") if o.strip()]

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

PROJECTS_DIR  = "./projects"
OLLAMA_URL    = os.environ.get("OLLAMA_URL", "http://localhost:11434")
OLLAMA_MODEL  = os.environ.get("OLLAMA_MODEL", "qwen3.5:4b")

os.makedirs(PROJECTS_DIR, exist_ok=True)

# 起動時プリフライト: ffmpeg の有無を確認（動画マージに必須）
FFMPEG_PATH = shutil.which("ffmpeg")
if FFMPEG_PATH:
    logger.info(f"✓ ffmpeg 検出: {FFMPEG_PATH}")
else:
    logger.warning(
        "⚠ ffmpeg が見つかりません。一部の動画でダウンロード/マージに失敗する場合があります。"
        " https://ffmpeg.org/download.html からインストールし PATH を通してください。"
    )


# ── Models ──────────────────────────────────────────────────────────────────

class ProcessRequest(BaseModel):
    url: str
    model: str = OLLAMA_MODEL            # 後方互換（translate/annotate 未指定時の既定）
    translate_model: str = ""            # 翻訳モデル名（ollama: タグ / 他: モデルID）
    annotate_model: str = ""             # 後方互換（注釈はルールベース化済み・未使用）
    ollama_url: str = OLLAMA_URL
    # ── 翻訳LLMプロバイダ（RunPod/OpenRouter/OpenAI は OpenAI互換で統一）──
    translate_provider: str = "ollama"   # ollama | runpod | openrouter | openai
    translate_endpoint: str = ""         # OpenAI互換URL（RunPodのrunsync URLも受理／空=既定）
    translate_api_key: str = ""          # RunPod/OpenRouter/OpenAI のAPIキー


# ── Utilities ────────────────────────────────────────────────────────────────

def extract_video_id(url: str) -> str:
    patterns = [
        r"youtu\.be/([A-Za-z0-9_-]{11})",
        r"[?&]v=([A-Za-z0-9_-]{11})",
        r"shorts/([A-Za-z0-9_-]{11})",
        r"embed/([A-Za-z0-9_-]{11})",
    ]
    for p in patterns:
        m = re.search(p, url)
        if m:
            return m.group(1)
    raise ValueError(f"YouTube URLからvideo_idを取得できませんでした: {url}")


def assign_word_timings(words: list, start: float, end: float) -> list:
    """Mirrors assignWordTimings() in index.html."""
    n = len(words)
    if not n:
        return words
    span = max(0.2, end - start)
    step = span / n
    result = []
    for wi, w in enumerate(words):
        ws = w.get("ws")
        if not isinstance(ws, (int, float)) or ws < start or ws >= end:
            ws = round(start + wi * step, 2)
        result.append({**w, "ws": ws})
    return result


# ── テンポ（リズム）モデル: index.html と同一ロジック ──────────
SPEECH_TEMPO = {
    "base_per_word": 0.08,
    "per_syllable":  0.17,
    "stress_mult":   1.35,
    "reduced_mult":  0.70,
    "elision_mult":  0.55,
    "comma_pause":   0.16,
    "period_pause":  0.28,
}


def count_syllables(word: str) -> int:
    w = re.sub(r"[^a-z]", "", (word or "").lower())
    if not w:
        return 1
    if len(w) <= 3:
        return 1
    s = re.sub(r"(?:[^laeiouy]es|ed|[^laeiouy]e)$", "", w)
    s = re.sub(r"^y", "", s)
    m = re.findall(r"[aeiouy]{1,2}", s)
    return max(1, len(m)) if m else 1


def _word_weight(w: dict) -> float:
    syl_field = w.get("syl")
    if syl_field:
        syl = max(1, len([x for x in re.split(r"[·.・]", syl_field) if x]))
    else:
        syl = count_syllables(w.get("t", ""))
    mult = 1.0
    if w.get("elision"):
        mult = SPEECH_TEMPO["elision_mult"]
    elif w.get("stress") == "w":
        mult = SPEECH_TEMPO["reduced_mult"]
    elif w.get("stress") == "s":
        mult = SPEECH_TEMPO["stress_mult"]
    weight = SPEECH_TEMPO["base_per_word"] + syl * SPEECH_TEMPO["per_syllable"] * mult
    raw = w.get("t", "") or ""
    if re.search(r"[,;:]$", raw):
        weight += SPEECH_TEMPO["comma_pause"]
    elif re.search(r"[.!?]+$", raw):
        weight += SPEECH_TEMPO["period_pause"]
    return weight


def tempo_word_starts(words: list, start: float, end: float) -> list:
    n = len(words)
    if not n:
        return []
    span = max(0.3, (end if end is not None else start) - start)
    weights = [_word_weight(w) for w in words]
    total = sum(weights) or n
    starts, t = [], start
    for i in range(n):
        starts.append(round(t, 3))
        t += span * (weights[i] / total)
    return starts


def uniform_word_starts(words: list, start: float, end: float) -> list:
    n = len(words)
    if not n:
        return []
    span = max(0.2, (end if end is not None else start) - start)
    step = span / n
    return [round(start + i * step, 3) for i in range(n)]


def bake_tempo_timings(paras: list) -> list:
    """各語に ws=テンポ配分（オフライン互換）と wsUniform=均等割り を焼き込む。"""
    for p in paras:
        words = p.get("words", [])
        tempo = tempo_word_starts(words, p.get("start", 0.0), p.get("end", 0.0))
        uni   = uniform_word_starts(words, p.get("start", 0.0), p.get("end", 0.0))
        for i, w in enumerate(words):
            w["ws"] = tempo[i]
            w["wsUniform"] = uni[i]
    return paras


def build_data_md(video_id: str, paras: list) -> str:
    lines = [f"# Annotation Script: {video_id}\n"]
    for p in paras:
        s = p.get("start", 0)
        mm = str(int(s // 60)).zfill(2)
        ss = str(int(s % 60)).zfill(2)
        lines.append(f"## [{mm}:{ss}]  {p.get('en', '')}")
        lines.append(f"**JA:** {p.get('ja', '')}\n")
    return "\n".join(lines)


def _extract_json(raw: str) -> str:
    """Strip <think>...</think> blocks and markdown fences, return JSON string."""
    s = re.sub(r"<think>[\s\S]*?</think>", "", raw, flags=re.IGNORECASE).strip()
    s = re.sub(r"```json\s*|```", "", s).strip()
    m = re.search(r"\{[\s\S]*\}", s)
    return m.group(0) if m else s


# ── Blocking helpers (run via executor) ──────────────────────────────────────

def _download_video(url: str, opts: dict) -> Optional[str]:
    """動画をDLし、取得できればタイトルを返す（info.txt生成用）。"""
    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(url, download=True)
        return info.get("title") if info else None


def _get_video_title(url: str) -> Optional[str]:
    """メタデータのみ取得（DL済みスキップ時のタイトル取得用）。"""
    opts = {"quiet": True, "no_warnings": True, "skip_download": True, "noplaylist": True}
    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(url, download=False)
        return info.get("title") if info else None


def _snippets_to_list(fetched) -> list:
    """Convert FetchedTranscript (v1.x) or list of dicts (v0.x) to list of dicts."""
    result = []
    for s in fetched:
        if isinstance(s, dict):
            result.append(s)
        else:
            result.append({"text": s.text, "start": s.start, "duration": s.duration})
    return result


def _get_transcript(video_id: str) -> list:
    api = YouTubeTranscriptApi()

    # 1. 手動英語字幕を試みる
    try:
        fetched = api.fetch(video_id, languages=["en"])
        return _snippets_to_list(fetched)
    except NoTranscriptFound:
        pass
    except TranscriptsDisabled:
        raise RuntimeError("この動画は字幕が無効になっています。")
    except Exception:
        pass

    # 2. 自動生成・翻訳でフォールバック
    try:
        tlist = api.list(video_id)
        try:
            t = tlist.find_generated_transcript(["en"])
            return _snippets_to_list(t.fetch())
        except Exception:
            first = next(iter(tlist))
            return _snippets_to_list(first.translate("en").fetch())
    except Exception as e:
        raise RuntimeError(f"字幕の取得に失敗しました: {e}")


TRANSLATE_ONLY_SYSTEM = """You are an English-to-Japanese translation expert.
You will receive a JSON array of English sentences that were already segmented from a video transcript verbatim — do NOT rewrite, merge, split, reorder, or correct them in any way.

For each item, produce a natural and fluent Japanese translation.

Output ONLY valid complete JSON in this exact format (same length and order as the input array, no truncation, no explanation):
{"translations":["日本語訳1","日本語訳2"]}"""


def _repair_translations_json(raw: str) -> str:
    """Try to salvage a truncated {"translations":[...]} JSON string."""
    cleaned = _extract_json(raw)
    try:
        json.loads(cleaned)
        return cleaned
    except json.JSONDecodeError:
        pass

    # Most common truncation is a missing closing quote/bracket/brace
    for suffix in (']}', '"]}', '"}]}'):
        try:
            candidate = cleaned + suffix
            json.loads(candidate)
            logger.debug(f"Translation JSON repaired by appending '{suffix}'")
            return candidate
        except json.JSONDecodeError:
            pass

    raise ValueError(f"JSON unparseable after repair attempt. First 200 chars: {cleaned[:200]}")


def _simple_chunk_transcript(transcript: list) -> list:
    """Fallback: group transcript entries into paragraphs without LLM."""
    paras, buf, buf_start, buf_end = [], [], None, None
    for entry in transcript:
        text = entry.get("text", "").strip()
        if not text or re.match(r"^\[.*\]$", text):   # skip [Music] etc.
            continue
        start = float(entry.get("start", 0))
        end   = start + float(entry.get("duration", 0))
        if buf_start is None:
            buf_start = start
        buf.append(text)
        buf_end = end
        joined = " ".join(buf)
        word_count = len(joined.split())
        ends_sentence = text.rstrip().endswith((".", "?", "!"))
        if (ends_sentence and word_count >= 6) or word_count >= 20:
            paras.append({"en": joined, "ja": "", "start": buf_start, "end": buf_end})
            buf, buf_start, buf_end = [], None, None
    if buf and buf_start is not None:
        paras.append({"en": " ".join(buf), "ja": "", "start": buf_start, "end": buf_end})
    return paras


def _translate_window(
    window: list, provider: str, ollama_url: str, model: str,
    endpoint: str, api_key: str,
) -> list:
    """1ウィンドウ分の英文を翻訳し translations(list[str]) を返す。失敗時は例外を送出。
    event_stream から executor 経由でウィンドウごとに呼び出す（進捗送信のため）。"""
    num_predict = min(4096, sum(len(p["en"].split()) for p in window) * 4 + 256)
    user_content = json.dumps([p["en"] for p in window], ensure_ascii=False)
    messages = [
        {"role": "system", "content": TRANSLATE_ONLY_SYSTEM},
        {"role": "user",   "content": f"Translate these {len(window)} English sentences into Japanese:\n{user_content}"},
    ]
    raw = _translate_chat(
        messages, num_predict,
        provider=provider, ollama_url=ollama_url, model=model,
        endpoint=endpoint, api_key=api_key,
    )
    parsed = json.loads(_repair_translations_json(raw))
    return parsed.get("translations", [])


# ── 以下の LLM アノテーション関数は現在未使用（_rule_annotate_para に置き換え済み）──
# OpenAI バックエンド対応や将来の拡張に備えて残存
ANNOTATE_SYSTEM = (
    "Pronunciation annotator. Output JSON only. "
    "Annotate every English word with stress/inton/elision/note. "
    "English words only — never output Japanese characters in 't' field. "
    'Start your response with "{"'
)


def _llm_annotate_paragraph(para: dict, idx: int, ollama_url: str, model: str) -> dict:
    en_text = para.get("en", "")
    tokens = [w for w in re.sub(r"[,\.!?;:—–\"]", "", en_text).split() if w]
    n = len(tokens)
    if not n:
        return _make_fallback_para(para, idx)

    start = float(para.get("start", 0.0))
    end   = float(para.get("end", start + n * 0.35))
    num_predict = min(4096, 200 + n * 120)

    prompt = (
        f'Pronunciation annotation for ENGLISH ONLY. Annotate every word below.\n'
        f'English: "{en_text}"\n'
        f"Words ({n}): {' | '.join(tokens)}\n"
        f"Time: {start:.1f}s to {end:.1f}s\n\n"
        f'Output ONLY valid JSON with exactly {n} items in "words":\n'
        f'{{"start":{start:.1f},"end":{end:.1f},"words":[{{"t":"word","ws":0.0,"stress":"s","inton":"rise","elision":false,"note":""}}]}}\n\n'
        f"Required for EVERY word (no omissions, no Japanese in t field):\n"
        f'- t: exact English word from list (never Japanese)\n'
        f"- ws: word start time in seconds, monotonically increasing within [{start:.1f}, {end:.1f}]\n"
        f'- stress: "s"=stressed content word, "w"=unstressed function word\n'
        f'- inton: "rise"|"fall"|"risefall"|null\n'
        f"- elision: true if reduced/linked (to->ta, of->av, your->jar, and->an)\n"
        f'- note: IPA reduction when elision=true, else ""\n\n'
        f'Example: {{"t":"to","ws":1.2,"stress":"w","inton":null,"elision":true,"note":"tu->ta"}}'
    )

    base = ollama_url.rstrip("/")
    resp = http_requests.post(
        f"{base}/api/chat",
        json={
            "model": model,
            "stream": False,
            "think": False,
            "options": {"temperature": 0, "num_predict": num_predict},
            "messages": [
                {"role": "system", "content": ANNOTATE_SYSTEM},
                {"role": "user",   "content": prompt},
            ],
        },
        timeout=240,
    )
    resp.raise_for_status()
    raw = resp.json()["message"]["content"]
    parsed = json.loads(_extract_json(raw))

    p_start = float(parsed.get("start", start))
    p_end   = float(parsed.get("end",   end))
    words_raw = parsed.get("words", [])
    words = assign_word_timings(_build_words(words_raw, tokens), p_start, p_end)

    return {
        "id":    idx,
        "start": p_start,
        "end":   p_end,
        "en":    en_text,
        "ja":    para.get("ja", ""),
        "words": words,
    }


def _build_words(llm_words: list, tokens: list) -> list:
    result = []
    for i, token in enumerate(tokens):
        w = llm_words[i] if i < len(llm_words) else {}
        # Guard: reject Japanese characters appearing in the 't' field
        t_val = w.get("t", token)
        if re.search(r"[぀-ヿ一-鿿]", str(t_val)):
            t_val = token
        result.append({
            "t":      t_val,
            "ws":     w.get("ws"),
            "stress": w.get("stress", "w"),
            "inton":  w.get("inton"),
            "elision": bool(w.get("elision", False)),
            "note":   w.get("note", ""),
        })
    return result


def _ollama_chat(messages: list, base_url: str, model: str, num_predict: int) -> str:
    """Ollama /api/chat を呼び出してコンテンツ文字列を返す。"""
    base = base_url.rstrip("/")
    resp = http_requests.post(
        f"{base}/api/chat",
        json={
            "model":   model,
            "stream":  False,
            "think":   False,
            "options": {"temperature": 0, "num_predict": num_predict, "num_ctx": 4096},
            "messages": messages,
        },
        timeout=180,
    )
    resp.raise_for_status()
    return resp.json()["message"]["content"]


OPENROUTER_DEFAULT_URL = "https://openrouter.ai/api/v1/chat/completions"
OPENAI_DEFAULT_URL     = "https://api.openai.com/v1/chat/completions"


def _normalize_runpod_url(url: str) -> str:
    """RunPodエンドポイントURLを OpenAI互換の chat/completions URL に正規化。
    例: https://api.runpod.ai/v2/{id}/runsync
        → https://api.runpod.ai/v2/{id}/openai/v1/chat/completions"""
    u = (url or "").strip().rstrip("/")
    u = re.sub(r"/(runsync|run)$", "", u)          # 末尾の /runsync・/run を除去
    if u.endswith("/chat/completions"):
        return u
    if u.endswith("/openai/v1"):
        return u + "/chat/completions"
    return u + "/openai/v1/chat/completions"        # base のみ → 補完


def _openai_compatible_chat(
    messages: list, url: str, api_key: str, model: str,
    max_tokens: int, extra_body: Optional[dict] = None,
) -> str:
    """OpenAI互換 /chat/completions を呼ぶ（RunPod vLLM / OpenRouter / OpenAI 共通）。"""
    payload = {
        "model":       model,
        "messages":    messages,
        "temperature": 0,
        "max_tokens":  max_tokens,
    }
    if extra_body:
        payload.update(extra_body)
    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
    # OpenRouter 推奨ヘッダ（任意・ランキング用）
    if "openrouter.ai" in url:
        headers["HTTP-Referer"] = "http://localhost:8080"
        headers["X-Title"]      = "Lilt"
    resp = http_requests.post(url, headers=headers, json=payload, timeout=300)
    if not resp.ok:
        raise RuntimeError(f"HTTP {resp.status_code}: {resp.text[:300]}")
    data = resp.json()
    choices = data.get("choices", [])
    if not choices:
        raise RuntimeError(f"レスポンスに choices がありません: {str(data)[:300]}")
    return choices[0]["message"]["content"]


def _translate_chat(
    messages: list, num_predict: int, *,
    provider: str, ollama_url: str, model: str,
    endpoint: str, api_key: str,
) -> str:
    """翻訳ステージのプロバイダ振り分け。"""
    provider = (provider or "ollama").lower()
    if provider == "ollama":
        return _ollama_chat(messages, ollama_url, model, num_predict)

    if provider == "runpod":
        url   = _normalize_runpod_url(endpoint)
        # Qwen3系の thinking を無効化（vLLM拡張）— 速度・トークン節約
        extra = {"chat_template_kwargs": {"enable_thinking": False}}
    elif provider == "openrouter":
        url   = endpoint.strip() if endpoint.strip() else OPENROUTER_DEFAULT_URL
        extra = {"reasoning": {"enabled": False}}   # OpenRouter統一パラメータ（非対応モデルは無視）
    else:  # openai（汎用OpenAI互換）
        url   = endpoint.strip() if endpoint.strip() else OPENAI_DEFAULT_URL
        extra = None
    return _openai_compatible_chat(messages, url, api_key, model, num_predict, extra)


def _make_fallback_para(para: dict, idx: int) -> dict:
    en_text = para.get("en", "")
    tokens  = en_text.split()
    start   = float(para.get("start", 0.0))
    end     = float(para.get("end", start + len(tokens) * 0.35))
    words   = assign_word_timings(
        [{"t": t, "ws": None, "stress": "s", "inton": None, "elision": False, "note": ""}
         for t in tokens],
        start, end,
    )
    return {"id": idx, "start": start, "end": end, "en": en_text,
            "ja": para.get("ja", ""), "words": words}


# ── ルールベースアノテーション（General American）────────────────────────────
# js/07-generate-run.js の enrichPronunciationWords / detectElision / inferInton を移植。
# LLM 呼び出し不要で即時完了。shadowing 用途では一貫性のあるルールが LLM より適切。

_FN_WORDS = frozenset({
    "a","an","the","of","to","in","on","at","by","for","and","or","but",
    "is","was","are","were","be","been","it","its","i","you","he","she",
    "we","they","my","your","you're","they're","we're","he's","she's","it's",
    "that","this","with","as","up","so","if","from","have","has","had",
    "can","will","would","could","should","am","do","does","did","not",
    "than","then","them","us","our","her","his","what","when","where",
    "who","how","some","any","all","just","also","very","really","about",
    "into","onto","over","under","out","off","no","yes","nor",
})

_ELISION_NOTES: dict = {
    "your": "jʊr→jər",  "you're": "jʊr→jər", "to":   "tʊ→tə",
    "of":   "ɒv→əv",    "and":    "ænd→ən",   "if":   "ɪf→əf",
    "for":  "fɔːr→fər", "the":    "ði→ðə",    "a":    "ə",
    "an":   "ən",        "into":   "ˈɪntʊ→ˈɪnə", "at": "æt→ət",
    "that": "ðæt→ðət",  "can":    "kæn→kən",  "have": "hæv→həv",
    "has":  "hæz→həz",  "had":    "hæd→həd",  "was":  "wɒz→wəz",
    "were": "wɜː→wər",  "will":   "wɪl→əl",   "would":"wʊd→əd",
    "from": "frəm",      "than":   "ðæn→ðən",  "them": "ðəm",
    "him":  "ɪm",        "her":    "hər",
    "probably": "ˈprɒbəbli→ˈprɒbli", "because": "bɪˈkəz",
    "about": "əˈbaʊt",  "today":  "təˈdeɪ",
}

_NEGATIONS_RE = re.compile(
    r"can't|won't|shouldn't|don't|didn't|isn't|aren't|wasn't|weren't"
    r"|couldn't|wouldn't|haven't|hasn't",
    re.IGNORECASE,
)


def _norm_bare(token: str) -> str:
    return re.sub(r"[^a-zA-Z'-]", "", token).lower()


def _is_fn_word(bare: str) -> bool:
    return bare in _FN_WORDS


def _detect_elision(bare: str, raw: str, tokens: list, wi: int):
    """Returns (elision: bool, note: str). Mirrors detectElision() in JS."""
    if bare in _ELISION_NOTES:
        return True, _ELISION_NOTES[bare]
    if re.search(r"n't$", raw, re.IGNORECASE):
        return True, "t-drop / reduction"
    next_bare = _norm_bare(tokens[wi + 1]) if wi + 1 < len(tokens) else ""
    if bare == "going" and next_bare == "to":
        return True, "going to→ˈɡʊnə"
    if bare == "want" and next_bare == "to":
        return True, "want to→wanna"
    if bare == "got" and next_bare == "to":
        return True, "got to→ˈɡɑːtə"
    if bare == "kind" and next_bare == "of":
        return True, "kind of→ˈkaɪndə"
    return False, ""


def _infer_inton(wi: int, n: int, raw: str, bare: str, stress: str, tokens: list):
    """Returns intonation label or None. Mirrors inferInton() in JS."""
    next_bare = _norm_bare(tokens[wi + 1]) if wi + 1 < n else ""
    if re.search(r"[!?]$", raw):
        return "rise" if raw.endswith("?") and _is_fn_word(bare) else "fall"
    if raw.endswith(","):
        return "fall"
    if wi == n - 1:
        return "fall"
    if _NEGATIONS_RE.search(raw):
        return "rise"
    if stress == "s" and next_bare in ("and", "or", "but"):
        return "rise"
    if stress == "s" and wi < n - 2 and tokens[wi + 1].endswith(","):
        return "rise"
    return None


def _rule_annotate_para(para: dict, idx: int) -> dict:
    """Instant rule-based pronunciation annotation for General American.
    Equivalent to enrichPronunciationWords() in js/07-generate-run.js."""
    en_text = para.get("en", "")
    tokens  = en_text.split()
    if not tokens:
        return _make_fallback_para(para, idx)

    start = float(para.get("start", 0.0))
    end   = float(para.get("end", start + len(tokens) * 0.35))
    n     = len(tokens)
    words = []

    for wi, raw in enumerate(tokens):
        bare   = _norm_bare(raw)
        stress = "w" if _is_fn_word(bare) else "s"
        elision, note = _detect_elision(bare, raw, tokens, wi)
        inton  = _infer_inton(wi, n, raw, bare, stress, tokens)
        words.append({
            "t":       raw,
            "ws":      None,   # bake_tempo_timings() が後で設定
            "stress":  stress,
            "inton":   inton,
            "elision": elision,
            "note":    note,
        })

    words = assign_word_timings(words, start, end)
    return {
        "id":    idx,
        "start": start,
        "end":   end,
        "en":    en_text,
        "ja":    para.get("ja", ""),
        "words": words,
    }


# ── API Routes ───────────────────────────────────────────────────────────────

@app.get("/projects")
async def list_projects():
    if not os.path.isdir(PROJECTS_DIR):
        return []
    results = []
    for vid_id in sorted(os.listdir(PROJECTS_DIR)):
        proj_dir = os.path.join(PROJECTS_DIR, vid_id)
        if not os.path.isdir(proj_dir):
            continue
        video_exts = {".mp4", ".webm", ".mkv", ".m4v", ".avi", ".mov"}
        has_video = any(
            os.path.splitext(f)[1].lower() in video_exts
            for f in os.listdir(proj_dir)
            if os.path.isfile(os.path.join(proj_dir, f)) and f.startswith("video.")
        )
        has_data  = os.path.exists(os.path.join(proj_dir, "data.json"))
        title = vid_id
        if has_data:
            try:
                with open(os.path.join(proj_dir, "data.json"), encoding="utf-8") as f:
                    d = json.load(f)
                title = d.get("contentBase", vid_id)
            except Exception:
                pass
        results.append({
            "video_id":  vid_id,
            "title":     title,
            "has_video": has_video,
            "has_data":  has_data,
        })
    return results


@app.delete("/projects/{video_id}")
async def delete_project(video_id: str):
    # Sanitize: reject paths with slashes or dots to prevent directory traversal
    if not re.match(r"^[A-Za-z0-9_\-]+$", video_id):
        raise HTTPException(status_code=400, detail="無効なvideo_idです")
    proj_dir = os.path.join(PROJECTS_DIR, video_id)
    if not os.path.isdir(proj_dir):
        raise HTTPException(status_code=404, detail="プロジェクトが見つかりません")
    try:
        shutil.rmtree(proj_dir)
        logger.info(f"Deleted project: {video_id}")
        return {"status": "deleted", "video_id": video_id}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"削除に失敗しました: {e}")


@app.post("/process")
async def process_youtube(request: ProcessRequest):
    try:
        video_id = extract_video_id(request.url)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    async def event_stream() -> AsyncGenerator[str, None]:
        def send(obj: dict) -> str:
            return f"data: {json.dumps(obj, ensure_ascii=False)}\n\n"

        loop = asyncio.get_event_loop()
        output_dir = os.path.join(PROJECTS_DIR, video_id)
        os.makedirs(output_dir, exist_ok=True)

        # ── Stage 1+2: 動画DL + 字幕取得（asyncio.gather で並列実行） ──────────
        # DL と字幕取得は互いに独立しているため同時実行。
        # 字幕は通常 1〜2 秒で完了するため、DL 待機中に取得を済ませられる。
        video_path = os.path.join(output_dir, "video.mp4")
        VIDEO_EXTS = {".mp4", ".webm", ".mkv", ".m4v", ".avi", ".mov"}
        ydl_opts = {
            # 1st choice: pre-merged MP4 (no ffmpeg needed)
            # 2nd choice: any pre-merged file ≤480p
            # 3rd choice: best ≤480p (may need ffmpeg merge)
            "format": (
                "best[height<=480][ext=mp4]"
                "/best[height<=480]"
                "/bestvideo[height<=480]+bestaudio/best"
            ),
            "outtmpl":             os.path.join(output_dir, "video.%(ext)s"),
            "merge_output_format": "mp4",
            "quiet":               False,
            "overwrites":          True,
            "noplaylist":          True,
            "no_warnings":         False,
        }
        already_downloaded = any(
            os.path.isfile(os.path.join(output_dir, fname))
            and fname.startswith("video.")
            and os.path.splitext(fname)[1].lower() in VIDEO_EXTS
            for fname in os.listdir(output_dir)
        )

        video_title: Optional[str] = None

        if already_downloaded:
            yield send({"type": "progress", "stage": "download", "pct": 20,
                        "msg": "動画は既にダウンロード済みのためスキップし、字幕取得から再開します..."})
            dl_result = None
            title_future = loop.run_in_executor(None, _get_video_title, request.url)
            sub_future   = loop.run_in_executor(None, _get_transcript, video_id)
            title_result, sub_result = await asyncio.gather(
                title_future, sub_future, return_exceptions=True
            )
            if not isinstance(title_result, Exception):
                video_title = title_result
        else:
            yield send({"type": "progress", "stage": "download", "pct": 5,
                        "msg": "動画のダウンロードと字幕取得を並列実行中..."})
            dl_future  = loop.run_in_executor(None, _download_video, request.url, ydl_opts)
            sub_future = loop.run_in_executor(None, _get_transcript, video_id)
            # return_exceptions=True: 片方が失敗してももう一方をキャンセルしない
            dl_result, sub_result = await asyncio.gather(
                dl_future, sub_future, return_exceptions=True
            )
            if isinstance(dl_result, str):
                video_title = dl_result

        # DL 結果の処理（失敗は warning のみ — 字幕処理は続行）
        download_ok = False
        if isinstance(dl_result, Exception):
            yield send({"type": "warning", "stage": "download",
                        "msg": f"動画DLエラー（字幕処理は続行）: {str(dl_result)[:200]}"})
        else:
            for fname in os.listdir(output_dir):
                fpath = os.path.join(output_dir, fname)
                if not os.path.isfile(fpath):
                    continue
                ext = os.path.splitext(fname)[1].lower()
                if fname.startswith("video.") and ext in VIDEO_EXTS and fname != "video.mp4":
                    os.replace(fpath, video_path)
                    logger.info(f"Renamed {fname} → video.mp4")
                    break
            download_ok = os.path.exists(video_path)
            if download_ok:
                size_mb = os.path.getsize(video_path) / 1024 / 1024
                yield send({"type": "progress", "stage": "download", "pct": 20,
                            "msg": f"動画のダウンロード完了 ({size_mb:.1f} MB)"})
            else:
                yield send({"type": "warning", "stage": "download",
                            "msg": "動画ファイルが見つかりません（ffmpegがインストールされているか確認）"})

        # 字幕結果の処理（失敗は fatal — パイプラインを停止）
        if isinstance(sub_result, Exception):
            yield send({"type": "error", "stage": "subtitle", "msg": str(sub_result)[:300]})
            return
        transcript = sub_result
        if not transcript:
            yield send({"type": "error", "stage": "subtitle",
                        "msg": "字幕が空でした。この動画には利用可能な字幕がない可能性があります。"})
            return
        yield send({"type": "progress", "stage": "subtitle", "pct": 22,
                    "msg": f"字幕取得完了（{len(transcript)}エントリ）"})

        # アノテーションはルールベースに置き換え済みのため翻訳モデルのみ使用
        translate_model = request.translate_model or request.model

        # 翻訳プロバイダ判定（英文段落化→翻訳→注釈は以降のステージで実施）
        _provider  = (request.translate_provider or "ollama").lower()
        _llm_label = translate_model if _provider == "ollama" else f"{_provider}:{translate_model}"

        # 動画と同じフォルダにメタ情報を txt で保存
        try:
            info_text = (
                f"Movie title: {video_title or video_id}\n"
                f"URL: {request.url}\n"
                f"Use LLM model: {_llm_label}\n"
                f"Use Lilt Version: {LILT_VERSION}\n"
            )
            with open(os.path.join(output_dir, "info.txt"), "w", encoding="utf-8") as f:
                f.write(info_text)
        except Exception as e:
            logger.warning(f"info.txt の保存に失敗: {e}")

        # ── Stage 3a: 英文の段落化（ルールベース・LLM不要／原文をそのまま保持） ──
        yield send({"type": "progress", "stage": "llm", "pct": 25,
                    "msg": "字幕を段落に分割中..."})
        paragraphs_raw = _simple_chunk_transcript(transcript)
        if not paragraphs_raw:
            yield send({"type": "error", "stage": "llm",
                        "msg": "字幕から段落を生成できませんでした。"})
            return

        def _write_data_md(paras_src: list) -> None:
            """現時点の段落で data.md を保存（部分結果でも必ず原文を残す）。"""
            try:
                with open(os.path.join(output_dir, "data.md"), "w", encoding="utf-8") as f:
                    f.write(build_data_md(video_id, paras_src))
            except Exception as e:
                logger.warning(f"data.md 保存に失敗: {e}")

        # 翻訳前に英語のみで先行保存（翻訳が失敗・遅延しても原文は確実に手に入る）
        _write_data_md(paragraphs_raw)

        # ── Stage 3b: 日本語訳をウィンドウ単位で生成（進捗送信＋タイムアウト時フェイルファスト） ──
        if _provider == "runpod":
            translate_dest = _normalize_runpod_url(request.translate_endpoint)
        elif _provider == "openrouter":
            translate_dest = request.translate_endpoint.strip() or OPENROUTER_DEFAULT_URL
        elif _provider == "openai":
            translate_dest = request.translate_endpoint.strip() or OPENAI_DEFAULT_URL
        else:
            translate_dest = request.ollama_url
        logger.info(f"Translation provider: {_provider} | model={translate_model} | endpoint={translate_dest}")

        WINDOW = 12
        windows = [paragraphs_raw[i:i+WINDOW] for i in range(0, len(paragraphs_raw), WINDOW)]
        for wi, window in enumerate(windows):
            pct = 25 + int((wi / max(len(windows), 1)) * 58)   # 25 → 83%
            yield send({"type": "progress", "stage": "llm", "pct": pct,
                        "msg": f"日本語訳を生成中（{_llm_label}）... {wi+1}/{len(windows)}"})
            try:
                translations = await loop.run_in_executor(
                    None, _translate_window, window,
                    _provider, request.ollama_url, translate_model,
                    request.translate_endpoint, request.translate_api_key,
                )
                for p, ja in zip(window, translations):
                    p["ja"] = ja
                logger.info(f"Window {wi+1}/{len(windows)}: {len(translations)} 件翻訳 OK")
                _write_data_md(paragraphs_raw)   # ウィンドウ毎に逐次保存
            except (http_requests.exceptions.Timeout, http_requests.exceptions.ConnectionError) as e:
                # 接続不可／無応答 → 以降も同様に失敗する公算が高い。無駄な待機を避け英語のみで打ち切り
                logger.warning(f"Window {wi+1}/{len(windows)} 接続失敗 ({type(e).__name__}): 翻訳を中止し英語のみで保存")
                yield send({"type": "warning", "stage": "llm", "pct": 83,
                            "msg": f"翻訳サーバ（{_provider}）が応答しません（{type(e).__name__}）。"
                                   f"英語のみで保存します。RunPodの場合はワーカー起動（コールドスタート）をご確認ください。"})
                break
            except Exception as e:
                # JSONパース失敗など個別ウィンドウの問題 → そのウィンドウは英語のまま続行
                logger.warning(f"Window {wi+1}/{len(windows)} 翻訳失敗 ({e}): 英語のまま続行")
                yield send({"type": "warning", "stage": "llm", "pct": pct,
                            "msg": f"ウィンドウ{wi+1}の翻訳に失敗（英語のまま続行）"})

        _write_data_md(paragraphs_raw)
        yield send({"type": "progress", "stage": "llm", "pct": 85,
                    "msg": f"対訳mdを保存（{len(paragraphs_raw)}段落）。発音アノテーションへ..."})

        # ── Stage 3c: ルールベースアノテーション + Stage 4: 保存 ────────────
        # ここで例外が出ても対訳md（行内で保存済み）は残るよう try/except で保護し、
        # 失敗時はSSEエラーを返す（ストリームの無言中断を防ぐ）。
        try:
            # GA ルール（機能語/強勢/弱化/消音/イントネーション）を Python で適用。
            yield send({"type": "progress", "stage": "llm", "pct": 88,
                        "msg": f"発音アノテーションを生成中（ルールベース・{len(paragraphs_raw)}段落）..."})
            paras = [_rule_annotate_para(p, i) for i, p in enumerate(paragraphs_raw)]

            yield send({"type": "progress", "stage": "save", "pct": 92,
                        "msg": "ファイルを保存中..."})
            # ws=テンポ配分（オフライン互換）+ wsUniform=均等割り を焼き込む
            bake_tempo_timings(paras)
            final_json = {
                "version":     "2",
                "contentBase": video_id,
                "generatedAt": datetime.datetime.utcnow().isoformat() + "Z",
                "paras":       paras,
            }
            with open(os.path.join(output_dir, "data.json"), "w", encoding="utf-8") as f:
                json.dump(final_json, f, ensure_ascii=False, indent=2)
            with open(os.path.join(output_dir, "data.md"), "w", encoding="utf-8") as f:
                f.write(build_data_md(video_id, paras))
        except Exception as e:
            logger.exception("アノテーション/保存でエラー")
            yield send({"type": "error", "stage": "save",
                        "msg": f"アノテーション/保存に失敗しました（対訳mdは保存済み）: {str(e)[:200]}"})
            return

        yield send({
            "type":      "done",
            "video_id":  video_id,
            "para_count": len(paras),
            "data_url":  f"/files/{video_id}/data.json",
            "video_url": f"/files/{video_id}/video.mp4" if download_ok else None,
            "msg":       f"完了！ {len(paras)}段落を生成しました",
        })

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.get("/health")
async def health():
    """フロントエンドが環境状態（ffmpeg / Ollama / モデル）を確認するための診断エンドポイント。"""
    ffmpeg_ok = shutil.which("ffmpeg") is not None
    ollama_ok = False
    models: list = []
    try:
        r = await asyncio.get_event_loop().run_in_executor(
            None,
            lambda: http_requests.get(f"{OLLAMA_URL.rstrip('/')}/api/tags", timeout=3),
        )
        if r.ok:
            ollama_ok = True
            models = [m.get("name") for m in r.json().get("models", []) if m.get("name")]
    except Exception:
        pass
    return {
        "status":       "ok",
        "ffmpeg":       ffmpeg_ok,
        "ollama":       ollama_ok,
        "models":       models,
        "default_model": OLLAMA_MODEL,
        "projects_dir": os.path.abspath(PROJECTS_DIR),
    }


# Mount AFTER route definitions so /projects API route takes priority
# /files/* で静的ファイルを配信（/projects/* はAPIルートとして保持）
app.mount("/files", StaticFiles(directory=PROJECTS_DIR), name="files")
