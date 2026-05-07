#!/usr/bin/env bash
# MIOSA CLI installer
#
# Usage:
#   curl -fsSL https://miosa.ai/install.sh | sh
#
# This script detects pnpm, npm, or yarn and installs @miosa/cli globally.
# It's a thin wrapper for now — a static-binary path is on the roadmap.

set -e

PACKAGE="@miosa/cli"
MIN_NODE_MAJOR=20

red() { printf '\033[31m%s\033[0m\n' "$1"; }
green() { printf '\033[32m%s\033[0m\n' "$1"; }
dim() { printf '\033[2m%s\033[0m\n' "$1"; }
bold() { printf '\033[1m%s\033[0m\n' "$1"; }

require_node() {
  if ! command -v node >/dev/null 2>&1; then
    red "Error: Node.js is not installed."
    echo ""
    echo "MIOSA CLI requires Node.js ${MIN_NODE_MAJOR} or newer."
    echo "Install from https://nodejs.org or via your package manager:"
    echo ""
    echo "  macOS (Homebrew):  brew install node"
    echo "  Linux (apt):       curl -fsSL https://deb.nodesource.com/setup_${MIN_NODE_MAJOR}.x | sudo bash - && sudo apt install -y nodejs"
    echo "  Linux (other):     https://github.com/nodesource/distributions"
    exit 1
  fi

  local node_major
  node_major=$(node -v | sed 's/^v//' | cut -d. -f1)
  if [ "$node_major" -lt "$MIN_NODE_MAJOR" ]; then
    red "Error: Node.js ${node_major} found; ${MIN_NODE_MAJOR}+ is required."
    echo "Upgrade your Node.js install and try again."
    exit 1
  fi
}

pick_installer() {
  if command -v pnpm >/dev/null 2>&1; then
    echo "pnpm"
  elif command -v npm >/dev/null 2>&1; then
    echo "npm"
  elif command -v yarn >/dev/null 2>&1; then
    echo "yarn"
  else
    red "Error: no package manager found (pnpm, npm, or yarn)."
    echo "Install one and re-run this script."
    exit 1
  fi
}

main() {
  bold "Installing MIOSA CLI…"
  echo ""

  require_node

  local installer
  installer=$(pick_installer)
  dim "Using $installer to install $PACKAGE"
  echo ""

  case "$installer" in
    pnpm)
      pnpm add -g "$PACKAGE"
      ;;
    npm)
      npm install -g "$PACKAGE"
      ;;
    yarn)
      yarn global add "$PACKAGE"
      ;;
  esac

  echo ""
  if command -v miosa >/dev/null 2>&1; then
    green "✓ MIOSA CLI installed: $(miosa --version)"
    echo ""
    bold "Next steps:"
    echo "  miosa login              # browser-based auth"
    echo "  miosa computers list     # see your Computers"
    echo "  miosa --help             # full command reference"
    echo ""
    echo "Docs: https://miosa.ai/docs/cli/"
  else
    red "Install completed but 'miosa' is not on your PATH."
    echo "Add your global $installer bin directory to PATH and try again."
    exit 1
  fi
}

main "$@"
