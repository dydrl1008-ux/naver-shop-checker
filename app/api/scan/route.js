// app/api/scan/route.js
// 네이버 통합검색(통검) 페이지를 직접 fetch 해서
//  1) "네이버 가격비교" 블록이 실제 렌더되는지 (HTML 마크업 탐지)
//  2) 내 nvMid가 그 블록/페이지에 있는지 + 블록 내 대략 위치
//  3) 차단/캡차 여부
// 로그인은 세션 쿠키(헤더)로 처리. 헤더는 실제 크롬 요청 기준으로 풀세팅.

import { fetch as uFetch, ProxyAgent } from "undici";

export const runtime = "nodejs";
export const maxDuration = 30;

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";

const BLOCK_SIGNALS = ["네이버 가격비교", "다른 사이트 더보기", "다른 사이트를 보시려면"];
// 실제 차단 페이지에만 나오는 강한 시그널 (정상 SERP엔 없음)
const BLOCK_DENY = ["/sorry/unauth", "비정상적인 검색이 감지"];

function buildUrl(keyword, source) {
  const q = encodeURIComponent(keyword);
  if (source === "mobile")
    return `https://m.search.naver.com/search.naver?sm=mtp_hty.top&where=m&query=${q}`;
  return `https://search.naver.com/search.naver?where=nexearch&sm=top_hty&fbm=1&ie=utf8&query=${q}`;
}

// 실제 크롬이 보내는 헤더 풀세팅 (차단 완화)
function buildHeaders(source, cookie) {
  const h = {
    "User-Agent": UA,
    accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
    "accept-language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7",
    priority: "u=0, i",
    referer: source === "mobile" ? "https://m.naver.com/" : "https://www.naver.com/",
    "sec-ch-ua": '"Google Chrome";v="149", "Chromium";v="149", "Not)A;Brand";v="24"',
    "sec-ch-ua-arch": '"x86"',
    "sec-ch-ua-bitness": '"64"',
    "sec-ch-ua-form-factors": '"Desktop"',
    "sec-ch-ua-full-version-list":
      '"Google Chrome";v="149.0.7827.200", "Chromium";v="149.0.7827.200", "Not)A;Brand";v="24.0.0.0"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-model": '""',
    "sec-ch-ua-platform": '"Windows"',
    "sec-ch-ua-platform-version": '"19.0.0"',
    "sec-ch-ua-wow64": "?0",
    "sec-fetch-dest": "document",
    "sec-fetch-mode": "navigate",
    "sec-fetch-site": source === "mobile" ? "same-site" : "same-origin",
    "sec-fetch-user": "?1",
    "upgrade-insecure-requests": "1",
  };
  if (cookie) h["Cookie"] = cookie;
  return h;
}

function sliceBlock(html) {
  const i = html.indexOf("네이버 가격비교");
  if (i < 0) return null;
  return html.slice(Math.max(0, i - 2000), Math.min(html.length, i + 30000));
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
    // 정상 통검 SERP는 보통 200KB+ . 차단/캡차/sorry 페이지는 수십KB 이하.
    const looksBlocked = status === 302 || status === 429 || htmlLen < 50000 || denyHit.length > 0;
    if (looksBlocked) {
      return Response.json({
        keyword, source, status, htmlLen, blocked: true,
        blockedReason:
          status === 302 ? "리다이렉트(차단 의심)" :
          status === 429 ? "요청 과다(429)" :
          denyHit.length ? `차단 시그널: ${denyHit.join(", ")}` :
          "응답 비정상(HTML 너무 짧음 <50KB)",
        note: cookie ? "쿠키 넣어도 막힘 → 프록시/상시서버 권장" : "쿠키 없이 막힘 → 로그인 쿠키 또는 프록시 시도",
      });
    }

    const matched = BLOCK_SIGNALS.filter((s) => html.includes(s));
    const blockFound = matched.includes("네이버 가격비교");

    let myInBlock = false, myPosInBlock = null, myOnPage = false;
    if (targetMid) {
      myOnPage = html.includes(targetMid);
      const region = sliceBlock(html);
      if (region) {
        const idx = extractIds(region).indexOf(targetMid);
        if (idx >= 0) { myInBlock = true; myPosInBlock = idx + 1; }
      }
    }
    const myWithinCut = myPosInBlock !== null && myPosInBlock <= cut;

    return Response.json({
      keyword, source, status, htmlLen, blocked: false,
      blockFound, matchedSignals: matched,
      myOnPage, myInBlock, myPosInBlock, myWithinCut, cut,
    });
  } catch (e) {
    return Response.json({ error: e?.message || "알 수 없는 오류" }, { status: 500 });
  }
}
