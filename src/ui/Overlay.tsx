import { gsap } from "gsap";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { platform } from "../platform";
import { reducedMotion } from "./motion";

/** Countdown ring: radius and length of its stroke (SVG units). */
const RING_R = 92;
const RING_LEN = 2 * Math.PI * RING_R;

/**
 * The recording overlay: a click-through window over what is recorded. Its thin yellow frame is
 * drawn only when the bar confirms Windows leaves this window out of the recording (`overlay:frame`).
 * The frame traces itself around the area during the countdown, glows once when recording
 * starts, then breathes softly; it turns grey with a "Paused" tag while paused. The countdown has
 * no card: the number floats over the screen with a ring that runs out each second; the old
 * number lifts away as the next one settles in.
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
  const box = useRef<HTMLDivElement | null>(null);
  const breathe = useRef<gsap.core.Tween | null>(null);
  const live = n === 0;

  useEffect(() => {
    const offs: Array<() => void> = [];
    void Promise.all([platform.overlay.onTick(setN), platform.overlay.onPaused(setPaused), platform.overlay.onFrame(setFrame)])
      .then((u) => offs.push(...u))
      .then(() => platform.overlay.sendReady());
    return () => offs.forEach((off) => off());
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

  // Each second: the old number lifts and blurs away, the new one settles in, the ring runs out.
  useLayoutEffect(() => {
    const was = prev.current;
    prev.current = n;
    if (!n || reducedMotion()) return;
    const tl = gsap.timeline();
    if (was === null && cd.current) tl.fromTo(cd.current, { autoAlpha: 0, scale: 0.9 }, { autoAlpha: 1, scale: 1, duration: 0.35, ease: "power3.out" }, 0);
    if (num.current) tl.fromTo(num.current, { scale: 0.55, autoAlpha: 0, filter: "blur(10px)" }, { scale: 1, autoAlpha: 1, filter: "blur(0px)", duration: 0.5, ease: "back.out(1.8)" }, 0);
    if (ghost.current && was) {
      ghost.current.textContent = String(was);
      tl.fromTo(ghost.current, { scale: 1, autoAlpha: 1, filter: "blur(0px)" }, { scale: 1.5, autoAlpha: 0, filter: "blur(8px)", duration: 0.45, ease: "power2.out" }, 0);
    }
    if (ring.current) tl.fromTo(ring.current, { strokeDashoffset: 0 }, { strokeDashoffset: RING_LEN, duration: 1, ease: "none" }, 0);
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
      {!!n && (
        <div className="cd" ref={cd} aria-live="assertive">
          <svg className="cd-ring" viewBox="0 0 200 200" aria-hidden>
            <circle className="cd-track" cx="100" cy="100" r={RING_R} />
            <circle className="cd-run" ref={ring} cx="100" cy="100" r={RING_R} strokeDasharray={RING_LEN} />
          </svg>
          <span className="cd-ghost" ref={ghost} aria-hidden />
          <span className="cd-num" ref={num}>
            {n}
          </span>
          <em>Recording starts</em>
        </div>
      )}
      {frame && paused && <span className="ov-tag">Paused</span>}
    </div>
  );
}
