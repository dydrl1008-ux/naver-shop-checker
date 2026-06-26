import "./globals.css";

export const metadata = {
  title: "네이버 쇼핑 가격비교 · nvMid 체커",
  description: "키워드 대량 입력 → 가격비교 노출 여부 + 내 nvMid 순위 체크",
};

export default function RootLayout({ children }) {
  return (
    <html lang="ko">
      <head>
        <link
          rel="stylesheet"
          as="style"
          crossOrigin="anonymous"
          href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/pretendardvariable-dynamic-subset.min.css"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
