/**
 * The Gyre mark, live. Every instance shares one animation loop; instances that
 * are off screen are skipped, nothing runs while the page is hidden, and
 * reduced-motion users get a still pose that only redraws on state or theme
 * changes. Colours come from the theme's --gy-* tokens.
 */
import { useEffect, useRef } from "react";
import { drawGyro, easeColors, type GyroMotion, type GyroPalette, type GyroState, newMotion, type PartColor, parseColor, stepMotion, targetColors } from "../lib/gyro";
import { useApp } from "../store/app";

interface Instance {
	host: HTMLElement;
	canvas: HTMLCanvasElement;
	ctx: CanvasRenderingContext2D;
	motion: GyroMotion;
	colors: PartColor[] | null;
	palette: GyroPalette;
	state: GyroState;
	visible: boolean;
	px: number;
	detail: boolean;
	dirty: boolean;
}

const instances = new Set<Instance>();
const reduceMotion = typeof window !== "undefined" ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
let frameId = 0;
let last = 0;
let seed = 0;

function readPalette(el: HTMLElement): GyroPalette {
	const cs = getComputedStyle(el);
	const get = (name: string) => parseColor(cs.getPropertyValue(name));
	return { metal: get("--gy-metal"), hi: get("--gy-hi"), work: get("--gy-work"), alert: get("--gy-alert"), steps: Number.parseInt(cs.getPropertyValue("--gy-steps"), 10) || 0 };
}

function render(inst: Instance, dt: number, animate: boolean) {
	const target = targetColors(inst.palette, inst.state);
	inst.colors = inst.colors && animate ? easeColors(inst.colors, target, dt) : target;
	if (animate) stepMotion(inst.motion, inst.state, dt);
	drawGyro(inst.ctx, inst.px, inst.motion, inst.colors, inst.palette, inst.detail);
	inst.dirty = false;
}

function tick(t: number) {
	frameId = 0;
	const dt = last ? Math.min(0.05, (t - last) / 1000) : 0;
	last = t;
	const still = reduceMotion?.matches ?? false;
	if (!document.hidden) {
		for (const inst of instances) {
			if (still) {
				if (inst.dirty) render(inst, 0, false);
			} else {
				// Off-screen instances keep their motion advancing but skip drawing.
				if (inst.visible) render(inst, dt, true);
				else stepMotion(inst.motion, inst.state, dt);
			}
		}
	}
	if (instances.size > 0) frameId = requestAnimationFrame(tick);
}

function ensureLoop() {
	if (!frameId && instances.size > 0) {
		last = 0;
		frameId = requestAnimationFrame(tick);
	}
}

function sizeCanvas(inst: Instance, size: number) {
	const dpr = Math.min(2, window.devicePixelRatio || 1);
	inst.px = Math.round(size * dpr);
	inst.canvas.width = inst.px;
	inst.canvas.height = inst.px;
	inst.detail = size >= 64;
	inst.dirty = true;
}

export function Gyroscope({
	state,
	size,
	title,
	onClick,
	className = "",
	label = "Gyre",
}: {
	state: GyroState;
	size: number;
	title?: string;
	onClick?: () => void;
	className?: string;
	label?: string;
}) {
	const hostRef = useRef<HTMLElement | null>(null);
	const canvasRef = useRef<HTMLCanvasElement>(null);
	const instRef = useRef<Instance | null>(null);
	const theme = useApp(s => s.theme);

	useEffect(() => {
		const host = hostRef.current;
		const canvas = canvasRef.current;
		const ctx = canvas?.getContext("2d");
		if (!host || !canvas || !ctx) return;
		const inst: Instance = {
			host,
			canvas,
			ctx,
			motion: newMotion(seed++),
			colors: null,
			palette: readPalette(host),
			state,
			visible: true,
			px: 0,
			detail: false,
			dirty: true,
		};
		sizeCanvas(inst, size);
		instRef.current = inst;
		instances.add(inst);
		const io = new IntersectionObserver(entries => {
			for (const e of entries) inst.visible = e.isIntersecting;
		});
		io.observe(host);
		render(inst, 0, false);
		ensureLoop();
		return () => {
			io.disconnect();
			instances.delete(inst);
			instRef.current = null;
		};
		// Mount once; state, size and theme changes are applied by the effects below.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	useEffect(() => {
		const inst = instRef.current;
		if (!inst) return;
		inst.state = state;
		inst.dirty = true;
		ensureLoop();
	}, [state]);

	useEffect(() => {
		const inst = instRef.current;
		if (!inst) return;
		sizeCanvas(inst, size);
		render(inst, 0, false);
	}, [size]);

	useEffect(() => {
		const inst = instRef.current;
		if (!inst) return;
		// The theme attribute is already applied; read the new tokens on the next frame.
		const id = requestAnimationFrame(() => {
			inst.palette = readPalette(inst.host);
			inst.colors = null;
			render(inst, 0, false);
		});
		return () => cancelAnimationFrame(id);
	}, [theme]);

	const style = { width: size, height: size };
	const canvas = <canvas ref={canvasRef} aria-hidden />;
	if (onClick) {
		return (
			<button
				type="button"
				ref={el => {
					hostRef.current = el;
				}}
				className={`gy-gyro ${className}`}
				style={style}
				data-state={state}
				title={title}
				aria-label={label}
				onClick={onClick}
			>
				{canvas}
			</button>
		);
	}
	return (
		<span
			ref={el => {
				hostRef.current = el;
			}}
			className={`gy-gyro ${className}`}
			style={style}
			data-state={state}
			title={title}
			role="img"
			aria-label={label}
		>
			{canvas}
		</span>
	);
}
