#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET="${BITA_TARGET:-claude}"
NO_DRAWIO=0
NO_ATLASSIAN=0

info() { printf '  %s\n' "$1"; }
warn() { printf '  ! %s\n' "$1" >&2; }

require_node() {
  if ! command -v node >/dev/null 2>&1; then
    warn "node is not on PATH. bita needs Node 24 or newer."
    exit 1
  fi
  local major
  major="$(node -p 'process.versions.node.split(".")[0]')"
  if [ "$major" -lt 24 ]; then
    warn "node $major found; bita needs 24 or newer for node:sqlite and type stripping."
    exit 1
  fi
  info "node $(node -v)"
}

link() {
  local target="$1" linkname="$2"
  if [ -L "$linkname" ]; then
    if [ "$(readlink "$linkname")" = "$target" ]; then
      info "already linked: $linkname"
      return
    fi
    rm "$linkname"
  elif [ -e "$linkname" ]; then
    mv "$linkname" "$linkname.backup"
    warn "moved the existing $linkname to $linkname.backup"
  fi
  ln -s "$target" "$linkname"
  info "linked: $linkname"
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --target)
      [ "$#" -ge 2 ] || { warn "--target needs a value"; exit 2; }
      TARGET="$2"
      shift 2
      ;;
    --no-drawio)
      NO_DRAWIO=1
      shift
      ;;
    --no-atlassian)
      NO_ATLASSIAN=1
      shift
      ;;
    *)
      warn "unknown option: $1"
      exit 2
      ;;
  esac
done

echo "bita — installing the $TARGET integration"
echo
require_node

echo
echo "Binary"
BIN_DIR=""
if [ -n "${BITA_BIN_DIR:-}" ]; then
  BIN_DIR="$BITA_BIN_DIR"
elif [ -n "${PNPM_HOME:-}" ] && [ -d "$PNPM_HOME/bin" ]; then
  BIN_DIR="$PNPM_HOME/bin"
elif command -v pnpm >/dev/null 2>&1 && pnpm bin -g >/dev/null 2>&1; then
  BIN_DIR="$(pnpm bin -g 2>/dev/null | tail -1)"
elif [ -d "$HOME/.local/bin" ]; then
  BIN_DIR="$HOME/.local/bin"
fi

chmod +x "$REPO_ROOT/src/bin/bita.ts"

if [ -n "$BIN_DIR" ] && [ -d "$BIN_DIR" ]; then
  link "$REPO_ROOT/src/bin/bita.ts" "$BIN_DIR/bita"
  case ":$PATH:" in
    *":$BIN_DIR:"*) ;;
    *) warn "$BIN_DIR is not on PATH; add it to your shell profile" ;;
  esac
else
  warn "found no bin directory to link into."
  warn "set BITA_BIN_DIR to one on your PATH and re-run, or link it yourself:"
  warn "  ln -s $REPO_ROOT/src/bin/bita.ts <dir-on-path>/bita"
fi

echo
echo "Integration"
SETUP_ARGS=(--target "$TARGET")
if [ "$NO_DRAWIO" -eq 1 ]; then
  SETUP_ARGS+=(--no-drawio)
fi
if [ "$NO_ATLASSIAN" -eq 1 ]; then
  SETUP_ARGS+=(--no-atlassian)
fi
node "$REPO_ROOT/src/bin/bita.ts" setup "${SETUP_ARGS[@]}"
