<img src="docs/assets/gyre-icon.png" width="96" alt="Gyre's gyroscope mark" />

# Gyre

A tiled, keyboard-first desktop UI for the [omp](https://github.com/can1357/oh-my-pi) coding agent.

- **Agent:** omp, unmodified. All of its tools, slash commands, skills, MCP servers, sessions and model providers are available.
- **UI:** five themes, auto-tiling and floating panes, keyboard mode and jump marks, palettes, an event graph, a task manager, Agent Studio, MCP and model-role settings, a phone layout and remote access. See [docs/ux-spec.md](docs/ux-spec.md).
- **Plan mode:** omp's plan mode is TUI-only, so Gyre adds it over RPC with a small omp extension: plan, review (in [Plannotator](https://github.com/backnotprop/plannotator) when installed), refine, approve. Shell commands are not sandboxed while planning.
- **Upstream:** Gyre drives omp over its versioned RPC protocol and never forks it. See [Tracking omp upstream](docs/architecture.md#tracking-omp-upstream).

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/oOSomnus/gyre/main/install.sh | bash
```

The installer asks a few questions:

1. **Which version:** **Web** (a local server you open in a browser; Linux and macOS, x64 and arm64) or the **Desktop app** (Linux x64: `.deb` with apt, or an AppImage without sudo).
2. **omp:** if missing, it installs the omp version this release is tested with, using Bun (and installs Bun if needed).
3. **Plannotator (optional):** the plan-review plugin.
4. **Model provider:** it checks that omp has one and, if not, tells you how to add it (see [below](#model-provider)).

Downloads come from the latest [GitHub release](https://github.com/oOSomnus/gyre/releases) and are checked against its `SHA256SUMS`.

Then run `gyre`. For the web version it starts the server and opens your browser (`gyre --no-open` prints the URL instead; Ctrl-C stops the server). For the desktop app it opens the window; the app menu works too.

**Options.** Pass flags after `bash -s --`, e.g. `curl -fsSL …/install.sh | bash -s -- --web --with-plannotator --yes`:

| Flag | Effect |
|---|---|
| `--web`, `--desktop` | What to install (default: ask) |
| `--install-omp`, `--no-omp` | Install omp if missing without asking, or skip the omp step |
| `--with-plannotator`, `--no-plannotator` | Install Plannotator without asking, or skip it |
| `--version vX.Y.Z` | A specific release instead of the latest |
| `--yes` | Accept the recommended answer for every question (never prompts for sudo) |
| `--uninstall` | Remove what the installer added; keeps your data in `~/.gyre` |

The `gyre` command and the AppImage go to `~/.local/bin`, and the web version to `~/.local/share/gyre` (override with `GYRE_BIN_DIR`, `GYRE_INSTALL_DIR`). Gyre's data (projects, workspaces) lives in `~/.gyre`.

### Installing omp manually

Gyre needs [omp](https://github.com/can1357/oh-my-pi): `omp` on `PATH`, or `OMP_PATH` set to it.

```bash
curl -fsSL https://bun.sh/install | bash          # Bun, if you don't have it
bun install -g @oh-my-pi/pi-coding-agent           # omp (pin a version with @x.y.z)
omp --version
```

### Installing Plannotator manually (optional)

Plannotator adds a review page for plans (annotate, comment, approve). Gyre shows it in the Plan pane when installed and its own review card otherwise.

```bash
omp plugin install @plannotator/pi-extension
```

Restart open chats afterwards (Task Manager → Restart).

### Model provider

omp needs at least one model provider before Gyre can start chats. Set it up in omp, for example with `omp login`; [omp's README](https://github.com/can1357/oh-my-pi#readme) covers API keys and local models. Until then Gyre shows a reminder; press **Re-check** when done.

## Projects

A project is a folder on the machine running Gyre; its chats, terminals and file viewer run inside it. **Add project** (top bar, palette or Settings → Projects) opens a folder browser where you can click through folders, filter by typing or paste a path. **Settings → Projects** lets you rename a project, start a chat in it or remove it. Removing a project stops its chats and terminals and closes its panes; files on disk are not touched.

## Remote access

```bash
GYRE_HOST=0.0.0.0 GYRE_ALLOWED_HOSTS=my-laptop.tailnet.ts.net GYRE_TOKEN='replace-with-a-long-secret' gyre --no-open
```

Open `http://my-laptop.tailnet.ts.net:7341/#token=<secret>` once on the other device; a 30-day cookie remembers it. SSH port forwarding needs none of these settings.

## Development

Requirements: omp with a model provider, Bun ≥ 1.4.4 (this repo pins 1.4.5), and for the desktop app Rust plus Tauri's Linux dependencies (webkit2gtk-4.1).

### Run from source

```bash
bun install
bun run --cwd packages/web build
bun packages/gateway/src/main.ts      # prints the URL; add --open to open it
```

UI with hot reload:

```bash
GYRE_TOKEN=dev bun packages/gateway/src/main.ts
VITE_GYRE_TOKEN=dev bun run --cwd packages/web dev   # http://127.0.0.1:5173
```

Desktop app:

```bash
bun install --cwd apps/desktop
bun scripts/build-desktop.ts --bundles deb    # → apps/desktop/src-tauri/target/release/bundle/deb/
bun scripts/build-desktop.ts --sidecar-only && (cd apps/desktop && ./node_modules/.bin/tauri dev)   # development
```

### Tests

```bash
bun run test     # web, omp extension and gateway tests (gateway contract tests use the real omp)
# UI end-to-end in Chromium (no model calls), against a running gateway:
GYRE_TOKEN=e2e GYRE_OMP_ARGS=--no-session GYRE_PORT=7399 GYRE_DATA_DIR=$(mktemp -d) \
  bun packages/gateway/src/main.ts &
bun packages/e2e/run.ts
```

### Releases

```bash
bun scripts/build-release.ts --target linux-x64      # web tarball, manifest and checksums in dist/release
GYRE_RELEASE_BASE=file://$PWD/dist/release bash install.sh --web --no-omp --yes   # try the installer locally
git tag v0.2.0 && git push origin v0.2.0             # CI builds everything and publishes the release
```

To upgrade omp, see [the upgrade procedure](docs/architecture.md#upgrade-procedure).

## Docs

- [docs/ux-spec.md](docs/ux-spec.md): screens, keyboard map, and which omp command or event drives each element.
- [docs/architecture.md](docs/architecture.md): gateway, wire protocol, state, desktop shell, releases, and how Gyre tracks omp upstream.

## Licensing

Gyre is released under the [MIT License](LICENSE).

- omp is MIT licensed and runs as a separate, unmodified program.
- Fonts: Space Grotesk and JetBrains Mono (SIL Open Font License), bundled through `@fontsource`.
- Plannotator is optional; when installed, Gyre embeds its review page.
