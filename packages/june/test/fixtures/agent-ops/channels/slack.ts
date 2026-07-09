// A framework-provided channel, wired with this app's secrets. Adding Slack is
// one file. (Secrets are injected by the app — from process.env on native, env
// bindings on edge — so the channel itself stays portable.)
import { slackChannel } from "@junejs/core/channels";

export default slackChannel({ signingSecret: "test-secret", botToken: "test-token" });
