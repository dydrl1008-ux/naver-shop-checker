# 네이버 통검 가격비교 블록 직접 체커

통합검색(통검) 페이지를 **직접 긁어서** "네이버 가격비교" 블록이 실제로 뜨는지 + 내 nvMid 상품이 그 안에 있는지 확인하는 Next.js 앱.

## 두 가지 엔드포인트
- `/api/scan` (메인): 통검 페이지 직접 fetch → 가격비교 블록 마크업 탐지(추정 아님) + nvMid 위치 + 차단 감지
- `/api/check` (보조): 쇼핑검색 openapi → 광고 제외 자연순위 (정확한 순위가 필요할 때)

## 로그인 = 세션 쿠키 방식 (비번 자동화 X)
네이버 로그인은 비번 RSA 암호화 + 캡차 + 기기인증이라 서버 자동 로그인은 거의 막힌다.
대신 **로그인된 브라우저의 세션 쿠키**를 한 번 따서 넣는다:
1. 로그인된 크롬에서 F12 → Network → `search.naver` 요청 클릭
2. Request Headers의 `Cookie:` 값 통째로 복사
3. 앱의 "네이버 세션 쿠키" 칸에 붙여넣기

※ 블록 유무/순위는 **로그아웃 상태로도 보이므로 쿠키는 선택**이다.

## 차단 대응 (중요)
네이버는 데이터센터 IP를 잘 막는다. **Vercel 기본 IP로는 차단/캡차가 잦다.**
- "프록시 URL" 칸에 프록시 넣으면 경유 (`http://user:pass@host:port`)
- 그래도 막히면 **상시 서버(예: 기존 serve.py 박스)에서 실행** 권장. 이 코드는 Node면 어디서든 돈다.
- 결과의 `차단` / `htmlLen` 비정상값으로 차단 여부 즉시 확인 가능

## 실행
```bash
npm install
npm run dev            # http://localhost:3000
```
openapi 보조 기능 쓰려면 `.env.local`에 `NAVER_CLIENT_ID`, `NAVER_CLIENT_SECRET` (스크래핑만 쓸 거면 불필요).

## Vercel 배포
```bash
npm i -g vercel
vercel --prod
```
(openapi 보조 쓸 거면 환경변수 2개 추가)

## 판별 방식
- **가격비교 블록**: 통검 HTML에 "네이버 가격비교" 블록 마크업이 실재하는지 직접 확인
- **내 상품(블록내)**: 블록 영역에서 내 nvMid 등장 순서상 위치(best-effort). "페이지有" = 블록 밖이지만 페이지엔 존재
- 입력: 한 줄에 키워드 하나, `키워드, nvMid` 형식이면 그 줄만 추적

## 한계 / 유지보수
- 네이버 통검 HTML 구조는 수시로 바뀐다. 블록 탐지가 어긋나면 `app/api/scan/route.js`의 `BLOCK_SIGNALS` / `extractIds` 정규식을 라이브 HTML 보고 보강
- 블록 내 정확한 순위는 카드 구조 의존이라 best-effort. 정확한 자연순위는 `/api/check`(openapi) 병행 권장
