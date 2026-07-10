// A framework-provided channel in Shape B: the module default-exports a `(env) =>
// Channel` FACTORY, so its secrets resolve from env at request time — the form
// workerd needs (platform secrets live only in env, never at module top-level). On
// native, discovery calls it with process.env; on the edge, with the worker env.
// Adding Slack is still one file, and it stays portable across targets.
import { slackChannel } from "@junejs/core/channels";

export default (env: Record<string, string | undefined>) =>
  slackChannel({
    signingSecret: env.SLACK_SIGNING_SECRET ?? "test-secret",
    botToken: env.SLACK_BOT_TOKEN ?? "test-token",
  });
