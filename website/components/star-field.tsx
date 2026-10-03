'use client';
import { useEffect, useRef, useState } from 'react';
export function StarField({ en = false }: { en?: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const reduce = matchMedia('(prefers-reduced-motion: reduce)');
    let visible = true,
      frame = 0,
      last = 0,
      t = 0,
      width = 0,
      height = 0;
    let seed = 873;
    const random = () => {
      seed = (seed * 16807) % 2147483647;
      return (seed - 1) / 2147483646;
    };
    const stars = Array.from({ length: 420 }, () => ({
      x: random(),
      y: random(),
      r: random() > 0.98 ? 1.2 : random() * 0.65 + 0.15,
      a: random() * 0.55 + 0.15,
    }));
    const dust = Array.from({ length: 2500 }, () => ({
      angle: random() * Math.PI * 2,
      band: Math.floor(random() * 3),
      spread: random() - 0.5,
      depth: random(),
      size: random(),
      color: random(),
    }));
    function paint() {
      if (!ctx) return;
      ctx.clearRect(0, 0, width, height);
      for (const s of stars) {
        ctx.fillStyle = `rgba(193,212,237,${s.a})`;
        ctx.beginPath();
        ctx.arc(s.x * width, s.y * height, s.r, 0, Math.PI * 2);
        ctx.fill();
      }
      const cx = width * 0.5,
        cy = height * 0.47,
        scale = Math.min(width * 0.43, 370);
      const glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, scale * 1.6);
      glow.addColorStop(0, 'rgba(63,98,135,.065)');
      glow.addColorStop(0.5, 'rgba(54,78,123,.028)');
      glow.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = glow;
      ctx.fillRect(0, 0, width, height);
      for (const d of dust) {
        const a = d.angle + t * 0.027;
        const r =
          scale *
          (0.65 +
            d.band * 0.19 +
            d.spread * 0.13 +
            Math.sin(a * 3 + t * 0.12) * 0.02);
        const x = Math.cos(a) * r;
        const z = Math.sin(a) * r;
        const y =
          z * 0.48 + Math.sin(a * 2 + d.band * 0.4 + t * 0.08) * scale * 0.047;
        const tilt = -0.35;
        const px = cx + x * Math.cos(tilt) - y * Math.sin(tilt),
          py = cy + x * Math.sin(tilt) + y * Math.cos(tilt);
        const alpha = (0.2 + d.depth * 0.68) * (z > 0 ? 1 : 0.43);
        ctx.fillStyle =
          d.color > 0.96
            ? `rgba(241,211,175,${alpha})`
            : `rgba(188,215,242,${alpha})`;
        ctx.beginPath();
        ctx.arc(
          px,
          py,
          d.size > 0.975 ? 1.6 : 0.24 + d.size * 0.62,
          0,
          Math.PI * 2,
        );
        ctx.fill();
        if (d.size > 0.988) {
          const g = ctx.createRadialGradient(px, py, 0, px, py, 9);
          g.addColorStop(0, `rgba(217,234,255,${alpha * 0.55})`);
          g.addColorStop(1, 'rgba(180,211,255,0)');
          ctx.fillStyle = g;
          ctx.fillRect(px - 9, py - 9, 18, 18);
        }
      }
    }
    function loop(now: number) {
      if (now - last > 32) {
        t += Math.min((now - last) / 1000, 0.05);
        last = now;
        paint();
      }
      frame = requestAnimationFrame(loop);
    }
    function sync() {
      cancelAnimationFrame(frame);
      frame = 0;
      paint();
      if (visible && !document.hidden && !paused && !reduce.matches) {
        last = performance.now();
        frame = requestAnimationFrame(loop);
      }
    }
    function resize() {
      const box = canvas!.getBoundingClientRect();
      width = box.width;
      height = box.height;
      const dpr = Math.min(devicePixelRatio, 1.5);
      canvas!.width = width * dpr;
      canvas!.height = height * dpr;
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
      paint();
    }
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    const io = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      sync();
    });
    io.observe(canvas);
    document.addEventListener('visibilitychange', sync);
    reduce.addEventListener('change', sync);
    resize();
    sync();
    return () => {
      cancelAnimationFrame(frame);
      ro.disconnect();
      io.disconnect();
      document.removeEventListener('visibilitychange', sync);
      reduce.removeEventListener('change', sync);
    };
  }, [paused]);
  return (
    <>
      <canvas ref={ref} className="star-canvas" aria-hidden="true" />
      <button
        className="motion-toggle"
        onClick={() => setPaused(!paused)}
        aria-pressed={paused}
        aria-label={
          en
            ? paused
              ? 'Resume star animation'
              : 'Pause star animation'
            : paused
              ? '继续星场动画'
              : '暂停星场动画'
        }
      >
        <span aria-hidden="true">{paused ? '▷' : 'Ⅱ'}</span>
      </button>
    </>
  );
}
