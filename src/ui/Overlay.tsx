import { gsap } from "gsap";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { listening, platform } from "../platform";
import { reducedMotion } from "./motion";

/** Countdown ring: radius and length of its stroke (SVG units). */
const RING_R = 92;
const RING_LEN = 2 * Math.PI * RING_R;

/**
 * The recording overlay: a click-through window over what is recorded. Its thin yellow frame is
 * drawn only when the bar confirms Windows leaves this window out of the recording (`overlay:frame`).
 * The frame traces itself around the area during the countdown, glows once when recording
 * starts, then breathes softly; it turns grey with a "Paused" tag while paused. The countdown has
 * no card: the number floats over the screen inside one ring that runs out evenly over the whole
 * countdown; each new number slides softly up into place as the old one leaves, and the whole
 * countdown fades away when recording starts. Only opacity and transforms move (no blur, no
 * overshoot), so it stays smooth on any graphics.
 */
export default function Overlay() {
  const [n, setN] = useState<number | null>(null);
  const [paused, setPaused] = useState(false);
  const [frame, setFrame] = useState(false);
  const num = useRef<HTMLSpanElement | null>(null);
  const ghost = useRef<HTMLSpanElement | null>(null);
  const ring = useRef<SVGCircleElement | null>(null);
  const cd = useRef<HTMLDivElement | null>(null);
  const prev = useRef<number | null>(null);
  /** The countdown's length in seconds (its first number). */
  const total = useRef(0);
  const box = useRef<HTMLDivElement | null>(null);
  const breathe = useRef<gsap.core.Tween | null>(null);
  const live = n === 0;

  useEffect(() => {
    const all = Promise.all([platform.overlay.onTick(setN), platform.overlay.onPaused(setPaused), platform.overlay.onFrame(setFrame)]);
    void all.then(() => platform.overlay.sendReady());
    return listening(all.then((u) => () => u.forEach((off) => off())));
  }, []);

  // The frame draws itself: top, right, bottom, left, one after another.
  useLayoutEffect(() => {
    const el = box.current;
    if (!frame || !el || reducedMotion()) return;
    const [top, right, bottom, left] = Array.from(el.querySelectorAll<HTMLElement>(".ov-edge"));
    const tl = gsap.timeline({ defaults: { duration: 0.24, ease: "power2.inOut" } });
    tl.fromTo(top!, { scaleX: 0 }, { scaleX: 1, transformOrigin: "left center" })
      .fromTo(right!, { scaleY: 0 }, { scaleY: 1, transformOrigin: "center top" })
      .fromTo(bottom!, { scaleX: 0 }, { scaleX: 1, transformOrigin: "right center" })
      .fromTo(left!, { scaleY: 0 }, { scaleY: 1, transformOrigin: "center bottom" });
    return () => void tl.kill();
  }, [frame]);

  // Recording starts: the frame glows a little wider for a moment, then breathes while recording.
  useLayoutEffect(() => {
    const el = box.current;
    if (!frame || !live || !el || reducedMotion()) return;
    const edges = el.querySelectorAll<HTMLElement>(".ov-edge");
    const tl = gsap.timeline();
    tl.fromTo(el, { "--w": "4px" }, { "--w": "2px", duration: 0.7, ease: "power3.out" }).fromTo(edges, { autoAlpha: 0.4 }, { autoAlpha: 1, duration: 0.2, repeat: 2, yoyo: true, ease: "none" }, 0);
    tl.call(() => {
      breathe.current = gsap.to(edges, { autoAlpha: 0.55, duration: 1.6, ease: "sine.inOut", repeat: -1, yoyo: true });
    });
    return () => {
      tl.kill();
      breathe.current?.kill();
      gsap.set(edges, { autoAlpha: 1 });
    };
  }, [frame, live]);

  // Paused: the breathing stops on a steady grey frame.
  useEffect(() => {
    const edges = box.current?.querySelectorAll<HTMLElement>(".ov-edge");
    if (paused) {
      breathe.current?.pause();
      if (edges?.length) gsap.to(edges, { autoAlpha: 1, duration: reducedMotion() ? 0 : 0.2 });
    } else breathe.current?.resume();
  }, [paused]);

  // Each second: the old number slides up and fades, the new one slides up into place; the ring
  // goes on running out from where it is (one even sweep over the whole countdown). At 0 the
  // countdown fades away instead of vanishing.
  useLayoutEffect(() => {
    const was = prev.current;
    prev.current = n;
    if (n === null) return;
    if (n > 0 && !(was && was > 0)) total.current = n;
    const still = reducedMotion();
    const share = (k: number) => (total.current ? Math.min(1, Math.max(0, (total.current - k) / total.current)) : 0);
    if (n === 0) {
      if (!cd.current) return;
      // Opened while already recording: nothing to fade.
      if (still || !(was && was > 0)) return void gsap.set(cd.current, { autoAlpha: 0 });
      const out = gsap.to(cd.current, { autoAlpha: 0, scale: 0.96, duration: 0.3, ease: "power2.out" });
      return () => void out.kill();
    }
    if (still) {
      if (cd.current) gsap.set(cd.current, { autoAlpha: 1, scale: 1 });
      if (ring.current) gsap.set(ring.current, { strokeDashoffset: RING_LEN * share(n) });
      return;
    }
    const tl = gsap.timeline();
    if (cd.current && !(was && was > 0)) tl.fromTo(cd.current, { autoAlpha: 0, scale: 0.96 }, { autoAlpha: 1, scale: 1, duration: 0.4, ease: "power2.out" }, 0);
    if (num.current) tl.fromTo(num.current, { yPercent: 28, autoAlpha: 0 }, { yPercent: 0, autoAlpha: 1, duration: 0.42, ease: "power3.out" }, 0);
    if (ghost.current && was && was > 0) {
      ghost.current.textContent = String(was);
      tl.fromTo(ghost.current, { yPercent: 0, autoAlpha: 1 }, { yPercent: -28, autoAlpha: 0, duration: 0.32, ease: "power2.in" }, 0);
    }
    // From where the ring is now to the end of this second, at an even pace.
    if (ring.current) tl.fromTo(ring.current, { strokeDashoffset: RING_LEN * share(n) }, { strokeDashoffset: RING_LEN * share(n - 1), duration: 1, ease: "none" }, 0);
    return () => void tl.kill();
  }, [n]);

  return (
    <div className={["ov", paused ? "paused" : "", live ? "live" : ""].join(" ").trim()} ref={box}>
      {frame && (
        <>
          <i className="ov-edge top" aria-hidden />
          <i className="ov-edge right" aria-hidden />
          <i className="ov-edge bottom" aria-hidden />
          <i className="ov-edge left" aria-hidden />
        </>
      )}
      {n !== null && (
        <div className="cd" ref={cd} aria-live="assertive" aria-hidden={n === 0}>
          <div className="cd-dial">
            <svg className="cd-ring" viewBox="0 0 200 200" aria-hidden>
              <circle className="cd-track" cx="100" cy="100" r={RING_R} />
              <circle className="cd-run" ref={ring} cx="100" cy="100" r={RING_R} strokeDasharray={RING_LEN} />
            </svg>
            <span className="cd-digits">
              <span className="cd-ghost" ref={ghost} aria-hidden />
              <span className="cd-num" ref={num}>
                {n || ""}
              </span>
            </span>
          </div>
          <em>Recording starts</em>
        </div>
      )}
      {frame && paused && <span className="ov-tag">Paused</span>}
    </div>
  );
}
