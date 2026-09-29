import React from 'react';
import { motion, useReducedMotion } from 'framer-motion';

/**
 * Scroll-reveal wrapper.
 *
 * Uses Framer Motion's `whileInView`, which is an IntersectionObserver under the
 * hood with a `once` guard, so an element reveals one time and does not flicker
 * every time it re-enters the viewport on the way back up.
 *
 * `amount` is how much of the element must be visible before it fires. The
 * default of 'some' fires when the first pixel appears, which on a tall block
 * reads as "it was already there before I looked at it"; 0.2 waits until it is
 * properly in view.
 */

export const Reveal: React.FC<{
	children: React.ReactNode;
	/** Stagger position, in units of `step` seconds. */
	index?: number;
	step?: number;
	amount?: number;
	y?: number;
	duration?: number;
	as?: 'div' | 'section' | 'article' | 'li' | 'p' | 'h2' | 'h3' | 'span';
	className?: string;
}> = ({
	children,
	index = 0,
	step = 0.1,
	amount = 0.2,
	y = 30,
	duration = 0.55,
	as = 'div',
	className = '',
}) => {
	const reduce = useReducedMotion();
	const Tag = motion[as] as typeof motion.div;

	if (reduce) {
		// No offset, no delay: content is simply there.
		return <Tag className={className}>{children}</Tag>;
	}

	return (
		<Tag
			className={className}
			initial={{ opacity: 0, y }}
			whileInView={{ opacity: 1, y: 0 }}
			viewport={{ once: true, amount }}
			transition={{ duration, delay: index * step, ease: [0.22, 1, 0.36, 1] }}
		>
			{children}
		</Tag>
	);
};

/**
 * Counts a number up when it scrolls into view.
 *
 * Driven by rAF, so it is skipped entirely under reduced motion and left
 * showing its final value. A counter that animates is decoration; a counter
 * that is correct is information.
 */
export const CountUp: React.FC<{
	to: number;
	durationMs?: number;
	suffix?: string;
	className?: string;
}> = ({ to, durationMs = 1100, suffix = '', className = '' }) => {
	const reduce = useReducedMotion();
	const ref = React.useRef<HTMLSpanElement | null>(null);
	const [value, setValue] = React.useState(reduce ? to : 0);
	const done = React.useRef(false);

	React.useEffect(() => {
		if (reduce || done.current) return undefined;
		const node = ref.current;
		if (!node) return undefined;

		const observer = new IntersectionObserver(
			(entries) => {
				if (!entries.some((entry) => entry.isIntersecting) || done.current) return;
				done.current = true;
				observer.disconnect();

				const started = performance.now();
				const step = (now: number) => {
					const t = Math.min(1, (now - started) / durationMs);
					// easeOutCubic, so it decelerates into place.
					const eased = 1 - (1 - t) ** 3;
					setValue(Math.round(to * eased));
					if (t < 1) requestAnimationFrame(step);
				};
				requestAnimationFrame(step);
			},
			{ threshold: 0.4 },
		);

		observer.observe(node);
		return () => observer.disconnect();
	}, [reduce, to, durationMs]);

	return (
		<span ref={ref} className={className}>
			{value}
			{suffix}
		</span>
	);
};

export default Reveal;
