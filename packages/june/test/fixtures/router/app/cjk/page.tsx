export default function Cjk() {
  return (
    <main>
      <h1 data-page="cjk">文件中心</h1>
    </main>
  );
}
// A non-ASCII title: header values are Latin-1-only, so the projection must
// percent-encode this or headers.set throws and the whole fragment 500s.
export const metadata = { title: "文件中心 — 整合指南" };
