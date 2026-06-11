// Network-stripped equivalent of the rari/Next.js benchmark HomePage.
//
// The original page makes TWO external fetches per request (FetchExample ->
// jsonplaceholder, WhatsHot -> Bluesky), so rendering it live measures the
// internet, not the framework. To get an honest render-vs-render number we
// inline that data and keep everything else identical — same 8-component tree,
// same markdown-it parse on the same article. Counter is the one client
// component (passed in as a client reference by server-entry).

import MarkdownIt from "markdown-it";

// The client reference must be rendered as JSX (<Counter />), never called.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ClientCounter = any;

// --- inline data (was: two external fetches + a server fn) ---

const GROCERIES = Array.from({ length: 10 }, (_, i) => ({
  id: i + 1,
  text: ["Milk", "Eggs", "Bread", "Coffee", "Apples", "Rice", "Tomatoes", "Cheese", "Spinach", "Butter"][i],
  completed: i % 3 === 0,
}));

const FEED = Array.from({ length: 5 }, (_, i) => ({
  post: {
    uri: `at://post/${i}`,
    author: { handle: `user${i}.bsky.social`, displayName: `User ${i}`, avatar: "" },
    record: { text: `Trending post #${i + 1}: server components are rendering this list entirely on the server with no client JS for the markup. `.repeat(2), createdAt: "2026-06-08T00:00:00Z" },
    replyCount: 12 + i,
    repostCount: 34 + i,
    likeCount: 567 + i,
  },
}));

const POST = {
  id: 1,
  userId: 1,
  title: "sunt aut facere repellat provident occaecati excepturi optio",
  body: "quia et suscipit suscipit recusandae consequuntur expedita et cum reprehenderit molestiae ut ut quas totam nostrum rerum est autem sunt rem eveniet architecto",
};

const ARTICLE = `# Server Components Benchmark

A representative article rendered through **markdown-it**, the same parser the
reference benchmark uses, so the markdown work is comparable across frameworks.

## Why this matters

React Server Components push rendering to the server. The cost that actually
matters for a *dynamic* page is the **per-request render**, not serving a cached
or statically-prerendered result.

- Point one: the tree is rendered fresh each request.
- Point two: markdown parsing is real CPU work.
- Point three: no network is involved here on purpose.

### A code sample

\`\`\`ts
function add(a: number, b: number) {
  return a + b;
}
\`\`\`

> The benchmark page the reference uses fetches two external APIs per request,
> so live-rendering it measures latency to those services rather than the
> framework. Stripping the network isolates render throughput.

## More content

${"Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. ".repeat(12)}

1. First ordered item
2. Second ordered item
3. Third ordered item

Done.`;

const md = new MarkdownIt({ html: true, linkify: true, typographer: true, breaks: false });

// --- components (sync; inline data resolves immediately) ---

function TestComponent({ a = 5, b = 10 }: { a?: number; b?: number }) {
  const result = a + b;
  return (
    <div className="p-6 bg-white rounded-lg shadow-sm test-component">
      <h2 className="text-xl font-semibold text-gray-800 mb-3">Test Component</h2>
      <p className="text-gray-600 mb-4">This component is testing server function calls</p>
      <div className="p-4 bg-blue-50 border border-blue-100 rounded-md">
        <p className="text-gray-700">
          Server calculated: <span className="font-medium">{a}</span>{" + "}
          <span className="font-medium">{b}</span>{" = "}
          <span className="font-bold text-blue-600">{result}</span>
          <small className="ml-1 text-gray-500">(server)</small>
        </p>
      </div>
    </div>
  );
}

function EnvTestComponent() {
  const env = (globalThis as Record<string, unknown>).process as { env?: Record<string, string> } | undefined;
  return (
    <div className="p-6 bg-white rounded-lg shadow-sm">
      <h2 className="text-xl font-semibold text-gray-800 mb-3">Environment Test</h2>
      <div className="p-4 bg-blue-50 border border-blue-200 rounded">
        <h3 className="font-medium text-gray-700 mb-2">Environment Variables</h3>
        <div className="space-y-1 text-sm">
          <p><span className="font-mono">NODE_ENV</span>: {env?.env?.NODE_ENV || "production"}</p>
          <p><span className="font-mono">SERVER_PORT</span>: {env?.env?.SERVER_PORT || "undefined"}</p>
        </div>
      </div>
      <div className="p-4 bg-yellow-50 border border-yellow-200 rounded mt-3">
        <pre className="text-xs bg-white p-2 rounded border">{JSON.stringify(env?.env || {}, null, 2)}</pre>
      </div>
    </div>
  );
}

function FetchExample() {
  return (
    <div className="p-5 bg-white border rounded-lg shadow-sm" data-component-id="fetchexample">
      <h1 className="text-2xl font-bold text-blue-700 mb-2">Fetch Example (inline)</h1>
      <div className="bg-gray-50 p-4 rounded border">
        <div><span className="font-medium text-gray-700">Title:</span> {POST.title}</div>
        <div><span className="font-medium text-gray-700">Body:</span> {POST.body}</div>
        <div><span className="font-medium text-gray-700">User ID:</span> {POST.userId}</div>
      </div>
    </div>
  );
}

function ShoppingList() {
  return (
    <div className="p-5 rounded-lg" data-component-id="shoppinglist">
      <h1 className="text-2xl font-bold text-blue-700 mb-2">Shopping List</h1>
      <p className="text-gray-600 mb-4">A React Server Component demo</p>
      <ul className="space-y-2 mb-6">
        {GROCERIES.map((item) => (
          <li key={item.id} className={item.completed ? "px-4 py-2 border-b border-gray-200 line-through text-gray-500" : "px-4 py-2 border-b border-gray-200 text-gray-800"}>
            {item.text} {item.completed ? <span className="text-green-600">✓</span> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

function WhatsHot() {
  return (
    <div className="p-5 bg-white border rounded-lg shadow-sm" data-component-id="whatshot">
      <h1 className="text-2xl font-bold text-blue-600 mb-2">🔥 What's Hot</h1>
      <div className="mb-4 text-sm text-gray-500">{FEED.length} trending posts</div>
      <div className="space-y-4">
        {FEED.map((item, index) => {
          const post = item.post;
          return (
            <div key={post.uri} className="border-l-4 border-blue-500 pl-4 py-3 bg-gray-50 rounded-r">
              <div className="flex items-start justify-between mb-2">
                <div className="flex items-center space-x-2">
                  <div>
                    <div className="font-semibold text-gray-800">{post.author.displayName}</div>
                    <div className="text-sm text-gray-500">@{post.author.handle}</div>
                  </div>
                </div>
                <div className="text-xs text-gray-400">#{index + 1}</div>
              </div>
              <p className="text-gray-700 mb-3 leading-relaxed">{post.record.text}</p>
              <div className="flex items-center space-x-4 text-sm text-gray-500">
                <span>💬 {post.replyCount}</span>
                <span>🔄 {post.repostCount}</span>
                <span>❤️ {post.likeCount}</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ServerWithClient({ Counter }: { Counter: ClientCounter }) {
  const serverData = { message: "This data was generated on the server" };
  return (
    <div className="p-6 border border-blue-300 rounded-lg bg-blue-50">
      <h2 className="text-xl font-semibold mb-4 text-blue-800">Server Component Container</h2>
      <div className="mb-6">
        <ul className="list-disc list-inside text-blue-600 text-sm">
          <li>Server-side rendered content</li>
          <li>A client component embedded below</li>
        </ul>
      </div>
      <p className="text-blue-800 bg-blue-100 p-2 rounded">{serverData.message}</p>
      <div className="border-t border-blue-200 pt-4"><Counter /></div>
    </div>
  );
}

function Markdown() {
  const html = md.render(ARTICLE);
  return (
    <div className="max-w-4xl mx-auto p-6">
      <div className="prose" dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
}

export function BenchHome({ Counter }: { Counter: ClientCounter }) {
  return (
    <div className="min-h-screen bg-linear-to-br from-blue-50 to-indigo-100 py-8 px-4">
      <div className="max-w-6xl mx-auto space-y-8">
        <div className="bg-white rounded-xl p-8 shadow-sm border border-gray-200 text-center">
          <h1 className="text-4xl font-bold text-gray-900 mb-4">🚀 June Framework Benchmark</h1>
          <p className="text-xl text-gray-600 mb-6">Server Component Performance Testing Suite</p>
        </div>
        <TestComponent />
        <EnvTestComponent />
        <FetchExample />
        <ShoppingList />
        <WhatsHot />
        <ServerWithClient Counter={Counter} />
        <Markdown />
        <div><Counter initial={3} /></div>
      </div>
    </div>
  );
}
