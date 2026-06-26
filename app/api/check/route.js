// app/api/check/route.js
// 키워드 1개 -> 네이버 쇼핑 검색 API(organic, 광고 미포함)
//  1) 가격비교 블록 뜨는 키워드인지 (= 검색 최상단에 가격비교 카탈로그가 있는지)
//  2) 내 nvMid 상품이 광고 제외 자연순위 N등 이내인지 (기본 4등)

export const runtime = "nodejs";
export const maxDuration = 30;

// 가격비교 "카탈로그" 상품군 (productType 공식 매핑)
//  1: 일반-가격비교, 4: 중고-가격비교, 7: 단종-가격비교, 10: 판매예정-가격비교
const CATALOG_TYPES = new Set(["1", "4", "7", "10"]);
const BLOCK_WINDOW = 10; // 가격비교 블록 판별용 상단 구간

const TYPE_LABEL = {
  "1": "가격비교",      "2": "일반(단독)",   "3": "가격비교매칭",
  "4": "중고-가격비교", "5": "중고(단독)",   "6": "중고-매칭",
  "7": "단종-가격비교", "8": "단종(단독)",   "9": "단종-매칭",
  "10": "예정-가격비교","11": "예정(단독)",  "12": "예정-매칭",
};

function clean(s) {
  if (!s) return "";
  return s.replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function POST(req) {
  try {
    const body = await req.json();
    const keyword = (body.keyword || "").trim();
    const targetMid = (body.targetMid || "").toString().trim();
    let maxResults = parseInt(body.maxResults, 10) || 100;
    maxResults = Math.min(Math.max(maxResults, 40), 1000);
    let cut = parseInt(body.cut, 10) || 4;          // 노출 인정 등수 (기본 4등)
    cut = Math.min(Math.max(cut, 1), 100);

    const clientId = process.env.NAVER_CLIENT_ID;
    const clientSecret = process.env.NAVER_CLIENT_SECRET;
    if (!clientId || !clientSecret)
      return Response.json({ error: "NAVER_CLIENT_ID / NAVER_CLIENT_SECRET 환경변수가 없습니다." }, { status: 500 });
    if (!keyword) return Response.json({ error: "키워드가 비어 있습니다." }, { status: 400 });

    const pages = Math.ceil(maxResults / 100);
    let items = [];
    let total = 0;

    for (let p = 0; p < pages; p++) {
      const start = p * 100 + 1;
      if (start > 1000) break;
      const url = "https://openapi.naver.com/v1/search/shop.json" +
        `?query=${encodeURIComponent(keyword)}&display=100&start=${start}&sort=sim`;
      const res = await fetch(url, {
        headers: { "X-Naver-Client-Id": clientId, "X-Naver-Client-Secret": clientSecret },
        cache: "no-store",
      });
      if (!res.ok) {
        const txt = await res.text().catch(() => "");
        return Response.json({ error: `네이버 API 오류 (${res.status}) ${txt.slice(0, 160)}` }, { status: 502 });
      }
      const data = await res.json();
      total = Number(data.total) || total;
      const batch = data.items || [];
      items = items.concat(batch);
      if (batch.length < 100) break;
      if (p < pages - 1) await sleep(80);
    }

    // 1) 가격비교 블록 유무 — 상단 BLOCK_WINDOW 안에 카탈로그가 있는지
    const blockTop = items.slice(0, BLOCK_WINDOW);
    const catalogInBlock = blockTop.filter((it) => CATALOG_TYPES.has(String(it.productType))).length;
    const top1IsCatalog = items.length > 0 && CATALOG_TYPES.has(String(items[0].productType));
    const hasPriceComparison = catalogInBlock > 0;

    // 2) 내 nvMid 순위 (광고 제외 자연순위) + cut 등 이내인지
    let myRank = null, myItem = null;
    if (targetMid) {
      const idx = items.findIndex((it) => String(it.productId) === targetMid);
      if (idx >= 0) {
        const it = items[idx];
        myRank = idx + 1;
        myItem = {
          title: clean(it.title),
          mallName: it.mallName || "",
          lprice: it.lprice || "",
          productType: String(it.productType),
          productTypeLabel: TYPE_LABEL[String(it.productType)] || it.productType,
          link: it.link || "",
        };
      }
    }
    const myWithinCut = myRank !== null && myRank <= cut;

    return Response.json({
      keyword, targetMid: targetMid || null, total, fetched: items.length,
      cut, blockWindow: BLOCK_WINDOW,
      hasPriceComparison, top1IsCatalog, catalogInBlock,
      myFound: myRank !== null, myRank, myWithinCut, myItem,
    });
  } catch (e) {
    return Response.json({ error: e?.message || "알 수 없는 오류" }, { status: 500 });
  }
}
