// app/api/proxies/route.js
// 여러 무료 프록시 소스를 긁어서 합치고 중복 제거해서 돌려준다.
// (HTTP 프록시만 수집 — undici ProxyAgent가 SOCKS는 못 씀)

export const runtime = "nodejs";
export const maxDuration = 30;

const SOURCES = [
  "https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt",
  "https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/protocols/http/data.txt",
  "https://raw.githubusercontent.com/vakhov/fresh-proxy-list/master/http.txt",
  "https://raw.githubusercontent.com/vakhov/fresh-proxy-list/master/https.txt",
  "https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt",
  "https://raw.githubusercontent.com/zloi-user/hideip.me/main/http.txt",
  "https://raw.githubusercontent.com/zloi-user/hideip.me/main/https.txt",
  "https://raw.githubusercontent.com/iplocate/free-proxy-list/main/protocols/http.txt",
  "https://raw.githubusercontent.com/iplocate/free-proxy-list/main/protocols/https.txt",
  "https://raw.githubusercontent.com/sunny9577/proxy-scraper/master/proxies.txt",
  "https://raw.githubusercontent.com/mmpx12/proxy-list/master/http.txt",
  "https://raw.githubusercontent.com/mmpx12/proxy-list/master/https.txt",
  "https://raw.githubusercontent.com/ErcinDedeoglu/proxies/main/proxies/http.txt",
  "https://raw.githubusercontent.com/ErcinDedeoglu/proxies/main/proxies/https.txt",
  "https://raw.githubusercontent.com/roosterkid/openproxylist/main/HTTPS_RAW.txt",
  "https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/protocols/https/data.txt",
  "https://raw.githubusercontent.com/yuceltoluyag/GoodProxy/main/raw.txt",
  "https://raw.githubusercontent.com/databay-labs/free-proxy-list/master/http.txt",
  "https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&protocol=http&proxy_format=ipport&format=text",
  "https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&protocol=https&proxy_format=ipport&format=text",
  "https://www.proxy-list.download/api/v1/get?type=http",
  "https://www.proxy-list.download/api/v1/get?type=https",
  "https://proxyspace.pro/http.txt",
  "https://proxyspace.pro/https.txt",
];

const IPPORT = /(?:^|[^\d])(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}):(\d{2,5})/g;

async function fetchSource(url) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 9000);
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { "user-agent": "Mozilla/5.0", accept: "text/plain,*/*" },
    });
    clearTimeout(t);
    if (!res.ok) return [];
    const text = await res.text();
    const out = [];
    let m;
    IPPORT.lastIndex = 0;
    while ((m = IPPORT.exec(text)) !== null) {
      const ip = m[1];
      const port = m[2];
      // 사설망/유효성 대충 거르기
      if (Number(port) > 0 && Number(port) <= 65535) out.push(`${ip}:${port}`);
    }
    return out;
  } catch {
    return [];
  }
}

export async function POST() {
  try {
    const results = await Promise.all(SOURCES.map(fetchSource));
    const counts = {};
    const set = new Set();
    SOURCES.forEach((src, i) => {
      counts[src] = results[i].length;
      results[i].forEach((p) => set.add(p));
    });
    const proxies = [...set];
    return Response.json({
      total: proxies.length,
      sources: SOURCES.length,
      perSource: counts,
      proxies: proxies.slice(0, 20000), // 너무 크면 자름
    });
  } catch (e) {
    return Response.json({ error: e?.message || "수집 실패" }, { status: 500 });
  }
}
