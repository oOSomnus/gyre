<img src="docs/assets/gyre-icon.png" width="96" alt="Gyre's gyroscope mark" />

# Gyre

A tiled, keyboard-first desktop UI for the [omp](https://github.com/can1357/oh-my-pi) coding agent.

- **Agent:** omp, unmodified. All of its tools, slash commands, skills, MCP servers, sessions and model providers are available.
- **UX:** five themes (Graphite, Riso, Phosphor, Dune, Dusk) and a live gyroscope that shows what your agents are doing; auto-tiling panes with a hidden-pane bar, floating panes and workspace minimaps; tinted event cards; keyboard mode, jump marks and palettes; plan review with Plannotator; objectives, event graph, task manager, Agent Studio, MCP and model-role settings; phone layout and remote access.
- **Plan mode:** omp's plan mode is TUI-only, so Gyre ships a small omp extension (`packages/omp-extension`) that brings the same workflow to RPC: plan on the plan-role model, review (in Plannotator when installed), refine, then approve with the role and context handling you pick.
- Shell access in plan mode follows omp’s instruction-based policy. File-tool writes are restricted, but shell commands are not sandboxed.
- **Upstream:** Gyre drives omp over its versioned RPC protocol and never forks it. See [Tracking omp upstream](docs/architecture.md#tracking-omp-upstream).

## Requirements

- [omp](https://omp.sh) installed and signed in to at least one provider (`omp` on `PATH`, or set `OMP_PATH`)
- Bun ≥ 1.4.4 (this repo pins 1.4.5)
- For the desktop build: Rust, plus Tauri's Linux deps (webkit2gtk-4.1)

## Run it (browser)

```bash
bun install
bun run --cwd packages/web build
bun packages/gateway/src/main.ts      # prints: open http://127.0.0.1:7341/#token=…
```

To work on the UI with hot reload:

```bash
GYRE_TOKEN=dev bun packages/gateway/src/main.ts
VITE_GYRE_TOKEN=dev bun run --cwd packages/web dev   # http://127.0.0.1:5173
```

## Desktop app

```bash
bun install --cwd apps/desktop
bun scripts/build-desktop.ts --bundles deb    # → apps/desktop/src-tauri/target/release/bundle/deb/*.deb
# development:
bun scripts/build-desktop.ts --sidecar-only && (cd apps/desktop && ./node_modules/.bin/tauri dev)
```

## Tests

```bash
bun run test                           # omp extension tests + gateway unit tests (fake omp) + contract tests (real omp)
# UI end-to-end (no model calls), against a running gateway:
GYRE_TOKEN=e2e GYRE_OMP_ARGS=--no-session GYRE_PORT=7399 GYRE_DATA_DIR=$(mktemp -d) \
  bun packages/gateway/src/main.ts &
bun packages/e2e/run.ts          # uses packages/e2e/fixtures/demo-project
```

## Remote access

```bash
GYRE_HOST=0.0.0.0 GYRE_ALLOWED_HOSTS=my-laptop.tailnet.ts.net GYRE_TOKEN='replace-with-a-long-secret' bun packages/gateway/src/main.ts
```

Open `http://my-laptop.tailnet.ts.net:7341/#token=<secret>` once on the other device; a 30-day HttpOnly cookie remembers it. SSH port forwarding needs no settings.

## Upgrading omp

```bash
bun scripts/bump-omp.ts      # match the installed omp; runs typecheck + tests + contract
```

## Docs

- [docs/ux-spec.md](docs/ux-spec.md): screen inventory, keyboard map, and which omp command or event drives each element
- [docs/architecture.md](docs/architecture.md): gateway, wire protocol, state, desktop shell, and the no-fork rules with the coupling points guarded by tests

## Licensing

- omp is MIT licensed (© Mario Zechner and contributors) and runs as a separate, unmodified program.
- Fonts: Space Grotesk and JetBrains Mono (SIL Open Font License), bundled through `@fontsource`.
- Plannotator is optional; when its omp extension is installed Gyre embeds its review page.
