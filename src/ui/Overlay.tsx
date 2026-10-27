import { gsap } from "gsap";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { platform } from "../platform";
import { reducedMotion } from "./motion";

/**
 * The recording overlay: a click-through window over what is recorded. Its yellow frame is drawn
 * only when the bar confirms Windows leaves this window out of the recording (`overlay:frame`).
 * The frame traces itself around the area during the countdown, flashes when recording starts,
 * then breathes softly; it turns grey with a "Paused" tag while paused.
 */
export default function Overlay() {
  const [n, setN] = useState<number | null>(null);
  const [paused, setPaused] = useState(false);
  const [frame, setFrame] = useState(false);
  const num = useRef<HTMLSpanElement | null>(null);
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
    const tl = gsap.timeline({ defaults: { duration: 0.22, ease: "power2.inOut" } });
    tl.fromTo(top!, { scaleX: 0 }, { scaleX: 1, transformOrigin: "left center" })
      .fromTo(right!, { scaleY: 0 }, { scaleY: 1, transformOrigin: "center top" })
      .fromTo(bottom!, { scaleX: 0 }, { scaleX: 1, transformOrigin: "right center" })
      .fromTo(left!, { scaleY: 0 }, { scaleY: 1, transformOrigin: "center bottom" });
    return () => void tl.kill();
  }, [frame]);

  // Recording starts: the frame flashes thick and bright, then breathes while recording.
  useLayoutEffect(() => {
    const el = box.current;
    if (!frame || !live || !el || reducedMotion()) return;
    const edges = el.querySelectorAll<HTMLElement>(".ov-edge");
    const tl = gsap.timeline();
    tl.fromTo(el, { "--w": "10px" }, { "--w": "4px", duration: 0.6, ease: "power3.out" }).fromTo(edges, { autoAlpha: 0.4 }, { autoAlpha: 1, duration: 0.18, repeat: 3, yoyo: true, ease: "none" }, 0);
    tl.call(() => {
      breathe.current = gsap.to(edges, { autoAlpha: 0.55, duration: 1.4, ease: "sine.inOut", repeat: -1, yoyo: true });
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

  useLayoutEffect(() => {
    if (!n || !num.current || reducedMotion()) return;
    gsap.fromTo(num.current, { scale: 1.35, autoAlpha: 0 }, { scale: 1, autoAlpha: 1, duration: 0.45, ease: "back.out(2)" });
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
        <div className="cd-card" aria-live="assertive">
          <span ref={num} key={n}>
            {n}
          </span>
          <em>Recording starts</em>
        </div>
      )}
      {frame && paused && <span className="ov-tag">Paused</span>}
    </div>
  );
}
