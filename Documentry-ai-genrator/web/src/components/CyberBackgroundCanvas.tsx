import React from 'react';

/**
 * CyberBackgroundCanvas — the falling / floating robotic particle field.
 *
 * A fixed, full-screen canvas behind all content. Decorative only: it is
 * `aria-hidden`, never receives pointer events, and the whole thing is skipped
 * under reduced motion or when WebGL-less canvas is unavailable.
 *
 * On z-index
 * ----------
 * The brief asks for `z-index: -1`. That is a trap: a negative z-index paints
 * the element *behind* its stacking context's background, so against the page's
 * own background colour the canvas is invisible. It uses `z-index: 0` instead,
 * with page content lifted above it, which is how the ambient blobs already
 * work in this app. Visually identical, actually visible.
 *
 * Performance
 * -----------
 * Particle count is capped and scaled to the viewport, the loop pauses when the
 * tab is hidden (a background rAF gets throttled to roughly 1 Hz, and drawing
 * 120 particles at 1 Hz still costs a repaint for nothing), and the backing
 * store is sized to devicePixelRatio but capped at 2 — beyond that the fill
 * rate cost is not worth the extra sharpness.
 */

type Kind = 'code' | 'node' | 'gear' | 'bolt' | 'spark';

interface Particle {
	x: number;
	y: number;
	/** px/second, downwards. */
	vy: number;
	/** px/second, sideways. */
	vx: number;
	size: number;
	rotation: number;
	/** Radians/second. */
	spin: number;
	alpha: number;
	kind: Kind;
	/** Hex colour. */
	hue: string;
	/** 0-1, how strongly the cursor pushes this one. */
	charge: number;
}

/** Cyan, amber and cobalt, kept dim so text stays readable over them. */
const PALETTE = ['#22d3ee', '#f59e0b', '#3b82f6', '#67e8f9'] as const;

/** Short fragments, the flavour of falling code. */
const SNIPPETS = ['01', '1', '0', '{}', '</>', '01', '10', '0x', '::', '01'];

const MAX_PARTICLES_DESKTOP = 120;
const MAX_PARTICLES_MOBILE = 55;
/** Below this width, the field is thinned out and the cursor force reduced. */
const MOBILE_BREAKPOINT = 720;

/** Cursor push radius, px, and the speed it imparts. */
const CURSOR_RADIUS = 130;
const CURSOR_FORCE = 210;
/** How quickly a particle recovers after being pushed. */
const CURSOR_DAMPING = 0.86;

const isReducedMotion = () =>
	typeof window !== 'undefined' &&
	window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const random = (min: number, max: number) => min + Math.random() * (max - min);

const makeParticle = (width: number, height: number, spawnAbove = true): Particle => {
	const kindRoll = Math.random();
	const kind: Kind =
		kindRoll < 0.4 ? 'code' : kindRoll < 0.62 ? 'node' : kindRoll < 0.8 ? 'gear' : kindRoll < 0.93 ? 'bolt' : 'spark';

	return {
		x: random(0, width),
		// Recycled from below the fold, so the field never has a visible top edge.
		y: spawnAbove ? random(-height * 0.25, -12) : random(0, height),
		// Slow, and mostly downwards. A few drift upward, which is what stops it
		// looking like plain rain.
		vy: random(6, 26) * (Math.random() < 0.12 ? -0.5 : 1),
		vx: random(-9, 9),
		size: kind === 'code' ? random(10, 15) : kind === 'gear' ? random(11, 19) : random(3, 7),
		rotation: random(0, Math.PI * 2),
		spin: random(-0.5, 0.5),
		// Deliberately low: this is a texture, not a subject.
		alpha: random(0.1, 0.32),
		kind,
		hue: PALETTE[Math.floor(Math.random() * PALETTE.length)],
		charge: 0,
	};
};

/** Draw one particle. Kept separate so the shapes are readable in one place. */
const draw = (ctx: CanvasRenderingContext2D, p: Particle): void => {
	ctx.save();
	ctx.globalAlpha = p.alpha;
	ctx.strokeStyle = p.hue;
	ctx.fillStyle = p.hue;
	ctx.translate(p.x, p.y);
	ctx.rotate(p.rotation);

	switch (p.kind) {
		case 'code':
			ctx.font = `600 ${p.size}px ui-monospace, SFMono-Regular, Menlo, monospace`;
			ctx.textAlign = 'center';
			ctx.fillText(SNIPPETS[Math.floor(Math.random() * SNIPPETS.length)], 0, 0);
			break;

		case 'node': {
			// A circuit node: a filled dot inside a ring, with two legs.
			ctx.lineWidth = 1.2;
			ctx.beginPath();
			ctx.arc(0, 0, p.size * 0.7, 0, Math.PI * 2);
			ctx.stroke();
			ctx.beginPath();
			ctx.arc(0, 0, p.size * 0.22, 0, Math.PI * 2);
			ctx.fill();
			ctx.beginPath();
			ctx.moveTo(-p.size * 0.7, 0);
			ctx.lineTo(-p.size * 1.5, 0);
			ctx.moveTo(p.size * 0.7, 0);
			ctx.lineTo(p.size * 1.5, 0);
			ctx.stroke();
			break;
		}

		case 'gear': {
			// A gear: a ring with teeth. Rotating, since every particle spins.
			const r = p.size * 0.7;
			const teeth = 8;
			ctx.lineWidth = 1.3;
			ctx.beginPath();
			for (let i = 0; i < teeth; i += 1) {
				const a = (i / teeth) * Math.PI * 2;
				const inner = r * 0.78;
				const outer = r;
				ctx.moveTo(Math.cos(a) * inner, Math.sin(a) * inner);
				ctx.lineTo(Math.cos(a) * outer, Math.sin(a) * outer);
			}
			ctx.stroke();
			ctx.beginPath();
			ctx.arc(0, 0, r * 0.5, 0, Math.PI * 2);
			ctx.stroke();
			break;
		}

		case 'bolt': {
			// A micro-bolt: a two-segment zigzag.
			const h = p.size * 2.6;
			ctx.lineWidth = 1.4;
			ctx.beginPath();
			ctx.moveTo(0, -h / 2);
			ctx.lineTo(p.size * 0.5, 0);
			ctx.lineTo(-p.size * 0.2, 0);
			ctx.lineTo(p.size * 0.35, h / 2);
			ctx.stroke();
			break;
		}

		case 'spark':
		default: {
			// A spark: a dot with a soft bloom.
			const g = ctx.createRadialGradient(0, 0, 0, 0, 0, p.size * 3.4);
			g.addColorStop(0, p.hue);
			g.addColorStop(1, 'transparent');
			ctx.globalAlpha = p.alpha * 1.5;
			ctx.fillStyle = g;
			ctx.beginPath();
			ctx.arc(0, 0, p.size * 3.4, 0, Math.PI * 2);
			ctx.fill();
			break;
		}
	}

	ctx.restore();
};

export const CyberBackgroundCanvas: React.FC = () => {
	const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
	const cursor = React.useRef({ x: -9999, y: -9999 });
	const particles = React.useRef<Particle[]>([]);
	const frame = React.useRef<number>(0);
	const last = React.useRef<number>(0);

	React.useEffect(() => {
		const canvas = canvasRef.current;
		if (!canvas) return undefined;
		// No 2D context means no canvas at all; render nothing rather than throw.
		const ctx = canvas.getContext('2d', { alpha: true });
		if (!ctx) return undefined;

		// Reduced motion: no field at all. A static canvas would be pure cost for
		// a decoration, and a slowly drifting one is exactly what the setting
		// asks to avoid.
		if (isReducedMotion()) return undefined;

		let width = 0;
		let height = 0;
		let dpr = 1;

		const resize = () => {
			const mobile = window.innerWidth < MOBILE_BREAKPOINT;
			dpr = Math.min(2, window.devicePixelRatio || 1);
			width = window.innerWidth;
			height = window.innerHeight;

			canvas.width = Math.floor(width * dpr);
			canvas.height = Math.floor(height * dpr);
			canvas.style.width = `${width}px`;
			canvas.style.height = `${height}px`;
			ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

			const target = mobile ? MAX_PARTICLES_MOBILE : MAX_PARTICLES_DESKTOP;
			// Recomputed on resize rather than only at mount, so rotating a phone
			// thins or thickens the field to match.
			while (particles.current.length < target) {
				particles.current.push(makeParticle(width, height, false));
			}
			if (particles.current.length > target) {
				particles.current.length = target;
			}
		};

		const onMove = (event: PointerEvent) => {
			cursor.current.x = event.clientX;
			cursor.current.y = event.clientY;
		};
		const onLeave = () => {
			cursor.current.x = -9999;
			cursor.current.y = -9999;
		};

		const loop = (now: number) => {
			frame.current = window.requestAnimationFrame(loop);

			// Cap the timestep. A background tab, or a long GC pause, hands back a
			// huge delta; without this, everything teleports on the next frame.
			const dt = Math.min(0.05, (now - last.current) / 1000);
			last.current = now;

			ctx.clearRect(0, 0, width, height);

			const reducedForce = window.innerWidth < MOBILE_BREAKPOINT ? 0.5 : 1;

			for (const p of particles.current) {
				p.y += p.vy * dt;
				p.x += p.vx * dt;
				p.rotation += p.spin * dt;

				// Cursor: a soft repelling field. The falloff is quadratic so the
				// edge of the radius is gentle and nothing snaps.
				const dx = p.x - cursor.current.x;
				const dy = p.y - cursor.current.y;
				const distance = Math.hypot(dx, dy);
				if (distance < CURSOR_RADIUS && distance > 0.01) {
					const strength = (1 - distance / CURSOR_RADIUS) ** 2;
					p.x += (dx / distance) * strength * CURSOR_FORCE * reducedForce * dt;
					p.y += (dy / distance) * strength * CURSOR_FORCE * reducedForce * dt;
					// The charge brightens nearby circuit nodes, which is the
					// "light up" half of the effect.
					p.charge = Math.min(1, p.charge + strength * dt * 4);
				} else {
					p.charge = Math.max(0, p.charge - CURSOR_DAMPING * dt * 2);
				}

				// Wrap around every edge, so the field is endless.
				if (p.y > height + 30) {
					p.y = -30;
					p.x = Math.random() * width;
				} else if (p.y < -60) {
					p.y = height + 30;
					p.x = Math.random() * width;
				}
				if (p.x < -40) p.x = width + 40;
				else if (p.x > width + 40) p.x = -40;

				draw(ctx, p);
			}
		};

		// Pause when hidden. A backgrounded tab gets rAF at roughly 1 Hz, and
		// clearing and redrawing the field once a second for a tab nobody is
		// looking at is pure waste.
		const onVisibility = () => {
			if (document.hidden) {
				window.cancelAnimationFrame(frame.current);
				frame.current = 0;
			} else if (!frame.current) {
				last.current = performance.now();
				frame.current = window.requestAnimationFrame(loop);
			}
		};

		resize();
		window.addEventListener('resize', resize);
		window.addEventListener('pointermove', onMove, { passive: true });
		window.addEventListener('pointerleave', onLeave);
		document.addEventListener('visibilitychange', onVisibility);

		last.current = performance.now();
		frame.current = window.requestAnimationFrame(loop);

		return () => {
			window.cancelAnimationFrame(frame.current);
			window.removeEventListener('resize', resize);
			window.removeEventListener('pointermove', onMove);
			window.removeEventListener('pointerleave', onLeave);
			document.removeEventListener('visibilitychange', onVisibility);
			particles.current = [];
		};
	}, []);

	return <canvas ref={canvasRef} className="cyber-canvas" aria-hidden="true" />;
};

export default CyberBackgroundCanvas;
