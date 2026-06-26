// app/api/check/route.js
// 모바일 통합검색(m.search.naver.com) 페이지를 직접 긁어서
//  1) "네이버 가격비교" 블록이 실제로 렌더됐는지 (= shp_tli 컨테이너 존재)
//  2) 내 nvMid 상품이 그 블록 안에 있는지 + 광고 제외 N등(기본 4) 이내인지
//
// 핵심: 블록 판별은 data-slog-container="shp_tli" 존재로만 한다.
//       텍스트 "네이버 가격비교"는 블록이 없는 페이지에도 JSON 데이터
//       ("source":"네이버 가격비교") 로 박혀 있어서 오탐난다 -> 신호로 쓰지 않음.

import { request, getGlobalDispatcher, interceptors } from "undici";

export const runtime = "nodejs";
export const maxDuration = 30;

// undici v6: request 옵션의 maxRedirections 미지원 -> redirect 인터셉터 사용
const redirectDispatcher = getGlobalDispatcher().compose(
  interceptors.redirect({ maxRedirections: 3 })
);

// 블록 자체가 비어 보일 만큼 HTML이 짧으면 차단(캡차) 의심
const MIN_HTML_LEN = 50_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function clean(s) {
  if (!s) return "";
  return s
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function browserHeaders() {
  return {
    "user-agent":
      "Mozilla/5.0 (Linux; Android 14; SM-S918N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36",
    accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
    "accept-language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7",
    "accept-encoding": "gzip, deflate, br",
    "cache-control": "max-age=0",
    referer: "https://m.naver.com/",
    "sec-ch-ua": '"Chromium";v="126", "Not.A/Brand";v="24", "Google Chrome";v="126"',
    "sec-ch-ua-mobile": "?1",
    "sec-ch-ua-platform": '"Android"',
    "sec-fetch-dest": "document",
    "sec-fetch-mode": "navigate",
    "sec-fetch-site": "same-site",
    "sec-fetch-user": "?1",
    "upgrade-insecure-requests": "1",
  };
}

// shp_tli 블록 영역(<section ... data-slog-container="shp_tli"> ... </section>)만 잘라낸다
function sliceBlock(html) {
  const at = html.indexOf('data-slog-container="shp_tli"');
  if (at === -1) return null;
  const start = html.lastIndexOf("<section", at);
  const from = start === -1 ? at : start;
  // 다음 </section> 까지 (넉넉히 자름 — 카드 파싱용)
  const end = html.indexOf("</section>", at);
  return html.slice(from, end === -1 ? from + 400_000 : end + 10);
}

// 블록 안의 카드들을 문서 순서대로 파싱
// 카드 경계: data-slog-content="shp_tli:{slot}"
function parseCards(blockHtml) {
  const cards = [];
  const re = /data-slog-content="shp_tli:([^"]+)"/g;
  let m;
  const idxs = [];
  while ((m = re.exec(blockHtml)) !== null) idxs.push({ slot: m[1], at: m.index });
  for (let i = 0; i < idxs.length; i++) {
    const seg = blockHtml.slice(idxs[i].at, idxs[i + 1] ? idxs[i + 1].at : blockHtml.length);
    const slot = idxs[i].slot;
    // nvMid: view_type_guide_{nvMid} 가 가장 안정적, 없으면 nv_mid=
    let nvMid = (seg.match(/view_type_guide_(\d+)/) || [])[1] ||
                (seg.match(/nv_mid=(\d+)/) || [])[1] || null;
    const isAd = slot.startsWith("nad-") || /ader\.naver\.com/.test(seg) || />광고</.test(seg);
    const mall = clean((seg.match(/class="PtxugWXH"[^>]*>([^<]+)</) || [])[1] || "");
    const price = (seg.match(/class="mjquFHz_"[^>]*>([\d,]+)</) || [])[1] || "";
    cards.push({ nvMid, isAd, mall, price });
  }
  return cards;
}

async function fetchSerp(keyword, cookie) {
  const url =
    "https://m.search.naver.com/search.naver?where=m&sm=mtp_hty.top&query=" +
    encodeURIComponent(keyword);
  const headers = browserHeaders();
  if (cookie) headers.cookie = cookie;
  const res = await request(url, {
    method: "GET",
    headers,
    dispatcher: redirectDispatcher,
  });
  const html = await res.body.text();
  return { status: res.statusCode, html };
}

export async function POST(req) {
  try {
    const body = await req.json();
    const keyword = (body.keyword || "").trim();
    const targetMid = (body.targetMid || "").toString().trim();
    const debug = body.debug === true;
    let cut = parseInt(body.cut, 10) || 4;             // 노출 인정 등수 (기본 4)
    cut = Math.min(Math.max(cut, 1), 50);
    const adExclude = body.adExclude !== false;        // 기본 true: 광고 제외하고 순위
    const cookie = (body.cookie || process.env.NAVER_COOKIE || "").trim();

    if (!keyword) return Response.json({ error: "키워드가 비어 있습니다." }, { status: 400 });

    let attempt;
    for (let t = 0; t < 2; t++) {
      attempt = await fetchSerp(keyword, cookie);
      if (attempt.status === 200 && attempt.html.length >= MIN_HTML_LEN) break;
      await sleep(500);
    }
    const { status, html } = attempt;

    // 차단/캡차 의심
    if (status !== 200 || html.length < MIN_HTML_LEN) {
      return Response.json({
        keyword, status, htmlLen: html.length,
        blocked: true,
        error: `차단 의심 (status ${status}, ${Math.round(html.length / 1024)}KB). 쿠키 붙이거나 잠시 후 재시도.`,
        ...(debug ? { htmlSample: html } : {}),
      });
    }

    // 진단용: raw HTML에 어떤 후보 신호가 있는지 (블록 판별은 shp_tli로만)
    const signals = {
      shpTli: html.includes('data-slog-container="shp_tli"'),
      textPriceCompare: html.includes("네이버 가격비교"),
      otherSiteLink: html.includes("다른 사이트"),
      shoppingApi: /cr\d?\.shopping\.naver\.com|msearch\.shopping\.naver\.com/.test(html),
    };

    // ★ 블록 판별: shp_tli 컨테이너 존재 여부 (텍스트 매칭 X)
    const blockHtml = sliceBlock(html);
    const hasBlock = blockHtml !== null;

    let cards = [], myRank = null, myOrganicRank = null, myItem = null;
    if (hasBlock) {
      cards = parseCards(blockHtml);
      let organic = 0;
      for (let i = 0; i < cards.length; i++) {
        const c = cards[i];
        if (!c.isAd) organic++;
        if (targetMid && c.nvMid === targetMid) {
          myRank = i + 1;                 // 광고 포함 raw 순위
          myOrganicRank = c.isAd ? null : organic; // 광고 제외 순위
          myItem = c;
          break;
        }
      }
    }

    const rankForCut = adExclude ? myOrganicRank : myRank;
    const myWithinCut = rankForCut !== null && rankForCut <= cut;

    return Response.json({
      keyword,
      status,
      htmlLen: html.length,
      blocked: false,
      hasBlock,
      cardCount: cards.length,
      adCount: cards.filter((c) => c.isAd).length,
      targetMid: targetMid || null,
      cut,
      adExclude,
      myFound: myRank !== null,
      myRank,
      myOrganicRank,
      myWithinCut,
      myItem,
      signals,
      ...(debug ? { htmlSample: html } : {}),
    });
  } catch (e) {
    return Response.json({ error: e?.message || "알 수 없는 오류" }, { status: 500 });
  }
}
