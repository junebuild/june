import { fileURLToPath } from "node:url";

import { route } from "junecore/route";
import { entry } from "@junejs/server/content";

// Content lives at examples/basic/content/posts, three levels up from this file.
const POSTS = fileURLToPath(new URL("../../../content/posts", import.meta.url));

export default route({
  load: (ctx) => {
    const post = ctx.params.slug ? entry(POSTS, ctx.params.slug) : null;
    return { post };
  },
  view: ({ post }) =>
    post ? (
      <main>
        <article dangerouslySetInnerHTML={{ __html: post.html }} />
      </main>
    ) : (
      <main>
        <h1>Post not found</h1>
      </main>
    ),
  // The .md projection is the AUTHORED source, verbatim — not a lossy
  // HTML→markdown round-trip. Agents read exactly what the author wrote.
  md: ({ post }) => post?.original ?? "# Post not found\n",
  metadata: ({ post }) => ({
    title: (post?.data.title as string) ?? "Post",
    description: post?.data.description as string,
  }),
});
