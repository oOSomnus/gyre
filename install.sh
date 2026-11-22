#!/usr/bin/env bash
# Gyre installer: a guided setup for the Gyre web (browser) version and/or the
# desktop app, plus the omp coding agent, the optional Plannotator plan-review
# plugin, and omp's first model provider.
#
#   curl -fsSL https://raw.githubusercontent.com/oOSomnus/gyre/main/install.sh | bash
#
# Non-interactive (pass flags after `bash -s --`):
#   curl -fsSL …/install.sh | bash -s -- --web --with-plannotator --yes
#
# Flags:
#   --web | --desktop | --both    what to install (default: ask; web if not interactive)
#   --install-omp | --no-omp      install omp if it is missing, or skip the omp step
#   --with-plannotator | --no-plannotator
#   --version vX.Y.Z              a specific release (default: latest)
#   --yes, -y                     accept the recommended answer for every question
#   --uninstall                   remove what this script installed (keeps ~/.gyre data)
#   --help
#
# Environment:
#   GYRE_INSTALL_DIR   web install folder        (default ~/.local/share/gyre)
#   GYRE_BIN_DIR       launcher / AppImage folder (default ~/.local/bin)
#   GYRE_RELEASE_BASE  download base URL, e.g. file:///path/to/dist/release (testing)
set -euo pipefail

REPO="oOSomnus/gyre"
INSTALL_DIR="${GYRE_INSTALL_DIR:-$HOME/.local/share/gyre}"
BIN_DIR="${GYRE_BIN_DIR:-$HOME/.local/bin}"
APPS_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
ICONS_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/icons/hicolor/512x512/apps"
PLANNOTATOR_PKG="@plannotator/pi-extension"
OMP_PKG="@oh-my-pi/pi-coding-agent"

WHAT=""
OMP_CHOICE=""
PLANNOTATOR_CHOICE=""
VERSION="latest"
ASSUME_YES=0
UNINSTALL=0

# ------------------------------------------------------------------ output

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
	B=$'\033[1m' D=$'\033[2m' R=$'\033[0m' RED=$'\033[31m' GRN=$'\033[32m' YEL=$'\033[33m' CYN=$'\033[36m'
else
	B="" D="" R="" RED="" GRN="" YEL="" CYN=""
fi
STEP=0
STEPS=5
say() { printf '%s\n' "$*"; }
step() {
	STEP=$((STEP + 1))
	printf '\n%s[%d/%d] %s%s\n' "$B$CYN" "$STEP" "$STEPS" "$*" "$R"
}
ok() { printf '  %s✓%s %s\n' "$GRN" "$R" "$*"; }
note() { printf '  %s%s%s\n' "$D" "$*" "$R"; }
warn() { printf '  %s!%s %s\n' "$YEL" "$R" "$*"; }
die() {
	printf '\n%s✗ %s%s\n' "$RED" "$*" "$R" >&2
	exit 1
}
cmd() { printf '      %s$ %s%s\n' "$B" "$*" "$R"; }

# Prompts read from the terminal, so they work under `curl … | bash`.
INTERACTIVE=0
if [ -r /dev/tty ] && [ -w /dev/tty ] && { : </dev/tty; } 2>/dev/null; then INTERACTIVE=1; fi

# ask_yn "Question" y|n  → returns 0 for yes. Non-interactive or --yes: the default.
ask_yn() {
	local question="$1" default="$2" hint answer
	if [ "$ASSUME_YES" = 1 ] || [ "$INTERACTIVE" = 0 ]; then
		[ "$default" = y ]
		return
	fi
	if [ "$default" = y ]; then hint="[Y/n]"; else hint="[y/N]"; fi
	while true; do
		printf '  %s?%s %s %s ' "$CYN" "$R" "$question" "$hint" >/dev/tty
		IFS= read -r answer </dev/tty || answer=""
		case "${answer:-$default}" in
			[Yy] | [Yy][Ee][Ss]) return 0 ;;
			[Nn] | [Nn][Oo]) return 1 ;;
		esac
	done
}

# choose "Question" default_index "option 1" "option 2" …  → sets CHOICE (1-based).
choose() {
	local question="$1" default="$2" answer i
	shift 2
	if [ "$ASSUME_YES" = 1 ] || [ "$INTERACTIVE" = 0 ]; then
		CHOICE="$default"
		return
	fi
	printf '  %s?%s %s\n' "$CYN" "$R" "$question" >/dev/tty
	i=1
	for option in "$@"; do
		printf '      %s%d)%s %s\n' "$B" "$i" "$R" "$option" >/dev/tty
		i=$((i + 1))
	done
	while true; do
		printf '    choice [%s]: ' "$default" >/dev/tty
		IFS= read -r answer </dev/tty || answer=""
		answer="${answer:-$default}"
		if [[ "$answer" =~ ^[0-9]+$ ]] && [ "$answer" -ge 1 ] && [ "$answer" -le $# ]; then
			CHOICE="$answer"
			return
		fi
	done
}

# ------------------------------------------------------------------ args

usage() {
	cat <<'USAGE'
Gyre installer

  curl -fsSL https://raw.githubusercontent.com/oOSomnus/gyre/main/install.sh | bash
  curl -fsSL …/install.sh | bash -s -- [flags]

  --web | --desktop | --both              what to install (default: ask)
  --install-omp | --no-omp                install omp if missing, or skip that step
  --with-plannotator | --no-plannotator   install the Plannotator plan-review plugin, or not
  --version vX.Y.Z                        a specific release (default: latest)
  --yes, -y                               accept the recommended answer for every question
  --uninstall                             remove what this script installed (keeps ~/.gyre)

  GYRE_INSTALL_DIR (default ~/.local/share/gyre), GYRE_BIN_DIR (default ~/.local/bin)
USAGE
}

while [ $# -gt 0 ]; do
	case "$1" in
		--web) WHAT=web ;;
		--desktop) WHAT=desktop ;;
		--both) WHAT=both ;;
		--install-omp) OMP_CHOICE=install ;;
		--no-omp) OMP_CHOICE=skip ;;
		--with-plannotator) PLANNOTATOR_CHOICE=install ;;
		--no-plannotator) PLANNOTATOR_CHOICE=skip ;;
		--version)
			[ $# -ge 2 ] || die "--version needs a value, e.g. --version v0.1.0"
			VERSION="$2"
			shift
			;;
		--version=*) VERSION="${1#--version=}" ;;
		-y | --yes) ASSUME_YES=1 ;;
		--uninstall) UNINSTALL=1 ;;
		-h | --help)
			usage
			exit 0
			;;
		*) die "unknown option: $1 (see --help)" ;;
	esac
	shift
done

# ------------------------------------------------------------------ helpers

TMP="$(mktemp -d "${TMPDIR:-/tmp}/gyre-install.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

have() { command -v "$1" >/dev/null 2>&1; }

download() { # url dest
	if have curl; then
		curl -fL --proto '=https,file' --progress-bar "$1" -o "$2"
	elif have wget; then
		wget -q --show-progress -O "$2" "$1"
	else
		die "curl or wget is required"
	fi
}

sha256() {
	if have sha256sum; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

verify() { # file name-in-SHA256SUMS
	local expected
	expected="$(awk -v n="$2" '$2 == n { print $1 }' "$TMP/SHA256SUMS")"
	[ -n "$expected" ] || die "$2 is not listed in the release checksums"
	[ "$(sha256 "$1")" = "$expected" ] || die "checksum mismatch for $2 (download corrupted?)"
}

BUN_HOME="${BUN_INSTALL:-$HOME/.bun}"
OMP=""
find_omp() {
	OMP=""
	if have omp; then
		OMP="$(command -v omp)"
		return 0
	fi
	for candidate in "$BUN_HOME/bin/omp" "$HOME/.local/bin/omp" /usr/local/bin/omp /opt/homebrew/bin/omp; do
		if [ -x "$candidate" ]; then
			OMP="$candidate"
			return 0
		fi
	done
	return 1
}

# omp is a Bun script (#!/usr/bin/env bun), so bun must be on PATH whenever omp
# runs. Bun's installer only edits shell rc files, so add its folder here.
BUN_DIR_ADDED=""
ensure_bun_on_path() {
	have bun && return 0
	local dir
	for dir in "$BUN_HOME/bin" ${OMP:+"$(dirname "$OMP")"}; do
		if [ -x "$dir/bun" ]; then
			export PATH="$dir:$PATH"
			BUN_DIR_ADDED="$dir"
			return 0
		fi
	done
	return 1
}

has_models() { # 0 = omp lists at least one model
	local out
	out="$("$OMP" models --json 2>/dev/null)" || return 1
	case "$out" in
		*'"models":[]'* | '') return 1 ;;
		*'"models":['*) return 0 ;;
		*) return 1 ;;
	esac
}

on_path() { case ":$PATH:" in *":$1:"*) return 0 ;; *) return 1 ;; esac; }

# ------------------------------------------------------------------ uninstall

if [ "$UNINSTALL" = 1 ]; then
	say "${B}Uninstalling Gyre${R}"
	rm -rf "$INSTALL_DIR" && ok "removed $INSTALL_DIR"
	rm -f "$BIN_DIR/gyre" "$BIN_DIR/Gyre.AppImage" "$APPS_DIR/gyre.desktop" "$ICONS_DIR/gyre.png" && ok "removed launchers and AppImage"
	if have dpkg && dpkg -s gyre >/dev/null 2>&1; then
		warn "The Gyre .deb package is installed; remove it with:"
		cmd "sudo apt remove gyre"
	fi
	note "Your Gyre data (~/.gyre), omp and Plannotator were left in place."
	note "Remove them with: rm -rf ~/.gyre ; omp plugin uninstall $PLANNOTATOR_PKG ; bun remove -g $OMP_PKG"
	exit 0
fi

# ------------------------------------------------------------------ platform

case "$(uname -s)" in
	Linux) OS=linux ;;
	Darwin) OS=darwin ;;
	*) die "unsupported OS $(uname -s); Gyre releases cover Linux and macOS" ;;
esac
case "$(uname -m)" in
	x86_64 | amd64) ARCH=x64 ;;
	aarch64 | arm64) ARCH=arm64 ;;
	*) die "unsupported CPU $(uname -m); Gyre releases cover x64 and arm64" ;;
esac
DESKTOP_OK=0
if [ "$OS" = linux ] && [ "$ARCH" = x64 ]; then DESKTOP_OK=1; fi

if [ -n "${GYRE_RELEASE_BASE:-}" ]; then
	BASE="${GYRE_RELEASE_BASE%/}"
elif [ "$VERSION" = latest ]; then
	BASE="https://github.com/$REPO/releases/latest/download"
else
	BASE="https://github.com/$REPO/releases/download/v${VERSION#v}"
fi

printf '\n%s  ◎ Gyre installer%s\n' "$B" "$R"
note "A tiled desktop UI for the omp coding agent · $OS-$ARCH · release: $VERSION"
[ "$INTERACTIVE" = 1 ] || note "No terminal for questions: using flags and recommended defaults."

# ------------------------------------------------------------------ 1. choose

step "What to install"
if [ -z "$WHAT" ]; then
	if [ "$DESKTOP_OK" = 1 ]; then
		choose "Which version of Gyre?" 1 \
			"Web: runs a local server, opens in your browser (also reachable from your phone)" \
			"Desktop app: a native window (.deb or AppImage)" \
			"Both"
		case "$CHOICE" in 1) WHAT=web ;; 2) WHAT=desktop ;; 3) WHAT=both ;; esac
	else
		WHAT=web
		note "The desktop app is built for Linux x64 only; installing the web version."
	fi
fi
if [ "$WHAT" != web ] && [ "$DESKTOP_OK" = 0 ]; then
	die "the desktop app is only available for linux-x64 (this is $OS-$ARCH); use --web"
fi
ok "Installing: $WHAT"

note "Fetching release information from $BASE"
download "$BASE/SHA256SUMS" "$TMP/SHA256SUMS" 2>/dev/null ||
	die "no Gyre release found at $BASE (has a release been published yet? see https://github.com/$REPO/releases)"
download "$BASE/gyre-manifest.json" "$TMP/gyre-manifest.json" 2>/dev/null || die "the release has no gyre-manifest.json"
verify "$TMP/gyre-manifest.json" gyre-manifest.json
GYRE_VERSION="$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$TMP/gyre-manifest.json")"
OMP_VERSION="$(sed -n 's/.*"ompVersion": *"\([^"]*\)".*/\1/p' "$TMP/gyre-manifest.json")"
ok "Gyre $GYRE_VERSION (tested with omp $OMP_VERSION)"

# ------------------------------------------------------------------ 2. install Gyre

step "Installing Gyre"
INSTALLED_WEB=0
INSTALLED_DESKTOP=""

install_web() {
	local asset="gyre-web-$OS-$ARCH.tar.gz"
	note "Downloading $asset"
	download "$BASE/$asset" "$TMP/$asset"
	verify "$TMP/$asset" "$asset"
	mkdir -p "$TMP/unpack" "$(dirname "$INSTALL_DIR")" "$BIN_DIR"
	tar -xzf "$TMP/$asset" -C "$TMP/unpack"
	[ -x "$TMP/unpack/gyre/gyre-gateway" ] || die "$asset does not contain gyre/gyre-gateway"
	rm -rf "$INSTALL_DIR.new"
	mv "$TMP/unpack/gyre" "$INSTALL_DIR.new"
	rm -rf "$INSTALL_DIR"
	mv "$INSTALL_DIR.new" "$INSTALL_DIR"
	cat >"$BIN_DIR/gyre" <<EOF
#!/bin/sh
# Gyre launcher (installed by install.sh). \`gyre --no-open\` skips opening the browser.
open=--open
if [ "\${1:-}" = "--no-open" ]; then open=; shift; fi
exec "$INSTALL_DIR/gyre-gateway" \$open "\$@"
EOF
	chmod +x "$BIN_DIR/gyre"
	ok "Web version → $INSTALL_DIR"
	ok "Launcher    → $BIN_DIR/gyre"
	if ! on_path "$BIN_DIR"; then
		warn "$BIN_DIR is not on your PATH. Add it, e.g.:"
		cmd "echo 'export PATH=\"$BIN_DIR:\$PATH\"' >> ~/.bashrc   # or ~/.zshrc"
	fi
	INSTALLED_WEB=1
}

install_desktop() {
	local how=2
	if have apt-get && have dpkg; then
		choose "How should the desktop app be installed?" 1 \
			"System package (.deb, uses sudo apt; adds Gyre to your app menu)" \
			"AppImage in $BIN_DIR (no sudo)"
		how="$CHOICE"
		# Non-interactive runs never prompt for a sudo password.
		if [ "$INTERACTIVE" = 0 ] || [ "$ASSUME_YES" = 1 ]; then how=2; fi
	fi
	if [ "$how" = 1 ]; then
		local asset="gyre-desktop-linux-x64.deb"
		note "Downloading $asset"
		download "$BASE/$asset" "$TMP/$asset"
		verify "$TMP/$asset" "$asset"
		note "Installing with apt (you may be asked for your password)"
		sudo apt-get install -y "$TMP/$asset" </dev/tty
		INSTALLED_DESKTOP=deb
		ok "Desktop app installed (.deb): launch \"Gyre\" from your app menu"
	else
		local asset="gyre-desktop-linux-x64.AppImage"
		note "Downloading $asset"
		download "$BASE/$asset" "$TMP/$asset"
		verify "$TMP/$asset" "$asset"
		mkdir -p "$BIN_DIR" "$APPS_DIR" "$ICONS_DIR"
		install -m 755 "$TMP/$asset" "$BIN_DIR/Gyre.AppImage"
		if download "$BASE/gyre-icon.png" "$TMP/gyre-icon.png" 2>/dev/null; then cp "$TMP/gyre-icon.png" "$ICONS_DIR/gyre.png"; fi
		cat >"$APPS_DIR/gyre.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Gyre
Comment=Tiled desktop UI for the omp coding agent
Exec=$BIN_DIR/Gyre.AppImage
Icon=gyre
Terminal=false
Categories=Development;
EOF
		have update-desktop-database && update-desktop-database "$APPS_DIR" >/dev/null 2>&1 || true
		INSTALLED_DESKTOP=appimage
		ok "Desktop app → $BIN_DIR/Gyre.AppImage (app menu entry added)"
		if ! ldconfig -p 2>/dev/null | grep -q 'libfuse.so.2'; then
			warn "AppImages need FUSE 2. If Gyre does not start, install it (Ubuntu/Debian):"
			cmd "sudo apt install libfuse2   # Ubuntu 24.04+: libfuse2t64"
		fi
		if ! ldconfig -p 2>/dev/null | grep -q 'libwebkit2gtk-4.1'; then
			warn "The desktop app needs WebKitGTK 4.1:"
			cmd "sudo apt install libwebkit2gtk-4.1-0"
		fi
	fi
}

case "$WHAT" in
	web) install_web ;;
	desktop) install_desktop ;;
	both)
		install_web
		install_desktop
		;;
esac

# ------------------------------------------------------------------ 3. omp

step "The omp coding agent (required)"
manual_omp() {
	note "Install omp yourself later with Bun:"
	cmd "curl -fsSL https://bun.sh/install | bash"
	cmd "bun install -g $OMP_PKG@$OMP_VERSION"
	note "More options: https://omp.sh"
}

# check_omp: 0 if $OMP runs (sets OMP_HAVE to its version). Otherwise warns,
# shows the error and clears OMP, so later steps skip it instead of failing.
OMP_HAVE=""
check_omp() {
	local out
	ensure_bun_on_path || true
	if out="$("$OMP" --version 2>&1)"; then
		OMP_HAVE="$(printf '%s\n' "$out" | head -n 1 | sed 's#^omp/##')"
		return 0
	fi
	warn "omp at $OMP does not run:"
	printf '%s\n' "$out" | sed 's/^/      /'
	OMP=""
	return 1
}

if find_omp; then
	if check_omp; then
		ok "omp $OMP_HAVE found at $OMP"
		if [ -n "$OMP_VERSION" ] && [ "$OMP_HAVE" != "$OMP_VERSION" ]; then
			note "This Gyre release is tested with omp $OMP_VERSION. To match it:"
			cmd "bun install -g $OMP_PKG@$OMP_VERSION"
		fi
	else
		manual_omp
	fi
elif [ "$OMP_CHOICE" = skip ]; then
	warn "omp is not installed (skipped with --no-omp). Gyre needs it to run chats."
	manual_omp
else
	say "  Gyre drives omp, an open-source coding agent (MIT). It is not installed yet."
	install_it=1
	if [ "$OMP_CHOICE" != install ]; then ask_yn "Install omp $OMP_VERSION now (via Bun)?" y || install_it=0; fi
	if [ "$install_it" = 1 ]; then
		BUN="$(command -v bun || true)"
		if [ -z "$BUN" ] && [ -x "$BUN_HOME/bin/bun" ]; then BUN="$BUN_HOME/bin/bun"; fi
		if [ -z "$BUN" ]; then
			say "  omp is installed with Bun (https://bun.sh), which is not installed either."
			if ask_yn "Install Bun now (runs Bun's official installer)?" y; then
				curl -fsSL https://bun.sh/install | bash
				BUN="$BUN_HOME/bin/bun"
			fi
		fi
		if [ -n "$BUN" ] && [ -x "$BUN" ]; then
			ensure_bun_on_path || true
			"$BUN" install -g "$OMP_PKG@$OMP_VERSION"
			if ! find_omp; then
				warn "omp was installed but not found. Open a new terminal and run: omp --version"
			elif check_omp; then
				ok "omp $OMP_HAVE installed at $OMP"
			fi
		else
			warn "Skipped: Bun is required to install omp."
			manual_omp
		fi
	else
		manual_omp
	fi
fi

# ------------------------------------------------------------------ 4. Plannotator

step "Plannotator plan review (optional)"
manual_plannotator() {
	note "Install it any time with:"
	cmd "omp plugin install $PLANNOTATOR_PKG"
}
if [ -z "$OMP" ]; then
	note "Needs omp; skipped."
	manual_plannotator
elif "$OMP" plugin list --json 2>/dev/null | grep -q "\"$PLANNOTATOR_PKG\""; then
	ok "Plannotator is already installed"
elif [ "$PLANNOTATOR_CHOICE" = skip ]; then
	note "Skipped (--no-plannotator)."
	manual_plannotator
else
	say "  Plannotator adds a visual review page for plans: annotate, comment and approve"
	say "  them inside Gyre. Without it, Gyre uses its own simpler review card."
	install_it=1
	if [ "$PLANNOTATOR_CHOICE" != install ]; then ask_yn "Install Plannotator (recommended)?" y || install_it=0; fi
	if [ "$install_it" = 1 ]; then
		if "$OMP" plugin install "$PLANNOTATOR_PKG"; then ok "Plannotator installed"; else
			warn "Plannotator could not be installed."
			manual_plannotator
		fi
	else
		manual_plannotator
	fi
fi

# ------------------------------------------------------------------ 5. provider

step "Your first model provider"
provider_help() {
	note "Gyre's chats need omp to have at least one model provider. Any of:"
	note " • Sign in with a subscription (Claude, ChatGPT/Codex, Copilot, …):"
	cmd "omp login"
	note " • Store an API key with omp (works for the desktop app too), e.g. Anthropic:"
	cmd "read -rsp 'API key: ' KEY && printf '{\"version\":1,\"credentials\":[{\"provider\":\"anthropic\",\"credential\":{\"type\":\"api_key\",\"key\":\"%s\"}}]}' \"\$KEY\" | omp auth import -"
	note " • Or export ANTHROPIC_API_KEY / OPENAI_API_KEY / GEMINI_API_KEY / OPENROUTER_API_KEY before starting Gyre,"
	note "   or add a local/custom endpoint in ~/.omp/agent/models.yml (see the README)."
	note "Gyre also shows these steps until a provider is configured."
}

store_api_key() {
	local provider key escaped
	choose "Which provider is the key for?" 1 "Anthropic" "OpenAI" "Google Gemini" "OpenRouter" "Other (type the omp provider id)"
	case "$CHOICE" in
		1) provider=anthropic ;;
		2) provider=openai ;;
		3) provider=google ;;
		4) provider=openrouter ;;
		5)
			printf '    provider id: ' >/dev/tty
			IFS= read -r provider </dev/tty || provider=""
			;;
	esac
	[ -n "$provider" ] || return 1
	printf '    API key for %s (input hidden): ' "$provider" >/dev/tty
	IFS= read -rs key </dev/tty || key=""
	printf '\n' >/dev/tty
	[ -n "$key" ] || return 1
	escaped="$(printf '%s' "$key" | sed 's/\\/\\\\/g; s/"/\\"/g')"
	# The key goes to omp on stdin: never on the command line or in shell history.
	printf '{"version":1,"credentials":[{"provider":"%s","credential":{"type":"api_key","key":"%s"}}]}' "$provider" "$escaped" | "$OMP" auth import - >/dev/null
	key="" escaped=""
}

if [ -z "$OMP" ]; then
	note "Install omp first; then configure a provider."
	provider_help
elif has_models; then
	ok "omp already has a model provider"
elif [ "$INTERACTIVE" = 0 ] || [ "$ASSUME_YES" = 1 ]; then
	warn "omp has no model provider yet."
	provider_help
else
	say "  omp has no model provider yet, so Gyre cannot start chats. Set one up now?"
	attempts=0
	while ! has_models && [ "$attempts" -lt 3 ]; do
		attempts=$((attempts + 1))
		choose "How do you want to connect a model?" 1 \
			"Sign in with a subscription account (runs \`omp login\`)" \
			"Paste an API key (stored by omp)" \
			"Later: show me the commands"
		case "$CHOICE" in
			1) "$OMP" login </dev/tty || warn "omp login did not finish." ;;
			2) store_api_key || warn "No key stored." ;;
			3) break ;;
		esac
		if has_models; then ok "Provider configured: omp lists models now"; elif [ "$CHOICE" != 3 ]; then warn "omp still lists no models."; fi
	done
	has_models || provider_help
fi

# ------------------------------------------------------------------ summary

printf '\n%s  ◎ Done%s\n' "$B$GRN" "$R"
if [ "$INSTALLED_WEB" = 1 ]; then
	say "  ${B}Web:${R} run ${B}gyre${R} — it starts the local server and opens Gyre in your browser."
	note "  (${B}gyre --no-open${R}${D} prints the URL instead; Ctrl-C stops the server.)"
fi
case "$INSTALLED_DESKTOP" in
	deb) say "  ${B}Desktop:${R} open \"Gyre\" from your app menu." ;;
	appimage) say "  ${B}Desktop:${R} open \"Gyre\" from your app menu, or run $BIN_DIR/Gyre.AppImage" ;;
esac
if [ -n "$BUN_DIR_ADDED" ]; then
	note "$BUN_DIR_ADDED (bun, omp) was not on your PATH. If a new terminal can't find omp, add it:"
	cmd "echo 'export PATH=\"$BUN_DIR_ADDED:\$PATH\"' >> ~/.bashrc   # or ~/.zshrc"
fi
note "Data lives in ~/.gyre. Uninstall: curl -fsSL https://raw.githubusercontent.com/$REPO/main/install.sh | bash -s -- --uninstall"
