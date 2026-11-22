/**
 * The Gyre gyroscope: three gimbal rings on pivot pins around a rotor spinning
 * on its axle. Pure geometry, motion and shading; `drawGyro` paints one frame
 * onto a 2D canvas. No WebGL, so it runs in every webview.
 */
export type GyroState = "idle" | "working" | "needs";
export type RGB = [number, number, number];

export interface GyroPalette {
	metal: RGB;
	hi: RGB;
	work: RGB;
	alert: RGB;
	/** Posterise lighting into this many steps (0 = smooth). */
	steps: number;
}

export interface PartColor {
	base: RGB;
	emis: number;
	ec: RGB;
}

/** Angles in degrees; velocities in degrees per second. */
export interface GyroMotion {
	a: [number, number, number];
	yaw: number;
	spin: number;
	v: [number, number, number, number, number];
}

export type DrawItem =
	| { z: number; pts: Array<[number, number]>; fill: string }
	| { z: number; a: [number, number]; b: [number, number]; width: number; color: string };

/** ring0, ring1, ring2, precession, rotor */
export const SPEEDS: Record<GyroState, GyroMotion["v"]> = {
	idle: [16, 11, 21, 4, 120],
	working: [95, 70, 130, 9, 1400],
	needs: [0, 9, 14, 0, 240],
};

const D = Math.PI / 180;
const F = 4.2; // eye distance in outer-ring radii
type M3 = number[];
const rx = (t: number): M3 => [1, 0, 0, 0, Math.cos(t), -Math.sin(t), 0, Math.sin(t), Math.cos(t)];
const ry = (t: number): M3 => [Math.cos(t), 0, Math.sin(t), 0, 1, 0, -Math.sin(t), 0, Math.cos(t)];
const rz = (t: number): M3 => [Math.cos(t), -Math.sin(t), 0, Math.sin(t), Math.cos(t), 0, 0, 0, 1];
function mul(A: M3, B: M3): M3 {
	const r = new Array<number>(9);
	for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) r[i * 3 + j] = A[i * 3]! * B[j]! + A[i * 3 + 1]! * B[3 + j]! + A[i * 3 + 2]! * B[6 + j]!;
	return r;
}
const ap = (M: M3, x: number, y: number, z: number): [number, number, number] => [
	M[0]! * x + M[1]! * y + M[2]! * z,
	M[3]! * x + M[4]! * y + M[5]! * z,
	M[6]! * x + M[7]! * y + M[8]! * z,
];
function norm(v: [number, number, number]): [number, number, number] {
	const l = Math.hypot(v[0], v[1], v[2]) || 1;
	return [v[0] / l, v[1] / l, v[2] / l];
}
const L = norm([-0.45, 0.75, 0.6]);
const H = norm([L[0], L[1], L[2] + 1]);

export const mix = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

export function parseColor(value: string, fallback: RGB = [170, 180, 195]): RGB {
	const v = value.trim();
	const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(v)?.[1];
	if (hex) {
		const full = hex.length === 3 ? [...hex].map(c => c + c).join("") : hex;
		const n = Number.parseInt(full, 16);
		return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
	}
	const rgb = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/i.exec(v);
	return rgb ? [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])] : fallback;
}

export function newMotion(seed = 0): GyroMotion {
	return { a: [38 + seed * 41, 62 + seed * 29, 24 + seed * 53], yaw: seed * 17, spin: 0, v: [...SPEEDS.idle] };
}

export function targetColors(pal: GyroPalette, state: GyroState): PartColor[] {
	const plain: PartColor = { base: pal.metal, emis: 0, ec: pal.work };
	if (state === "working") {
		const ring: PartColor = { base: mix(pal.metal, pal.work, 0.32), emis: 0.8, ec: pal.work };
		return [ring, ring, ring, { base: mix(pal.metal, pal.work, 0.5), emis: 0.6, ec: pal.work }];
	}
	if (state === "needs") return [{ base: mix(pal.metal, pal.alert, 0.72), emis: 0.9, ec: pal.alert }, plain, plain, plain];
	return [plain, plain, plain, plain];
}

export function easeColors(current: PartColor[], target: PartColor[], dt: number): PartColor[] {
	const k = Math.min(1, dt * 4);
	return current.map((c, i) => {
		const t = target[i]!;
		return { base: mix(c.base, t.base, k), ec: mix(c.ec, t.ec, k), emis: c.emis + (t.emis - c.emis) * k };
	});
}

export function stepMotion(m: GyroMotion, state: GyroState, dt: number): void {
	const s = SPEEDS[state];
	const k = Math.min(1, dt * 2);
	for (let j = 0; j < 5; j++) m.v[j] = m.v[j]! + (s[j]! - m.v[j]!) * k;
	m.a[0] += m.v[0] * dt;
	m.a[1] += m.v[1] * dt;
	m.a[2] += m.v[2] * dt;
	m.yaw += m.v[3] * dt;
	m.spin += m.v[4] * dt;
	if (state === "needs") {
		// Bring the outer ring round to face the viewer and hold it there.
		const total = m.yaw + m.a[0];
		const face = Math.round(total / 180) * 180;
		m.a[0] += (face - total) * Math.min(1, dt * 3);
	}
}

/** Builds the depth-sorted draw list for one frame on a `px`-sized square canvas. */
export function buildItems(m: GyroMotion, colors: PartColor[], pal: GyroPalette, px: number, detail: boolean): DrawItem[] {
	// Large marks leave room for the contact shadow; small ones fill their box.
	const S = px * (detail ? 0.34 : 0.4);
	const cx = px / 2;
	const cy = px * (detail ? 0.47 : 0.5);
	const proj = (p: [number, number, number]): [number, number] => {
		const s = F / (F - p[2]);
		return [cx + p[0] * S * s, cy - p[1] * S * s];
	};
	const items: DrawItem[] = [];
	const shade = (nv: [number, number, number], c: PartColor, tone: number): string => {
		const d = Math.max(0, nv[0] * L[0] + nv[1] * L[1] + nv[2] * L[2]);
		let h = Math.max(0, nv[0] * H[0] + nv[1] * H[1] + nv[2] * H[2]) ** 34;
		let lum = (0.26 + 0.82 * d) * tone;
		if (pal.steps) {
			lum = Math.round(lum * pal.steps) / pal.steps;
			h = h > 0.45 ? 1 : 0;
		}
		const fr = (1 - Math.abs(nv[2])) ** 2.2 * c.emis;
		const ch = (i: 0 | 1 | 2) => Math.max(0, Math.min(255, Math.round(c.base[i] * lum + pal.hi[i] * h * 0.9 + c.ec[i] * fr)));
		return `rgb(${ch(0)},${ch(1)},${ch(2)})`;
	};
	const quad = (M: M3, vs: Array<[number, number, number]>, n: [number, number, number], c: PartColor, tone = 1) => {
		const w = vs.map(v => ap(M, v[0], v[1], v[2]));
		const nv = ap(M, n[0], n[1], n[2]);
		const mid: [number, number, number] = [(w[0]![0] + w[2]![0]) / 2, (w[0]![1] + w[2]![1]) / 2, (w[0]![2] + w[2]![2]) / 2];
		if (nv[0] * -mid[0] + nv[1] * -mid[1] + nv[2] * (F - mid[2]) <= 0) return; // back face
		items.push({ z: mid[2], pts: w.map(proj), fill: shade(nv, c, tone) });
	};
	const line = (M: M3, a: [number, number, number], b: [number, number, number], width: number, color: string) => {
		const A = ap(M, ...a);
		const B = ap(M, ...b);
		items.push({ z: (A[2] + B[2]) / 2 + 0.01, a: proj(A), b: proj(B), width, color });
	};
	const N = detail ? 60 : 36;
	const ring = (M: M3, Ro: number, w: number, t: number, c: PartColor) => {
		const Ri = Ro - w;
		for (let i = 0; i < N; i++) {
			const t0 = (i / N) * 2 * Math.PI;
			const t1 = ((i + 1) / N) * 2 * Math.PI;
			const tm = (t0 + t1) / 2;
			const [c0, s0, c1, s1] = [Math.cos(t0), Math.sin(t0), Math.cos(t1), Math.sin(t1)];
			quad(M, [[Ri * c0, Ri * s0, t], [Ro * c0, Ro * s0, t], [Ro * c1, Ro * s1, t], [Ri * c1, Ri * s1, t]], [0, 0, 1], c);
			quad(M, [[Ri * c1, Ri * s1, -t], [Ro * c1, Ro * s1, -t], [Ro * c0, Ro * s0, -t], [Ri * c0, Ri * s0, -t]], [0, 0, -1], c);
			quad(M, [[Ro * c0, Ro * s0, -t], [Ro * c1, Ro * s1, -t], [Ro * c1, Ro * s1, t], [Ro * c0, Ro * s0, t]], [Math.cos(tm), Math.sin(tm), 0], c, 0.92);
			quad(M, [[Ri * c1, Ri * s1, -t], [Ri * c0, Ri * s0, -t], [Ri * c0, Ri * s0, t], [Ri * c1, Ri * s1, t]], [-Math.cos(tm), -Math.sin(tm), 0], c, 0.7);
		}
	};

	const T = mul(rz(-0.22), mul(rx(-0.36), ry(m.yaw * D)));
	const M0 = mul(T, ry(m.a[0] * D));
	const M1 = mul(M0, rx(m.a[1] * D));
	const M2 = mul(M1, ry(m.a[2] * D));
	const Mr = mul(mul(M2, ry(Math.PI / 2)), rz(m.spin * D));

	ring(M0, 1.0, 0.11, 0.05, colors[0]!);
	ring(M1, 0.84, 0.09, 0.045, colors[1]!);
	ring(M2, 0.68, 0.08, 0.04, colors[2]!);

	// Rotor: a disc with eight engraved sectors that blur as it spins up.
	const Rr = 0.4;
	const hub = 0.11;
	const tr = 0.075;
	const SG = detail ? 32 : 24;
	const blur = Math.min(0.85, Math.abs(m.v[4]) / 1700);
	for (let i = 0; i < SG; i++) {
		const t0 = (i / SG) * 2 * Math.PI;
		const t1 = ((i + 1) / SG) * 2 * Math.PI;
		const tm = (t0 + t1) / 2;
		const [c0, s0, c1, s1] = [Math.cos(t0), Math.sin(t0), Math.cos(t1), Math.sin(t1)];
		const tone = Math.floor(i / (SG / 8)) % 2 ? 1 - 0.2 * (1 - blur) : 1;
		for (const z of [tr, -tr]) {
			const face = (r0: number, r1: number, tn: number) => {
				const v: Array<[number, number, number]> = [[r0 * c0, r0 * s0, z], [r1 * c0, r1 * s0, z], [r1 * c1, r1 * s1, z], [r0 * c1, r0 * s1, z]];
				quad(Mr, z > 0 ? v : v.reverse(), [0, 0, Math.sign(z)], colors[3]!, tn);
			};
			face(hub, Rr, tone);
			face(0.001, hub, 1.12);
		}
		quad(Mr, [[Rr * c0, Rr * s0, -tr], [Rr * c1, Rr * s1, -tr], [Rr * c1, Rr * s1, tr], [Rr * c0, Rr * s0, tr]], [Math.cos(tm), Math.sin(tm), 0], colors[3]!, 0.9);
	}
	const pinW = Math.max(1, px * 0.03);
	const pinC = `rgb(${mix(pal.metal, pal.hi, 0.55).map(Math.round).join(",")})`;
	const axleC = `rgb(${mix(pal.metal, [40, 44, 52], 0.25).map(Math.round).join(",")})`;
	line(Mr, [0, 0, -0.6], [0, 0, -tr], Math.max(1, px * 0.022), axleC);
	line(Mr, [0, 0, tr], [0, 0, 0.6], Math.max(1, px * 0.022), axleC);
	for (const sgn of [1, -1]) {
		line(M0, [0, sgn * 1.0, 0], [0, sgn * 1.1, 0], pinW, pinC);
		line(M1, [sgn * 0.84, 0, 0], [sgn * 0.89, 0, 0], pinW, pinC);
		line(M2, [0, sgn * 0.68, 0], [0, sgn * 0.75, 0], pinW, pinC);
	}
	if (detail) {
		// Engraved ticks on the outer ring's front face.
		const facing = ap(M0, 0, 0, 1)[2];
		if (facing > 0.05) {
			const tick = `rgba(0,0,0,${0.35 * Math.min(1, facing * 3)})`;
			for (let i = 0; i < 36; i++) {
				const th = i * 10 * D;
				const r1 = i % 9 === 0 ? 0.915 : 0.94;
				line(M0, [r1 * Math.cos(th), r1 * Math.sin(th), 0.052], [0.975 * Math.cos(th), 0.975 * Math.sin(th), 0.052], Math.max(1, px * 0.008), tick);
			}
		}
	}
	items.sort((p, q) => p.z - q.z);
	return items;
}

export function drawGyro(ctx: CanvasRenderingContext2D, px: number, m: GyroMotion, colors: PartColor[], pal: GyroPalette, detail: boolean): void {
	ctx.clearRect(0, 0, px, px);
	if (detail) {
		// Soft contact shadow under the mark.
		const cx = px / 2;
		const sy = px * 0.47 + px * 0.34 * 1.38;
		const r = px * 0.34 * 0.75;
		const g = ctx.createRadialGradient(cx, sy, 0, cx, sy, r);
		g.addColorStop(0, "rgba(0,0,0,0.32)");
		g.addColorStop(1, "rgba(0,0,0,0)");
		ctx.save();
		ctx.fillStyle = g;
		ctx.translate(cx, sy);
		ctx.scale(1, 0.16);
		ctx.beginPath();
		ctx.arc(0, 0, r, 0, 2 * Math.PI);
		ctx.fill();
		ctx.restore();
	}
	const seam = Math.max(0.6, px / 170);
	ctx.lineJoin = "round";
	ctx.lineCap = "round";
	for (const it of buildItems(m, colors, pal, px, detail)) {
		if ("pts" in it) {
			ctx.fillStyle = it.fill;
			ctx.strokeStyle = it.fill;
			ctx.lineWidth = seam;
			ctx.beginPath();
			ctx.moveTo(it.pts[0]![0], it.pts[0]![1]);
			for (let k = 1; k < it.pts.length; k++) ctx.lineTo(it.pts[k]![0], it.pts[k]![1]);
			ctx.closePath();
			ctx.fill();
			ctx.stroke();
		} else {
			ctx.strokeStyle = it.color;
			ctx.lineWidth = it.width;
			ctx.beginPath();
			ctx.moveTo(it.a[0], it.a[1]);
			ctx.lineTo(it.b[0], it.b[1]);
			ctx.stroke();
		}
	}
}
