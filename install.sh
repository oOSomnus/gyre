#!/usr/bin/env bash
# Gyre installer: installs the Gyre web (browser) version or the desktop app,
# the omp coding agent and the optional Plannotator plan-review plugin, and
# checks that omp has a model provider.
#
#   curl -fsSL https://raw.githubusercontent.com/oOSomnus/gyre/main/install.sh | bash
#
# Non-interactive (pass flags after `bash -s --`):
#   curl -fsSL …/install.sh | bash -s -- --web --with-plannotator --yes
#
# Flags:
#   --web | --desktop             what to install (default: ask; web if not interactive)
#   --deb | --appimage            how to install the desktop app (default: ask; AppImage if not interactive)
#   --install-omp | --no-omp      install omp if it is missing, or skip the omp step
#   --with-plannotator | --no-plannotator
#   --version vX.Y.Z              a specific release (default: latest)
#   --yes, -y                     accept the recommended answer for every question
#   --uninstall                   remove what this script installed (keeps ~/.gyre data)
#   --update --from X.Y.Z         update mode, used by `gyre update`: stop if X.Y.Z is
#                                 already the latest, offer to match omp, skip optional steps
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
UPDATE=0
FROM_VERSION=""
DESKTOP_HOW=""

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

  --web | --desktop                       what to install (default: ask)
  --deb | --appimage                      how to install the desktop app (default: ask)
  --install-omp | --no-omp                install omp if missing, or skip that step
  --with-plannotator | --no-plannotator   install the Plannotator plan-review plugin, or not
  --version vX.Y.Z                        a specific release (default: latest)
  --yes, -y                               accept the recommended answer for every question
  --uninstall                             remove what this script installed (keeps ~/.gyre)

  Once installed, `gyre update` updates Gyre to the latest release
  (`gyre update --version vX.Y.Z` for a specific one).

  GYRE_INSTALL_DIR (default ~/.local/share/gyre), GYRE_BIN_DIR (default ~/.local/bin)
USAGE
}

while [ $# -gt 0 ]; do
	case "$1" in
		--web) WHAT=web ;;
		--desktop) WHAT=desktop ;;
		--deb) DESKTOP_HOW=1 ;;
		--appimage) DESKTOP_HOW=2 ;;
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
		--update) UPDATE=1 ;;
		--from)
			[ $# -ge 2 ] || die "--from needs a value, e.g. --from 0.1.0"
			FROM_VERSION="$2"
			shift
			;;
		--from=*) FROM_VERSION="${1#--from=}" ;;
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

# publish_file SRC DEST [MODE]: replace DEST atomically (a temp file in DEST's folder,
# then a rename), so DEST is always the complete old or new file and a running copy
# keeps working. Returns non-zero, leaving DEST untouched, instead of exiting.
publish_file() {
	local src="$1" dest="$2" mode="${3:-644}" tmp
	tmp="$(mktemp "$(dirname "$dest")/.$(basename "$dest").XXXXXX" 2>/dev/null)" || return 1
	if cp "$src" "$tmp" && chmod "$mode" "$tmp" && mv -f "$tmp" "$dest"; then return 0; fi
	rm -f "$tmp"
	return 1
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

if [ "$UPDATE" = 1 ]; then
	printf '\n%s  ◎ Gyre update%s\n' "$B" "$R"
else
	printf '\n%s  ◎ Gyre installer%s\n' "$B" "$R"
fi
note "A tiled desktop UI for the omp coding agent · $OS-$ARCH · release: $VERSION"
[ "$INTERACTIVE" = 1 ] || note "No terminal for questions: using flags and recommended defaults."

# ------------------------------------------------------------------ 1. choose

step "What to install"
if [ -z "$WHAT" ]; then
	if [ "$DESKTOP_OK" = 1 ]; then
		choose "Which version of Gyre?" 1 \
			"Web: a local server that opens Gyre in your browser" \
			"Desktop app: a native window (.deb or AppImage)"
		case "$CHOICE" in 1) WHAT=web ;; 2) WHAT=desktop ;; esac
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
if [ "$UPDATE" = 1 ] && [ "$VERSION" = latest ] && [ -n "$FROM_VERSION" ] && [ "${FROM_VERSION#v}" = "${GYRE_VERSION#v}" ]; then
	printf '\n%s  ◎ Gyre %s is already up to date%s\n' "$B$GRN" "$GYRE_VERSION" "$R"
	exit 0
fi

# ------------------------------------------------------------------ 2. install Gyre

step "Installing Gyre"
# Replacing a release is one job: verify → stage → replace → publish the launcher.
# The launcher records the installed version and mode, so it is published last, and
# if publishing it fails the previous release is put back: the launcher and the
# release it starts always agree. (.deb installs go through apt, which this script
# cannot roll back; their launcher is only written after apt succeeds.)

# write_launcher MODE_FLAGS BODY: the `gyre` command, which starts the installed
# version. `gyre update [flags]` re-runs the latest installer with MODE_FLAGS, so an
# update replaces this install in place without asking what to install again.
# Returns non-zero, keeping the old launcher, when the new one cannot be published.
write_launcher() {
	mkdir -p "$BIN_DIR" 2>/dev/null || return 1
	cat >"$TMP/gyre-launcher" <<LAUNCHER
#!/bin/sh
# Gyre launcher (installed by install.sh).
GYRE_VERSION='$GYRE_VERSION'
# \`gyre update [--version vX.Y.Z]\` installs the latest (or given) release over this one.
if [ "\${1:-}" = update ]; then
	shift
	export GYRE_BIN_DIR="$BIN_DIR" GYRE_INSTALL_DIR="$INSTALL_DIR"
	url="\${GYRE_INSTALLER_URL:-https://raw.githubusercontent.com/$REPO/main/install.sh}"
	if command -v curl >/dev/null 2>&1; then
		script="\$(curl -fsSL --proto '=https,file' "\$url")"
	else
		script="\$(wget -qO- "\$url")"
	fi || { echo "gyre update: could not download the installer from \$url" >&2; exit 1; }
	exec bash -c "\$script" install.sh --update --from "\$GYRE_VERSION" $1 "\$@"
fi
$2
LAUNCHER
	publish_file "$TMP/gyre-launcher" "$BIN_DIR/gyre" 755 || return 1
	ok "Launcher → $BIN_DIR/gyre"
	if ! on_path "$BIN_DIR"; then
		warn "$BIN_DIR is not on your PATH. Add it, e.g.:"
		cmd "echo 'export PATH=\"$BIN_DIR:\$PATH\"' >> ~/.bashrc   # or ~/.zshrc"
	fi
}

install_web() {
	local asset="gyre-web-$OS-$ARCH.tar.gz"
	note "Downloading $asset"
	download "$BASE/$asset" "$TMP/$asset"
	verify "$TMP/$asset" "$asset"
	mkdir -p "$TMP/unpack" "$(dirname "$INSTALL_DIR")"
	tar -xzf "$TMP/$asset" -C "$TMP/unpack"
	[ -x "$TMP/unpack/gyre/gyre-gateway" ] || die "$asset does not contain gyre/gyre-gateway"
	# An earlier run that stopped mid-swap left the previous release in .old: put it back first.
	if [ ! -e "$INSTALL_DIR" ] && [ -d "$INSTALL_DIR.old" ]; then mv "$INSTALL_DIR.old" "$INSTALL_DIR"; fi
	# Stage next to the install, so the swap is two renames on one filesystem.
	rm -rf "$INSTALL_DIR.new" "$INSTALL_DIR.old"
	mv "$TMP/unpack/gyre" "$INSTALL_DIR.new" || die "could not stage the new release in $INSTALL_DIR.new"
	if [ -e "$INSTALL_DIR" ] && ! mv "$INSTALL_DIR" "$INSTALL_DIR.old"; then
		rm -rf "$INSTALL_DIR.new"
		die "could not move the current install aside ($INSTALL_DIR); nothing was changed"
	fi
	if ! mv "$INSTALL_DIR.new" "$INSTALL_DIR"; then
		restore_web
		die "could not move the new release into $INSTALL_DIR; kept the previous install"
	fi
	if ! write_launcher --web "# \`gyre --no-open\` prints the URL instead of opening the browser.
open=--open
if [ \"\${1:-}\" = \"--no-open\" ]; then open=; shift; fi
exec \"$INSTALL_DIR/gyre-gateway\" \$open \"\$@\""; then
		restore_web
		die "could not write the launcher $BIN_DIR/gyre; kept the previous install"
	fi
	rm -rf "$INSTALL_DIR.old"
	ok "Web version → $INSTALL_DIR"
}

# Undo a web swap: drop the new release and put the previous one (if any) back.
restore_web() {
	rm -rf "$INSTALL_DIR" "$INSTALL_DIR.new"
	if [ -e "$INSTALL_DIR.old" ]; then mv "$INSTALL_DIR.old" "$INSTALL_DIR"; fi
}

install_desktop() {
	local how=2 how_flag app install_failed=0 appimage_backup=""
	if [ -n "$DESKTOP_HOW" ]; then
		how="$DESKTOP_HOW"
	elif have apt-get && have dpkg; then
		choose "How should the desktop app be installed?" 1 \
			"System package (.deb, uses sudo apt; adds Gyre to your app menu)" \
			"AppImage in $BIN_DIR (no sudo)"
		how="$CHOICE"
		# Non-interactive runs never prompt for a sudo password.
		if [ "$INTERACTIVE" = 0 ] || [ "$ASSUME_YES" = 1 ]; then how=2; fi
	fi
	if [ "$how" = 1 ] && ! { have apt-get && have dpkg; }; then
		die "--deb needs apt-get and dpkg; use --appimage"
	fi
	if [ "$how" = 1 ]; then
		how_flag=--deb
		local asset="gyre-desktop-linux-x64.deb"
		note "Downloading $asset"
		download "$BASE/$asset" "$TMP/$asset"
		verify "$TMP/$asset" "$asset"
		# Like the method question, non-interactive and --yes runs never prompt for a
		# sudo password: `sudo -n` still works with passwordless or cached sudo.
		local sudo=(sudo) apt_opts=(-y)
		if [ "$INTERACTIVE" = 0 ] || [ "$ASSUME_YES" = 1 ]; then
			sudo=(sudo -n)
			note "Installing with apt (needs passwordless or cached sudo)"
		else
			note "Installing with apt (you may be asked for your password)"
		fi
		# An explicit --version may be older than the installed package.
		[ "$VERSION" = latest ] || apt_opts+=(--allow-downgrades)
		if [ "$INTERACTIVE" = 1 ]; then
			"${sudo[@]}" apt-get install "${apt_opts[@]}" "$TMP/$asset" </dev/tty || install_failed=1
		else
			"${sudo[@]}" apt-get install "${apt_opts[@]}" "$TMP/$asset" || install_failed=1
		fi
		if [ "${install_failed:-0}" = 1 ]; then
			die "apt could not install $asset. If sudo needs a password, run this in a terminal without --yes, or use --appimage"
		fi
		app=/usr/bin/gyre-desktop
		ok "Desktop app installed (.deb)"
	else
		how_flag=--appimage
		local asset="gyre-desktop-linux-x64.AppImage"
		note "Downloading $asset"
		download "$BASE/$asset" "$TMP/$asset"
		verify "$TMP/$asset" "$asset"
		mkdir -p "$BIN_DIR" "$APPS_DIR" "$ICONS_DIR"
		app="$BIN_DIR/Gyre.AppImage"
		# Keep the previous AppImage until the launcher is published (a hard link costs no space).
		rm -f "$app.old"
		if [ -e "$app" ]; then
			{ ln -f "$app" "$app.old" 2>/dev/null || cp -p "$app" "$app.old"; } || die "could not back up $app; nothing was changed"
			appimage_backup="$app.old"
		fi
		# Replaced by a rename, so a running Gyre keeps its file (no "text file busy").
		publish_file "$TMP/$asset" "$app" 755 || die "could not write $app"
		if download "$BASE/gyre-icon.png" "$TMP/gyre-icon.png" 2>/dev/null; then publish_file "$TMP/gyre-icon.png" "$ICONS_DIR/gyre.png" || true; fi
		cat >"$TMP/gyre.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Gyre
Comment=Tiled desktop UI for the omp coding agent
Exec=$BIN_DIR/Gyre.AppImage
Icon=gyre
Terminal=false
Categories=Development;
EOF
		publish_file "$TMP/gyre.desktop" "$APPS_DIR/gyre.desktop" || warn "could not add the app menu entry $APPS_DIR/gyre.desktop"
		have update-desktop-database && update-desktop-database "$APPS_DIR" >/dev/null 2>&1 || true
		ok "Desktop app → $app (app menu entry added)"
		if ! ldconfig -p 2>/dev/null | grep -q 'libfuse.so.2'; then
			warn "AppImages need FUSE 2. If Gyre does not start, install it (Ubuntu/Debian):"
			cmd "sudo apt install libfuse2   # Ubuntu 24.04+: libfuse2t64"
		fi
		if ! ldconfig -p 2>/dev/null | grep -q 'libwebkit2gtk-4.1'; then
			warn "The desktop app needs WebKitGTK 4.1:"
			cmd "sudo apt install libwebkit2gtk-4.1-0"
		fi
	fi
	if ! write_launcher "--desktop $how_flag" "# Starts the desktop app in the background; its output goes to ~/.gyre/desktop.log.
mkdir -p \"\$HOME/.gyre\"
nohup \"$app\" \"\$@\" >\"\$HOME/.gyre/desktop.log\" 2>&1 &"; then
		if [ -n "$appimage_backup" ]; then
			mv -f "$appimage_backup" "$app" && die "could not write the launcher $BIN_DIR/gyre; kept the previous AppImage"
		elif [ "$how" = 2 ]; then
			rm -f "$app"
		fi
		die "could not write the launcher $BIN_DIR/gyre"
	fi
	[ -z "$appimage_backup" ] || rm -f "$appimage_backup"
}

case "$WHAT" in
	web) install_web ;;
	desktop) install_desktop ;;
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
			if [ "$UPDATE" = 1 ] && [ "$OMP_CHOICE" != skip ] && have bun &&
				ask_yn "Update omp $OMP_HAVE to $OMP_VERSION (the version this release is tested with)?" y; then
				if ! { bun install -g "$OMP_PKG@$OMP_VERSION" && check_omp; }; then
					warn "omp could not be updated. To try again:"
					cmd "bun install -g $OMP_PKG@$OMP_VERSION"
				elif [ "$OMP_HAVE" = "$OMP_VERSION" ]; then
					ok "omp $OMP_HAVE installed at $OMP"
				else
					warn "Bun installed omp $OMP_VERSION, but $OMP still reports $OMP_HAVE: another omp comes first on your PATH."
					note "Remove that copy, or put Bun's global bin folder first on your PATH, e.g.:"
					cmd "export PATH=\"\$(bun pm bin -g):\$PATH\"   # add to ~/.bashrc or ~/.zshrc"
				fi
			else
				note "This Gyre release is tested with omp $OMP_VERSION. To match it:"
				cmd "bun install -g $OMP_PKG@$OMP_VERSION"
			fi
		fi
	else
		manual_omp
	fi
elif [ "$UPDATE" = 1 ]; then
	warn "omp is not installed. Gyre needs it to run chats."
	manual_omp
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
elif [ "$UPDATE" = 1 ]; then
	note "Not installed; updates leave it out."
	manual_plannotator
elif [ "$PLANNOTATOR_CHOICE" = skip ]; then
	note "Skipped (--no-plannotator)."
	manual_plannotator
else
	say "  Plannotator adds a review page for plans where you annotate, comment and approve."
	say "  Without it, Gyre uses its own simpler review card."
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

# Gyre does not set up providers: omp owns that, so only check and point there.
step "Model provider"
if [ -z "$OMP" ]; then
	note "Needs omp; skipped."
elif has_models; then
	ok "omp has a model provider"
else
	warn "omp has no model provider yet, so Gyre cannot start chats."
	note "Set one up in omp first, e.g. sign in with:"
	cmd "omp login"
	note "API keys and other options: https://github.com/can1357/oh-my-pi#readme"
fi

# ------------------------------------------------------------------ summary

if [ "$UPDATE" = 1 ]; then
	printf '\n%s  ◎ Updated Gyre %s → %s%s\n' "$B$GRN" "${FROM_VERSION:-?}" "$GYRE_VERSION" "$R"
	say "  Restart Gyre if it is running to use the new version."
else
	printf '\n%s  ◎ Done%s\n' "$B$GRN" "$R"
fi
[ "$UPDATE" = 1 ] || case "$WHAT" in
	web)
		say "  Run ${B}gyre${R} to start the local server and open Gyre in your browser."
		note "${B}gyre --no-open${R}${D} prints the URL instead. Ctrl-C stops the server."
		;;
	desktop) say "  Run ${B}gyre${R}, or open Gyre from your app menu." ;;
esac
if [ -n "$BUN_DIR_ADDED" ]; then
	note "$BUN_DIR_ADDED (bun, omp) was not on your PATH. If a new terminal can't find omp, add it:"
	cmd "echo 'export PATH=\"$BUN_DIR_ADDED:\$PATH\"' >> ~/.bashrc   # or ~/.zshrc"
fi
note "Data lives in ~/.gyre. Uninstall: curl -fsSL https://raw.githubusercontent.com/$REPO/main/install.sh | bash -s -- --uninstall"
