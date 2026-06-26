import "./globals.css";

export const metadata = {
  title: "네이버 통검 가격비교 블록 체커",
  description: "키워드별 모바일 통합검색 가격비교 블록 노출 + 내 상품 N등 체크",
};

export default function RootLayout({ children }) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
