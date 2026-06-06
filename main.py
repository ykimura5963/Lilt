import os
import re
import json
import shutil
import asyncio
import logging
import datetime
from typing import AsyncGenerator

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

app = FastAPI(title="Pronunciation Lab API")

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
    translate_model: str = ""            # 日本語訳・チャンク分割用（推奨: 4b）
    annotate_model: str = ""             # 発音アノテーション用（推奨: 2b・高速）
    ollama_url: str = OLLAMA_URL
    runpod_url: str = ""                 # RunPod Serverless エンドポイント（空=Ollama使用）
    runpod_api_key: str = ""             # RunPod API キー
    runpod_model: str = "Qwen/Qwen3.5-9B"  # vLLM にデプロイされたモデル名（HuggingFace ID）


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
    """Mirrors assignWordTimings() in pronunciation_learner.html."""
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


# ── テンポ（リズム）モデル: pronunciation_learner.html と同一ロジック ──────────
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

def _download_video(url: str, opts: dict):
    with yt_dlp.YoutubeDL(opts) as ydl:
        ydl.download([url])


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


CHUNK_TRANSLATE_SYSTEM = """You are an English-Japanese translation expert.
Given a small list of YouTube subtitle entries (JSON array), group them into sentence-level paragraphs with Japanese translations.

Rules:
- Group into natural sentences (8-20 words each)
- Target 2-4 subtitle entries per paragraph to keep JSON output compact
- "start" = first entry's start time, "end" = last entry's start + duration
- Japanese translation must be natural and fluent
- Output ONLY valid complete JSON — no truncation, no explanation

Output format (complete JSON required):
{"paragraphs":[{"en":"English text","ja":"日本語訳","start":0.5,"end":3.2}]}"""


def _repair_json(raw: str) -> str:
    """Try to salvage a truncated JSON string by extracting complete paragraph objects."""
    cleaned = _extract_json(raw)

    # Step 1: Try to parse as-is first
    try:
        json.loads(cleaned)
        return cleaned
    except json.JSONDecodeError:
        pass

    # Step 2: Try closing unclosed JSON — most common truncation is missing ]}
    for suffix in (']}', '"]}', '"}]}'):
        try:
            candidate = cleaned + suffix
            json.loads(candidate)
            logger.debug(f"JSON repaired by appending '{suffix}'")
            return candidate
        except json.JSONDecodeError:
            pass

    # Step 3: Extract individual paragraph objects that are complete via regex
    pattern = re.compile(
        r'\{[^{}]*"en"\s*:\s*"[^"]*"[^{}]*"ja"\s*:\s*"[^"]*"[^{}]*"start"\s*:[^,}]+[^{}]*"end"\s*:[^,}]+\}',
        re.DOTALL,
    )
    items = pattern.findall(cleaned)
    valid = []
    for item in items:
        try:
            json.loads(item)
            valid.append(item)
        except json.JSONDecodeError:
            pass

    if valid:
        logger.warning(f"JSON truncated; recovered {len(valid)} paragraph(s) via regex")
        return '{"paragraphs":[' + ",".join(valid) + "]}"

    raise ValueError(f"JSON completely unparseable after repair attempt. First 200 chars: {cleaned[:200]}")


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


def _llm_chunk_and_translate(
    transcript: list, ollama_url: str, model: str,
    runpod_url: str = "", runpod_api_key: str = "",
) -> list:
    # 10 entries per window: smaller windows → fewer output paragraphs → less truncation risk
    WINDOW = 10
    windows = [transcript[i:i+WINDOW] for i in range(0, len(transcript), WINDOW)]
    all_paras: list = []
    failed_windows: list = []
    use_runpod = bool(runpod_url and runpod_api_key)

    for wi, window in enumerate(windows):
        # Worst case: 1 paragraph per entry → window × ~120 tokens/para + 512 overhead
        # num_ctx=4096 ensures input(~600tok)+output fit within model's context window
        num_predict = min(4096, len(window) * 200 + 512)
        user_content = json.dumps(window, ensure_ascii=False)
        messages = [
            {"role": "system", "content": CHUNK_TRANSLATE_SYSTEM},
            {"role": "user",   "content": f"Segment and translate these {len(window)} entries:\n{user_content}"},
        ]
        try:
            if use_runpod:
                raw = _runpod_chat(messages, runpod_url, runpod_api_key, num_predict)
            else:
                raw = _ollama_chat(messages, ollama_url, model, num_predict)
            repaired = _repair_json(raw)
            parsed = json.loads(repaired)
            paras = parsed.get("paragraphs", [])
            if paras:
                all_paras.extend(paras)
                logger.info(f"Window {wi+1}/{len(windows)}: {len(paras)} paragraphs OK")
            else:
                logger.warning(f"Window {wi+1}: LLM returned empty paragraphs, using fallback")
                failed_windows.append(window)
        except Exception as e:
            logger.warning(f"Window {wi+1} LLM failed ({e}), will use fallback")
            failed_windows.append(window)

    # Fallback: simple chunking for any failed windows
    if failed_windows:
        flat = [entry for w in failed_windows for entry in w]
        fallback_paras = _simple_chunk_transcript(flat)
        logger.warning(f"Fallback produced {len(fallback_paras)} paragraphs for {len(failed_windows)} failed window(s)")
        all_paras.extend(fallback_paras)

    # Sort by start time (windows may have added out-of-order due to fallback)
    all_paras.sort(key=lambda p: float(p.get("start", 0)))

    if not all_paras:
        raise RuntimeError("すべての窓でチャンク処理に失敗しました。字幕データを確認してください。")

    return all_paras


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


def _runpod_chat(messages: list, endpoint_url: str, api_key: str, max_tokens: int) -> str:
    """RunPod Serverless /runsync を呼び出す（vLLM ハンドラ想定）。
    レスポンスは OpenAI 互換 choices フォーマットを期待。"""
    resp = http_requests.post(
        endpoint_url,
        headers={"Authorization": f"Bearer {api_key}"},
        json={
            "input": {
                "messages":   messages,
                "max_tokens": max_tokens,
                "temperature": 0,
            }
        },
        timeout=300,
    )
    resp.raise_for_status()
    data = resp.json()
    # RunPod runsync: {"status":"COMPLETED","output":{...openai-like...}}
    if data.get("status") not in ("COMPLETED", None):
        raise RuntimeError(f"RunPod status={data.get('status')}: {data.get('error','')}")
    output = data.get("output", data)
    if isinstance(output, dict):
        choices = output.get("choices", [])
        if choices:
            return choices[0]["message"]["content"]
        if isinstance(output.get("text"), str):
            return output["text"]
    if isinstance(output, str):
        return output
    raise RuntimeError(f"RunPod: unexpected output format: {str(output)[:300]}")


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
        yield send({"type": "progress", "stage": "download", "pct": 5,
                    "msg": "動画のダウンロードと字幕取得を並列実行中..."})

        dl_future  = loop.run_in_executor(None, _download_video, request.url, ydl_opts)
        sub_future = loop.run_in_executor(None, _get_transcript, video_id)
        # return_exceptions=True: 片方が失敗してももう一方をキャンセルしない
        dl_result, sub_result = await asyncio.gather(
            dl_future, sub_future, return_exceptions=True
        )

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

        # ── Stage 3a: Chunk & translate（翻訳モデル） ──────────────────────
        _use_runpod = bool(request.runpod_url and request.runpod_api_key)
        _llm_label  = "RunPod" if _use_runpod else translate_model
        yield send({"type": "progress", "stage": "llm", "pct": 25,
                    "msg": f"日本語訳を生成中（{_llm_label}）..."})
        try:
            paragraphs_raw = await loop.run_in_executor(
                None, _llm_chunk_and_translate,
                transcript, request.ollama_url, translate_model,
                request.runpod_url, request.runpod_api_key,
            )
        except Exception as e:
            yield send({"type": "error", "stage": "llm",
                        "msg": f"チャンク・翻訳処理に失敗: {str(e)[:300]}"})
            return

        # 翻訳完了時点で data.md を先に保存（注釈が遅くても対訳は手に入る）
        try:
            with open(os.path.join(output_dir, "data.md"), "w", encoding="utf-8") as f:
                f.write(build_data_md(video_id, paragraphs_raw))
            yield send({"type": "progress", "stage": "llm", "pct": 85,
                        "msg": f"対訳mdを保存（{len(paragraphs_raw)}段落）。発音アノテーションへ..."})
        except Exception:
            pass

        # ── Stage 3b: ルールベースアノテーション（即時完了・LLM不要） ────────
        # GA ルール（機能語/強勢/弱化/消音/イントネーション）を Python で適用。
        # LLM ループ（N段落 × 5〜15秒）を完全に置き換える。
        yield send({"type": "progress", "stage": "llm", "pct": 88,
                    "msg": f"発音アノテーションを生成中（ルールベース・{len(paragraphs_raw)}段落）..."})
        paras = [_rule_annotate_para(p, i) for i, p in enumerate(paragraphs_raw)]

        # ── Stage 4: Save files ───────────────────────────────────────────
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
