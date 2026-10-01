#!/usr/bin/env bash
#
# Deploy the Claude Max API proxy as a macOS LaunchAgent.
#
# Pulls the latest code, installs dependencies, builds, runs the unit tests,
# (re)starts the LaunchAgent and waits for /health. If the new version does
# not come up healthy, it rolls back to the previously deployed commit.
#
# Usage:
#   scripts/deploy.sh [options]
#
# Options:
#   --branch NAME      Branch to deploy (default: main)
#   --no-pull          Deploy the current checkout as-is (no git fetch/pull)
#   --skip-tests       Skip the unit tests (not recommended)
#   --reinstall-plist  Rewrite the LaunchAgent plist (old one is backed up)
#   --no-rollback      Leave a failed deploy in place for debugging
#   -h, --help         Show this help
#
# Environment overrides:
#   LABEL     LaunchAgent label  (default: com.openclaw.claude-max-proxy)
#   PORT      Port to health-check (default: PORT from .env, else 3456)
#   LOG_DIR   Log directory       (default: ~/.openclaw/logs)
#
set -euo pipefail

BRANCH="main"
PULL=1
RUN_TESTS=1
REINSTALL_PLIST=0
ROLLBACK=1

while [[ $# -gt 0 ]]; do
  case "$1" in
    --branch) BRANCH="${2:?--branch needs a value}"; shift 2 ;;
    --no-pull) PULL=0; shift ;;
    --skip-tests) RUN_TESTS=0; shift ;;
    --reinstall-plist) REINSTALL_PLIST=1; shift ;;
    --no-rollback) ROLLBACK=0; shift ;;
    -h|--help) sed -n '2,24p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $1 (see --help)" >&2; exit 2 ;;
  esac
done

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LABEL="${LABEL:-com.openclaw.claude-max-proxy}"
LOG_DIR="${LOG_DIR:-$HOME/.openclaw/logs}"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"

step() { printf '\n\033[1;34m==>\033[0m %s\n' "$*"; }
info() { printf '    %s\n' "$*"; }
fail() { printf '\n\033[1;31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

cd "$REPO_DIR"

# ---------------------------------------------------------------- checks
step "Checking prerequisites"
for cmd in git node npm curl launchctl; do
  command -v "$cmd" >/dev/null 2>&1 || fail "'$cmd' not found in PATH"
done
NODE_BIN="$(command -v node)"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[[ "$NODE_MAJOR" -ge 20 ]] || fail "Node.js >= 20 required (found $(node -v))"
CLAUDE_BIN="$(command -v claude || true)"
[[ -n "$CLAUDE_BIN" ]] || fail "Claude CLI ('claude') not found in PATH - install it first"
info "node   $(node -v)  ($NODE_BIN)"
info "claude $("$CLAUDE_BIN" --version 2>/dev/null | head -1)  ($CLAUDE_BIN)"

if [[ -z "${PORT:-}" ]]; then
  PORT="$(grep -E '^[[:space:]]*PORT=' .env 2>/dev/null | tail -1 | cut -d= -f2 | tr -d "\"'[:space:]" || true)"
  PORT="${PORT:-3456}"
fi

if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
  fail "Working tree has uncommitted changes - commit or stash them first"
fi
PREV_COMMIT="$(git rev-parse HEAD)"

# ---------------------------------------------------------------- code
build() {
  step "Installing dependencies"
  npm ci --no-audit --no-fund
  step "Building"
  npm run build
}

if [[ "$PULL" -eq 1 ]]; then
  step "Updating code from origin/$BRANCH"
  git fetch origin "$BRANCH"
  git checkout -q "$BRANCH"
  git merge --ff-only "origin/$BRANCH" \
    || fail "Local '$BRANCH' has diverged from origin/$BRANCH - resolve manually"
fi
NEW_COMMIT="$(git rev-parse HEAD)"
if [[ "$NEW_COMMIT" == "$PREV_COMMIT" ]]; then
  info "Deploying $(git log -1 --format='%h %s')"
else
  info "$(git log -1 --format=%h "$PREV_COMMIT") -> $(git log -1 --format='%h %s')"
fi

build

if [[ "$RUN_TESTS" -eq 1 ]]; then
  step "Running unit tests (no Claude calls)"
  npm test >/tmp/claude-max-proxy-deploy-tests.log 2>&1 \
    || { tail -40 /tmp/claude-max-proxy-deploy-tests.log; fail "Tests failed - service NOT restarted (full log: /tmp/claude-max-proxy-deploy-tests.log)"; }
  info "$(grep -E '^# (pass|fail)' /tmp/claude-max-proxy-deploy-tests.log | tr '\n' ' ')"
fi

# ---------------------------------------------------------------- service
write_plist() {
  mkdir -p "$(dirname "$PLIST")" "$LOG_DIR"
  if [[ -f "$PLIST" ]]; then
    cp "$PLIST" "$PLIST.bak.$(date +%Y%m%d%H%M%S)"
    info "Backed up existing plist"
  fi
  local path_value
  path_value="$(dirname "$CLAUDE_BIN"):$(dirname "$NODE_BIN"):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
  cat >"$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$REPO_DIR/dist/server/standalone.js</string>
  </array>
  <!-- The server reads .env from its working directory -->
  <key>WorkingDirectory</key>
  <string>$REPO_DIR</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$LOG_DIR/claude-max-proxy.log</string>
  <key>StandardErrorPath</key>
  <string>$LOG_DIR/claude-max-proxy.err.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>$HOME</string>
    <key>PATH</key>
    <string>$path_value</string>
  </dict>
</dict>
</plist>
PLIST
  info "Wrote $PLIST"
}

restart_service() {
  if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
    if [[ "$REINSTALL_PLIST" -eq 1 ]]; then
      # A changed plist only takes effect after a full reload
      launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
      sleep 1
      launchctl bootstrap "$DOMAIN" "$PLIST"
    else
      launchctl kickstart -k "$DOMAIN/$LABEL"
    fi
  else
    launchctl bootstrap "$DOMAIN" "$PLIST"
  fi
}

wait_healthy() {
  local i
  for i in $(seq 1 30); do
    if curl -fsS --max-time 2 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  return 1
}

step "Restarting LaunchAgent $LABEL"
if [[ ! -f "$PLIST" ]]; then
  info "No plist found - installing one"
  write_plist
elif [[ "$REINSTALL_PLIST" -eq 1 ]]; then
  write_plist
fi
restart_service

step "Waiting for http://127.0.0.1:$PORT/health"
if wait_healthy; then
  printf '\n\033[1;32mDeployed\033[0m %s - service healthy on port %s\n' "$(git log -1 --format='%h %s')" "$PORT"
  exit 0
fi

echo "    Service did not become healthy. Last error log lines:" >&2
tail -20 "$LOG_DIR/claude-max-proxy.err.log" 2>/dev/null >&2 || true

if [[ "$ROLLBACK" -eq 0 || "$NEW_COMMIT" == "$PREV_COMMIT" ]]; then
  fail "Deploy failed (no rollback performed)"
fi

step "Rolling back to $(git log -1 --format='%h %s' "$PREV_COMMIT")"
git reset -q --hard "$PREV_COMMIT"
build
restart_service
if wait_healthy; then
  fail "New version was unhealthy; rolled back to $(git log -1 --format=%h "$PREV_COMMIT"), which is running"
fi
fail "Rollback also failed - check $LOG_DIR/claude-max-proxy.err.log"
