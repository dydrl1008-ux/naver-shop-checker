// app/api/scan/route.js
// 통검 페이지 직접 fetch → "네이버 가격비교" 블록 실제 렌더 여부 + nvMid 위치 + 차단 판정
import { fetch as uFetch, ProxyAgent } from "undici";

export const runtime = "nodejs";
export const maxDuration = 30;

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";
const BLOCK_DENY = ["/sorry/unauth", "비정상적인 검색이 감지"];

function buildUrl(keyword, source) {
  const q = encodeURIComponent(keyword);
  if (source === "mobile")
    return `https://m.search.naver.com/search.naver?sm=mtp_hty.top&where=m&query=${q}`;
  return `https://search.naver.com/search.naver?where=nexearch&sm=top_hty&fbm=1&ie=utf8&query=${q}`;
}

function buildHeaders(source, cookie) {
  const h = {
    "User-Agent": UA,
    accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
    "accept-language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7",
    priority: "u=0, i",
    referer: source === "mobile" ? "https://m.naver.com/" : "https://www.naver.com/",
    "sec-ch-ua": '"Google Chrome";v="149", "Chromium";v="149", "Not)A;Brand";v="24"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
    "sec-fetch-dest": "document",
    "sec-fetch-mode": "navigate",
    "sec-fetch-site": source === "mobile" ? "same-site" : "same-origin",
    "sec-fetch-user": "?1",
    "upgrade-insecure-requests": "1",
  };
  if (cookie) h["Cookie"] = cookie;
  return h;
}

// 진짜 가격비교 블록 판정:
//  "네이버 가격비교" 제목 바로 뒤(900자 이내)에 "다른 사이트" CTA가 붙어있어야 인정.
//  (스크립트/링크에 박힌 단독 문자열은 오탐이라 제외)
function detectBlock(html) {
  const TITLE = "네이버 가격비교";
  let idx = html.indexOf(TITLE);
  let titleHits = 0, at = -1, cta = false, tab = false;
  while (idx !== -1) {
    titleHits++;
    if (at === -1) {
      const win = html.slice(idx, idx + 3000);          // 제목 뒤 3000자
      const c = win.includes("다른 사이트");             // CTA
      const t = win.includes("키워드추천");              // 이 블록에만 있는 탭
      if (c || t) { at = idx; cta = c; tab = t; }
    }
    idx = html.indexOf(TITLE, idx + 1);
  }
  return { found: at !== -1, at, titleHits, cta, tab };
}

function extractIds(region) {
  const ids = [];
  const seen = new Set();
  const re = /(?:nvMid=|\/catalog\/|\/products\/|productId["':\s=]+["']?)(\d{6,})/g;
  let m;
  while ((m = re.exec(region)) !== null) {
    if (!seen.has(m[1])) { seen.add(m[1]); ids.push(m[1]); }
  }
  return ids;
}

export async function POST(req) {
  try {
    const body = await req.json();
    const keyword = (body.keyword || "").trim();
    const targetMid = (body.targetMid || "").toString().trim();
    const source = body.source === "mobile" ? "mobile" : "pc";
    const cookie = (body.cookie || "").trim();
    const proxy = (body.proxy || "").trim();
    const cut = Math.min(Math.max(parseInt(body.cut, 10) || 4, 1), 50);
    if (!keyword) return Response.json({ error: "키워드가 비어 있습니다." }, { status: 400 });

    const url = buildUrl(keyword, source);
    const opts = { headers: buildHeaders(source, cookie), redirect: "manual" };
    if (proxy) {
      try { opts.dispatcher = new ProxyAgent(proxy); }
      catch (e) { return Response.json({ error: `프록시 설정 오류: ${e.message}` }, { status: 400 }); }
    }

    let res, html, status;
    try {
      res = await uFetch(url, opts);
      status = res.status;
      html = await res.text();
    } catch (e) {
      return Response.json({ keyword, error: `요청 실패: ${e.message}` }, { status: 502 });
    }
    const htmlLen = html.length;

    const denyHit = BLOCK_DENY.filter((s) => html.includes(s));
    const looksBlocked = status === 302 || status === 429 || htmlLen < 15000 || denyHit.length > 0;
    if (looksBlocked) {
      return Response.json({
        keyword, source, status, htmlLen, blocked: true,
        blockedReason:
          status === 302 ? "리다이렉트(차단 의심)" :
          status === 429 ? "요청 과다(429)" :
          denyHit.length ? `차단 시그널: ${denyHit.join(", ")}` :
          "응답 비정상(HTML <15KB)",
        note: cookie ? "쿠키 넣어도 막힘 → 프록시/상시서버" : "쿠키 없이 막힘 → 쿠키/프록시 시도",
      });
    }

    // 블록 판정 (제목 + CTA/키워드추천 근접)
    const det = detectBlock(html);
    const blockFound = det.found;
    const matchedSignals = [];
    if (det.titleHits) matchedSignals.push(`제목x${det.titleHits}`);
    if (det.cta) matchedSignals.push("CTA");
    if (det.tab) matchedSignals.push("키워드추천");
    if (det.titleHits && !blockFound) matchedSignals.push("근접X");

    // nvMid 위치
    let myInBlock = false, myPosInBlock = null, myOnPage = false;
    if (targetMid) {
      myOnPage = html.includes(targetMid);
      if (det.at >= 0) {
        const region = html.slice(Math.max(0, det.at - 1000), det.at + 30000);
        const i = extractIds(region).indexOf(targetMid);
        if (i >= 0) { myInBlock = true; myPosInBlock = i + 1; }
      }
    }
    const myWithinCut = myPosInBlock !== null && myPosInBlock <= cut;

    return Response.json({
      keyword, source, status, htmlLen, blocked: false,
      blockFound, matchedSignals, titleHits: det.titleHits,
      myOnPage, myInBlock, myPosInBlock, myWithinCut, cut,
    });
  } catch (e) {
    return Response.json({ error: e?.message || "알 수 없는 오류" }, { status: 500 });
  }
}
