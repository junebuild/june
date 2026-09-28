// LIVE GitHub App contract check (opt-in). The unit suite fakes GitHub — it proves OUR logic,
// not that api.github.com still accepts our JWT and exchange. This suite calls GitHub, so it
// runs only when pointed at a throwaway App installed on ONE test repository:
//
//   GITHUB_LIVE_APP_ID=123 GITHUB_LIVE_PRIVATE_KEY="$(cat app.pem)" \
//   GITHUB_LIVE_REPO=owner/repo bun test github-live
//
// The App needs Contents: read (and nothing that grants Contents: write) on that repo.
// GITHUB_LIVE_UNINSTALLED_REPO (owner/repo the App is NOT installed on) is optional.

import { describe, expect, test } from "bun:test";
import { githubApp, type GitHubAppError } from "@junejs/core/github";

const appId = process.env.GITHUB_LIVE_APP_ID;
const privateKey = process.env.GITHUB_LIVE_PRIVATE_KEY;
const [owner, repo] = (process.env.GITHUB_LIVE_REPO ?? "").split("/");
const uninstalled = process.env.GITHUB_LIVE_UNINSTALLED_REPO?.split("/");
const live = Boolean(appId && privateKey && owner && repo);

describe.skipIf(!live)("GitHub App (live)", () => {
  const gh = githubApp({ appId: appId!, privateKey: privateKey! });
  const api = (path: string, token: string, init: RequestInit = {}) =>
    fetch(`https://api.github.com${path}`, {
      ...init,
      headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": "june-github-live-test" },
    });

  test("mints a contents:read token that reads the repo and is refused a write", async () => {
    const token = await gh.token({ owner: owner!, repo: repo!, permissions: { contents: "read" } });
    expect(token).toStartWith("ghs_");
    const read = await api(`/repos/${owner}/${repo}/contents/`, token);
    expect(read.status).toBe(200);
    const write = await api(`/repos/${owner}/${repo}/contents/june-live-test.txt`, token, {
      method: "PUT",
      body: JSON.stringify({ message: "june live test", content: btoa("x") }),
    });
    expect(write.status).toBe(403);
  });

  test("a permission the App lacks is permission_denied", async () => {
    const err = (await gh.token({ owner: owner!, repo: repo!, permissions: { administration: "write" } }).catch((e) => e)) as GitHubAppError;
    expect(err.code).toBe("permission_denied");
  });

  test.skipIf(!uninstalled)("a repo without the App is not_installed", async () => {
    const err = (await gh.token({ owner: uninstalled![0]!, repo: uninstalled![1]!, permissions: { contents: "read" } }).catch((e) => e)) as GitHubAppError;
    expect(err.code).toBe("not_installed");
  });
});
