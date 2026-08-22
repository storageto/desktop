
#!/usr/bin/env bash
#
# install-build-deps.sh
#
# Installs everything needed to build the StorageTo Desktop app
# (https://github.com/storageto/desktop) on Linux from source.
#
# Covers: Node.js, Rust (via rustup), and the system libraries Tauri needs
# (webkit2gtk, GTK3, appindicator, librsvg, patchelf, build tools).
#
# Supports: Debian/Ubuntu (apt), Fedora (dnf), and Arch (pacman).
#
# Usage:
#   chmod +x install-build-deps.sh
#   ./install-build-deps.sh
#
# It will ask for your sudo password when installing system packages.

set -euo pipefail

bold() { printf '\033[1m%s\033[0m\n' "$1"; }
info() { printf '\033[34m==>\033[0m %s\n' "$1"; }
warn() { printf '\033[33mWARNING:\033[0m %s\n' "$1"; }
err()  { printf '\033[31mERROR:\033[0m %s\n' "$1" >&2; }

bold "StorageTo Desktop - Linux build dependency installer"
echo

# ---------------------------------------------------------------------------
# 1. Detect the package manager
# ---------------------------------------------------------------------------
if command -v apt-get >/dev/null 2>&1; then
    PM="apt"
elif command -v dnf >/dev/null 2>&1; then
    PM="dnf"
elif command -v pacman >/dev/null 2>&1; then
    PM="pacman"
else
    err "Could not detect a supported package manager (apt, dnf, or pacman)."
    err "You'll need to install the equivalent packages manually - see the"
    err "Tauri Linux prerequisites page: https://v2.tauri.app/start/prerequisites/"
    exit 1
fi
info "Detected package manager: $PM"

# ---------------------------------------------------------------------------
# 2. Install system dependencies (webkit2gtk, GTK3, appindicator, etc.)
# ---------------------------------------------------------------------------
info "Installing system dependencies (you may be asked for your sudo password)..."

case "$PM" in
    apt)
        sudo apt-get update
        sudo apt-get install -y \
            libwebkit2gtk-4.1-dev \
            libgtk-3-dev \
            libayatana-appindicator3-dev \
            librsvg2-dev \
            patchelf \
            build-essential \
            curl \
            wget \
            file \
            pkg-config \
            libssl-dev
        ;;
    dnf)
        sudo dnf check-update || true
        sudo dnf group install -y "C Development Tools and Libraries"
        sudo dnf install -y \
            webkit2gtk4.1-devel \
            gtk3-devel \
            libappindicator-gtk3-devel \
            librsvg2-devel \
            patchelf \
            curl \
            wget \
            file \
            openssl-devel \
            pkgconf-pkg-config
        ;;
    pacman)
        sudo pacman -Sy --needed --noconfirm \
            webkit2gtk-4.1 \
            base-devel \
            curl \
            wget \
            file \
            openssl \
            appmenu-gtk-module \
            librsvg \
            libappindicator-gtk3 \
            patchelf
        ;;
esac

info "System dependencies installed."
echo

# ---------------------------------------------------------------------------
# 3. Install Node.js (via NodeSource) if missing or too old
# ---------------------------------------------------------------------------
NODE_MIN_MAJOR=20

need_node=true
if command -v node >/dev/null 2>&1; then
    node_major="$(node -v | sed -E 's/^v([0-9]+).*/\1/')"
    if [ "$node_major" -ge "$NODE_MIN_MAJOR" ]; then
        info "Node.js $(node -v) already installed and new enough - skipping."
        need_node=false
    else
        warn "Node.js $(node -v) found, but this project wants v${NODE_MIN_MAJOR}+. Upgrading."
    fi
fi

if [ "$need_node" = true ]; then
    info "Installing Node.js ${NODE_MIN_MAJOR}.x..."
    case "$PM" in
        apt)
            curl -fsSL https://deb.nodesource.com/setup_${NODE_MIN_MAJOR}.x | sudo -E bash -
            sudo apt-get install -y nodejs
            ;;
        dnf)
            curl -fsSL https://rpm.nodesource.com/setup_${NODE_MIN_MAJOR}.x | sudo -E bash -
            sudo dnf install -y nodejs
            ;;
        pacman)
            sudo pacman -Sy --needed --noconfirm nodejs npm
            ;;
    esac
fi
echo

# ---------------------------------------------------------------------------
# 4. Install Rust (via rustup) if missing
# ---------------------------------------------------------------------------
if command -v rustc >/dev/null 2>&1 && command -v cargo >/dev/null 2>&1; then
    info "Rust already installed: $(rustc -V)"
    rust_source="$(command -v rustc)"
    if [[ "$rust_source" == /usr/bin/* ]]; then
        warn "This looks like a distro-packaged Rust (from $PM), which may be too old"
        warn "for this project. If the build fails with an 'edition2024' error, run:"
        warn "  rustup default stable   (after installing rustup, see below)"
    fi
else
    info "Installing Rust via rustup..."
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
    # shellcheck disable=SC1090
    source "$HOME/.cargo/env"
fi
echo

# ---------------------------------------------------------------------------
# 5. Summary
# ---------------------------------------------------------------------------
bold "Done. Versions installed:"
echo "  node:   $(command -v node >/dev/null 2>&1 && node -v || echo 'not found')"
echo "  npm:    $(command -v npm  >/dev/null 2>&1 && npm -v  || echo 'not found')"
if command -v rustc >/dev/null 2>&1; then
    echo "  rustc:  $(rustc -V)"
else
    echo "  rustc:  not found on PATH yet - open a new terminal, or run:"
    echo "          source \$HOME/.cargo/env"
fi
echo
bold "Next steps:"
echo "  1. Open a NEW terminal (so PATH updates for cargo/rustup take effect),"
echo "     or run: source \$HOME/.cargo/env"
echo "  2. cd into the storageto/desktop project folder"
echo "  3. npm install"
echo "  4. npm run tauri build"
echo
echo "The built .deb, .rpm, and AppImage will be under:"
echo "  src-tauri/target/release/bundle/"
