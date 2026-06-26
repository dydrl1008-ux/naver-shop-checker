// app/api/scan/route.js
// 네이버 통합검색(통검) 페이지를 직접 fetch 해서
//  1) "네이버 가격비교" 블록이 실제 렌더되는지 (HTML 마크업 탐지)
//  2) 내 nvMid가 그 블록/페이지에 있는지 + 블록 내 대략 위치
//  3) 차단/캡차 여부
// 를 판별한다. 로그인은 세션 쿠키(헤더)로 처리. 비번 자동화 안 함.

import { fetch as uFetch, ProxyAgent } from "undici";

export const runtime = "nodejs";
export const maxDuration = 30;

const UA_PC =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const UA_M =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";

// 가격비교 블록이 떴을 때 통검 HTML에 나타나는 후보 시그널들
const BLOCK_SIGNALS = [
  "네이버 가격비교",
  "다른 사이트 더보기",
  "다른 사이트를 보시려면",
];
// 차단/캡차 시그널
const BLOCK_DENY = ["자동등록방지", "비정상적인 검색", "/sorry/", "captcha", "robot"];

function buildUrl(keyword, source) {
  const q = encodeURIComponent(keyword);
  if (source === "mobile")
    return `https://m.search.naver.com/search.naver?where=m&sm=mtp_hty.top&query=${q}`;
  return `https://search.naver.com/search.naver?where=nexearch&sm=top_hty&fbm=1&ie=utf8&query=${q}`;
}

// 블록 영역만 잘라내기 (가능하면). 못 자르면 전체 반환.
function sliceBlock(html) {
  const i = html.indexOf("네이버 가격비교");
  if (i < 0) return null;
  // 블록 제목 앞쪽 컨테이너 ~ 다음 섹션 사이를 넉넉히 자름
  const start = Math.max(0, i - 2000);
  const end = Math.min(html.length, i + 30000);
  return html.slice(start, end);
}

// 블록 영역에서 상품/카탈로그 id들을 등장 순서대로 추출
function extractIds(region) {
  const ids = [];
  const seen = new Set();
  // nvMid=123, /catalog/123, /products/123, "id":"123" 등 폭넓게
  const re = /(?:nvMid=|\/catalog\/|\/products\/|productId["':\s=]+["']?)(\d{6,})/g;
  let m;
  while ((m = re.exec(region)) !== null) {
    const id = m[1];
    if (!seen.has(id)) { seen.add(id); ids.push(id); }
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
    const headers = {
      "User-Agent": source === "mobile" ? UA_M : UA_PC,
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
      "Accept-Language": "ko-KR,ko;q=0.9,en;q=0.8",
      "Cache-Control": "no-cache",
      Referer: "https://www.naver.com/",
    };
    if (cookie) headers["Cookie"] = cookie;

    const opts = { headers, redirect: "manual" };
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

    // 차단/캡차 감지
    const denyHit = BLOCK_DENY.filter((s) => html.includes(s));
    const looksBlocked =
      status === 302 || status === 429 || htmlLen < 3000 || denyHit.length > 0;

    if (looksBlocked) {
      return Response.json({
        keyword, source, status, htmlLen,
        blocked: true,
        blockedReason:
          status === 302 ? "리다이렉트(차단 의심)" :
          status === 429 ? "요청 과다(429)" :
          denyHit.length ? `차단 시그널: ${denyHit.join(", ")}` :
          "응답 비정상(HTML 너무 짧음)",
        note: cookie ? "쿠키 넣어도 막힘 → 프록시/상시서버 권장" : "쿠키 없이 막힘 → 로그인 쿠키 또는 프록시 필요",
      });
    }

    // 1) 가격비교 블록 탐지
    const matched = BLOCK_SIGNALS.filter((s) => html.includes(s));
    const blockFound = matched.includes("네이버 가격비교");

    // 2) 내 nvMid 위치 (블록 영역 우선, 없으면 전체에서 존재 여부)
    let myInBlock = false, myPosInBlock = null, myOnPage = false;
    if (targetMid) {
      myOnPage = html.includes(targetMid);
      const region = sliceBlock(html);
      if (region) {
        const ids = extractIds(region);
        const idx = ids.indexOf(targetMid);
        if (idx >= 0) { myInBlock = true; myPosInBlock = idx + 1; }
      }
    }
    const myWithinCut = myPosInBlock !== null && myPosInBlock <= cut;

    return Response.json({
      keyword, source, status, htmlLen,
      blocked: false,
      blockFound,            // 가격비교 블록 떴는지 (실제 통검 HTML 기준)
      matchedSignals: matched,
      myOnPage,              // 페이지 어딘가에 내 nvMid 있는지
      myInBlock,             // 가격비교 블록 안에 있는지
      myPosInBlock,          // 블록 내 대략 위치(추출 순서 기준, best-effort)
      myWithinCut,           // cut 등 이내인지
      cut,
    });
  } catch (e) {
    return Response.json({ error: e?.message || "알 수 없는 오류" }, { status: 500 });
  }
}
