#!/usr/bin/env bash
# One coding agent per container, each with its own clone of June, in the agent sandbox image
# (nix/sandbox-image.nix). Claude Code runs in a tmux session inside the container, so you can
# detach (Ctrl-b d) and the agent keeps working; running the script again re-attaches.
#
#   scripts/agent-sandbox.sh 333        # container june-333: Claude Code starts on issue #333
#   scripts/agent-sandbox.sh spike      # container june-spike: Claude Code, no starting prompt
#   scripts/agent-sandbox.sh ls         # list sandboxes
#   scripts/agent-sandbox.sh rm 333     # remove one (its clone and any unpushed work go with it)
#
# Needs Docker on the host. Nothing on the host is mounted in: the container sees its own clone
# and the variables below, nothing else. Pass credentials as environment variables; the script
# forwards them by name, so values never appear on a command line:
#
#   CLAUDE_CODE_OAUTH_TOKEN   from `claude setup-token` (or ANTHROPIC_API_KEY)
#   GH_TOKEN                  optional; without it the agent can't push or open PRs. Use a
#                             fine-grained token limited to junebuild/june (contents, pull
#                             requests: read/write; issues: read).
#
# Optional:
#   AGENT_SANDBOX_IMAGE            default ghcr.io/junebuild/june-sandbox:latest
#   AGENT_SANDBOX_CLAUDE_SETTINGS  a settings.json to use inside instead of the default
#   AGENT_SANDBOX_CPUS / _MEMORY   resource limits, default 4 / 16g
#   GIT_AUTHOR_NAME / _EMAIL       commit identity, default the host's git config
set -euo pipefail

image=${AGENT_SANDBOX_IMAGE:-ghcr.io/junebuild/june-sandbox:latest}
repo=https://github.com/junebuild/june
prefix=june-

usage() { sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'; exit "${1:-0}"; }

attach() {
  # Inside tmux the agent survives a detach; a dead session falls back to a shell.
  exec docker exec -it -e TERM="${TERM:-xterm-256color}" "$1" \
    bash -c 'tmux attach -t agent 2>/dev/null || exec bash -l'
}

case "${1:-}" in
  "" | -h | --help) usage ;;
  ls)
    exec docker ps -a --filter "name=^${prefix}" --format 'table {{.Names}}\t{{.Status}}\t{{.CreatedAt}}'
    ;;
  rm)
    [ -n "${2:-}" ] || usage 1
    exec docker rm -f "${prefix}$2"
    ;;
esac

name=$1
[[ "$name" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*$ ]] || { echo "invalid name: $name" >&2; exit 1; }
container="${prefix}${name}"

if docker container inspect "$container" >/dev/null 2>&1; then
  docker start "$container" >/dev/null
  attach "$container"
fi

if [ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ] && [ -z "${ANTHROPIC_API_KEY:-}" ]; then
  echo "warning: neither CLAUDE_CODE_OAUTH_TOKEN nor ANTHROPIC_API_KEY is set; Claude Code will ask you to log in" >&2
fi
[ -n "${GH_TOKEN:-}" ] || echo "warning: GH_TOKEN is not set; the agent can clone but not push or open PRs" >&2

git_name=${GIT_AUTHOR_NAME:-$(git config --get user.name 2>/dev/null || true)}
git_email=${GIT_AUTHOR_EMAIL:-$(git config --get user.email 2>/dev/null || true)}
# The host's git identity may belong to someone else on a shared box, so say whose it is.
echo "→ the agent commits as: ${git_name:-?} <${git_email:-?}> (override: GIT_AUTHOR_NAME / GIT_AUTHOR_EMAIL)"

settings='{ "skipDangerousModePermissionPrompt": true }'
if [ -n "${AGENT_SANDBOX_CLAUDE_SETTINGS:-}" ]; then
  settings=$(cat "$AGENT_SANDBOX_CLAUDE_SETTINGS")
fi

prompt=""
if [[ "$name" =~ ^[0-9]+$ ]]; then
  prompt="Work on GitHub issue #$name of junebuild/june. Read it with \`gh issue view $name\`, implement it on a new branch, run \`bun run ci\` until it passes, then push the branch and open a pull request that closes #$name."
fi

docker pull -q "$image" >/dev/null || echo "warning: could not pull $image; using the local copy" >&2

# The container only idles; the work happens in the tmux session started below.
docker run -d --init --name "$container" --hostname "$container" \
  --cap-drop=ALL --security-opt=no-new-privileges --pids-limit=4096 \
  --cpus="${AGENT_SANDBOX_CPUS:-4}" --memory="${AGENT_SANDBOX_MEMORY:-16g}" \
  -e CLAUDE_CODE_OAUTH_TOKEN -e ANTHROPIC_API_KEY -e GH_TOKEN \
  -e GIT_NAME="$git_name" -e GIT_EMAIL="$git_email" \
  -e CLAUDE_SETTINGS="$settings" -e AGENT_PROMPT="$prompt" -e REPO="$repo" \
  -e PATH=/home/agent/.local/bin:/bin:/usr/bin \
  "$image" sleep infinity >/dev/null

echo "→ setting up $container"
docker exec "$container" bash -euo pipefail -c '
  [ -n "$GIT_NAME" ] && git config --global user.name "$GIT_NAME"
  [ -n "$GIT_EMAIL" ] && git config --global user.email "$GIT_EMAIL"
  [ -n "${GH_TOKEN:-}" ] && gh auth setup-git

  git clone -q "$REPO" /workspace/june
  cd /workspace/june
  bun install --frozen-lockfile >/dev/null

  curl -fsSL https://claude.ai/install.sh | bash >/dev/null
  mkdir -p ~/.claude
  printf "%s\n" "$CLAUDE_SETTINGS" > ~/.claude/settings.json
  # Start straight into the task: skip the first-run theme step and trust the clone, which
  # otherwise each stop the session on a prompt before the agent reads its instructions.
  printf "%s\n" "{\"hasCompletedOnboarding\": true, \"theme\": \"dark\", \"projects\": {\"/workspace/june\": {\"hasTrustDialogAccepted\": true}}}" > ~/.claude.json

  # Claude Code in the session; when it exits, the session stays as a shell.
  if [ -n "$AGENT_PROMPT" ]; then
    tmux new-session -d -s agent -c /workspace/june \
      "claude --dangerously-skip-permissions \"\$AGENT_PROMPT\"; exec bash -l"
  else
    tmux new-session -d -s agent -c /workspace/june "claude --dangerously-skip-permissions; exec bash -l"
  fi
'
echo "→ attaching (detach: Ctrl-b d; re-attach: $0 $name)"
attach "$container"
