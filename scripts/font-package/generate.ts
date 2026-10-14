// The Noto Sans CJK font packages (@junejs/pdf-font-noto-sans-{tc,sc,jp,kr}, #381), generated
// from one template (scripts/font-package/template, each file with a .tmpl suffix so no tool
// mistakes it for code) and the table below. Each package stays self-contained — no runtime
// dependency between them — and the generator keeps them from drifting apart: edit the
// template or the table, run this, commit the result. tests/font-packages.test.ts fails when
// a package differs from what this would write.
//
//   bun scripts/font-package/generate.ts          # write packages/pdf-font-noto-sans-*
//   bun scripts/font-package/generate.ts --check  # exit 1 listing what differs
//
// Not generated: CHANGELOG.md, and in package.json the "version" and the ranges on other
// @junejs packages — changesets rewrites all three on every release (the published packages are
// one fixed group with updateInternalDependencies), so the generator keeps what is there. A new
// package starts at the published packages' shared version and the template's ranges.
//
// The files and their hashes are Noto Sans CJK's region subsets at release Sans2.004, pinned
// here and fetched by each package's scripts/fetch-fonts.ts. The coverage notes were measured
// with fontTools against each region's standard character set, counting what Typst's
// embedded fonts (Libertinus Serif, New Computer Modern, DejaVu Sans Mono) cover as well.

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

type Spec = {
  code: string; // "tc"
  script: string; // what the provider renders: "Traditional Chinese"
  language: string; // in prose: "renders Chinese"
  region: string; // the Noto subset's region
  lang: string; // BCP 47 for the test documents
  keyword: string; // npm keyword
  files: { 400: [sha256: string, size: number]; 700: [sha256: string, size: number] };
  coverage: string[]; // comment lines, measured
  docFull: string; // a heading and bold text: both weights
  docTitleBody: string;
  plain: string; // regular weight only
  rare: string; // a character the subset doesn't cover
  rareDoc: string; // a document whose only uncovered character is `rare`
};

export const SPECS: Spec[] = [
  {
    code: "tc",
    script: "Traditional Chinese",
    language: "Chinese",
    region: "Taiwan",
    lang: "zh-TW",
    keyword: "traditional-chinese",
    files: { 400: ["5bab0cb3c1cf89dde07c4a95a4054b195afbcfe784d69d75c340780712237537", 5683368], 700: ["55420b259eb119bf5f2a0aadba10cf9d736c12d64ab93e78546d69ef5f43558b", 5839972] },
    coverage: [
      "The subset is not every CJK ideograph. Measured with fontTools: 20,745 code points, 17,755",
      "of them Han, and every Big5 character except four symbols (U+02CD, U+203E, U+223C, U+2252).",
    ],
    docFull: "# 季度報告\\n\\n**營收**成長 12%。臺灣、裏、峯、齉龘爩鬱。",
    docTitleBody: "# 標題\\n\\n內文。",
    plain: "繁體中文",
    rare: "靐",
    rareDoc: "雷聲：靐",
  },
  {
    code: "sc",
    script: "Simplified Chinese",
    language: "Chinese",
    region: "mainland China",
    lang: "zh-CN",
    keyword: "simplified-chinese",
    files: { 400: ["faa6c9df652116dde789d351359f3d7e5d2285a2b2a1f04a2d7244df706d5ea9", 8331336], 700: ["c6cb5a93abaa9edc8ee7463b7ebb7f42d618d40e6ed2f7a5371c97b0b64767c0", 8543168] },
    coverage: [
      "The subset is not every CJK ideograph. Measured with fontTools: 30,890 code points, 27,900",
      "of them Han, and every GBK character but one symbol (U+2252), which Typst's embedded fonts",
      "cover.",
    ],
    docFull: "# 季度报告\\n\\n**营收**增长 12%。简体中文：龘、齉、爩。",
    docTitleBody: "# 标题\\n\\n正文。",
    plain: "简体中文",
    rare: "𪚥",
    rareDoc: "罕见字：𪚥",
  },
  {
    code: "jp",
    script: "Japanese",
    language: "Japanese",
    region: "Japan",
    lang: "ja",
    keyword: "japanese",
    files: { 400: ["dff723ba59d57d136764a04b9b2d03205544f7cd785a711442d6d2d085ac5073", 4533028], 700: ["1b0edfb500b73a4fa8a4fcaae1bbbd403994e08e73e3e0da37e70d3853f42c5f", 4656448] },
    coverage: [
      "The subset is not every CJK ideograph. Measured with fontTools: 16,732 code points, 13,742",
      "of them Han; with Typst's embedded fonts, every JIS X 0213 character (the subset alone lacks",
      "162 of them, none Han, all covered by the embedded fonts).",
    ],
    docFull: "# 四半期報告\\n\\n**売上**は12%増加しました。ひらがな、カタカナ、漢字。",
    docTitleBody: "# 見出し\\n\\n本文。",
    plain: "日本語",
    rare: "靐",
    rareDoc: "難読：靐",
  },
  {
    code: "kr",
    script: "Korean",
    language: "Korean",
    region: "Korea",
    lang: "ko",
    keyword: "korean",
    files: { 400: ["69975a0ac8472717870aefeab0a4d52739308d90856b9955313b2ad5e0148d68", 4644748], 700: ["5a6ceb287ed2fc6cfc6213144ebea68cbd94b20fc9eb873d8486493bf02d9bda", 4816044] },
    coverage: [
      "Measured with fontTools: 23,174 code points, among them all 11,172 Hangul syllables and",
      "8,653 Han; with Typst's embedded fonts, every KS X 1001 character except three hanja",
      "(U+9699 and the compatibility ideographs U+F95F, U+F9AA).",
    ],
    docFull: "# 분기 보고서\\n\\n**매출**이 12% 증가했습니다. 한글과 漢字.",
    docTitleBody: "# 제목\\n\\n본문.",
    plain: "한국어",
    rare: "隙",
    rareDoc: "틈: 隙",
  },
];

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const TEMPLATE = join(dirname(fileURLToPath(import.meta.url)), "template");
const MiB = 1048576;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

function values(s: Spec): Record<string, string> {
  const [sha400, size400] = s.files[400];
  const [sha700, size700] = s.files[700];
  return {
    CODE: s.code.toUpperCase(),
    code: s.code,
    SCRIPT: s.script,
    LANGUAGE: s.language,
    REGION: s.region,
    LANG: s.lang,
    KEYWORD: s.keyword,
    SHA_400: sha400,
    SIZE_400: String(size400),
    SHA_700: sha700,
    SIZE_700: String(size700),
    MIB_WEIGHT: ((size400 + size700) / 2 / MiB).toFixed(1),
    MIB_TOTAL: ((size400 + size700) / MiB).toFixed(0),
    COVERAGE: s.coverage.map((l) => `// ${l}`).join("\n"),
    DOC_FULL: s.docFull,
    DOC_TITLE_BODY: s.docTitleBody,
    PLAIN: s.plain,
    RARE: s.rare,
    RARE_DOC: s.rareDoc,
  };
}

function render(text: string, v: Record<string, string>, file: string): string {
  const out = text.replace(/\{\{(\w+)\}\}/g, (_, k: string) => {
    if (!(k in v)) throw new Error(`${file}: unknown placeholder {{${k}}}`);
    return v[k]!;
  });
  return out;
}

type PackageJson = { version: string } & Partial<Record<(typeof DEP_FIELDS)[number], Record<string, string>>>;
const DEP_FIELDS = ["dependencies", "peerDependencies", "devDependencies"] as const;

// The rendered package.json with what the release owns taken from the package as it is: its
// version, and its range on each @junejs dependency the template also declares.
export function releaseOwned(rendered: string, existing: string | undefined, sharedVersion: string): string {
  const pkg = JSON.parse(rendered) as PackageJson;
  const now = existing ? (JSON.parse(existing) as PackageJson) : undefined;
  pkg.version = now?.version ?? sharedVersion;
  for (const field of DEP_FIELDS) {
    for (const name of Object.keys(pkg[field] ?? {})) {
      const kept = now?.[field]?.[name];
      if (name.startsWith("@junejs/") && kept) pkg[field]![name] = kept;
    }
  }
  return JSON.stringify(pkg, null, 2) + "\n";
}

// What each package's files should be: path relative to the repo → contents.
export function expected(): Map<string, string> {
  const files = new Map<string, string>();
  const shared = JSON.parse(readFileSync(join(ROOT, "packages/pdf-font-noto-sans-tc/package.json"), "utf8")) as { version: string };
  for (const spec of SPECS) {
    const v = values(spec);
    const pkg = `packages/pdf-font-noto-sans-${spec.code}`;
    for (const t of walk(TEMPLATE)) {
      const rel = relative(TEMPLATE, t).replace(/\.tmpl$/, "");
      let text = render(readFileSync(t, "utf8"), v, rel);
      if (rel === "package.json") {
        const path = join(ROOT, pkg, "package.json");
        text = releaseOwned(text, existsSync(path) ? readFileSync(path, "utf8") : undefined, shared.version);
      }
      files.set(join(pkg, rel), text);
    }
  }
  return files;
}

if (import.meta.main) {
  const check = process.argv.includes("--check");
  const differing: string[] = [];
  for (const [rel, text] of expected()) {
    const path = join(ROOT, rel);
    const current = existsSync(path) ? readFileSync(path, "utf8") : undefined;
    if (current === text) continue;
    if (check) differing.push(rel);
    else {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, text);
      console.log(`wrote ${rel}`);
    }
  }
  if (check && differing.length) {
    console.error(`font packages differ from scripts/font-package/generate.ts — run it and commit:\n  ${differing.join("\n  ")}`);
    process.exit(1);
  }
}
