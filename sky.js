"use strict";

// Animated sky behind the current conditions. Takes a MET symbol code
// (e.g. "lightrainshowers_day"), the wind speed and the time of day, and draws
// the sky colour, sun/moon glow, stars, drifting clouds, rain, sleet, snow, fog,
// lightning and wind streaks on a canvas.
// Preview any weather with ?sky=<symbol_code>&wind=<m/s>, e.g. ?sky=heavysnow_night&wind=14
const Sky = (() => {
  const canvas = document.getElementById("sky");
  const ctx = canvas.getContext("2d");
  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");
  const params = new URLSearchParams(location.search);

  let w = 0, h = 0, dpr = 1;
  let state = null;
  let scene = null;
  let raf = 0, last = 0, time = 0;

  const rand = (a, b) => a + Math.random() * (b - a);
  const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
  const rgba = (c, a = 1) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;

  // [top, bottom] gradient colours for each time of day and kind of sky.
  const SKIES = {
    day: {
      clear: [[63, 156, 255], [34, 100, 207]],
      overcast: [[118, 134, 156], [82, 97, 118]],
      storm: [[56, 63, 80], [33, 38, 52]],
      fog: [[128, 139, 152], [98, 108, 120]],
    },
    night: {
      clear: [[8, 18, 46], [26, 44, 90]],
      overcast: [[30, 36, 48], [44, 52, 66]],
      storm: [[15, 17, 25], [29, 31, 41]],
      fog: [[44, 50, 58], [60, 66, 74]],
    },
    polartwilight: {
      clear: [[50, 62, 128], [190, 118, 108]],
      overcast: [[68, 72, 92], [108, 102, 112]],
      storm: [[40, 42, 56], [60, 58, 70]],
      fog: [[90, 94, 108], [112, 110, 120]],
    },
  };

  // Turns a symbol code into numbers the drawing code can use.
  function describe({ symbol, wind, period }) {
    const [base, suffix] = symbol.split("_");
    const precip = base.includes("snow") ? "snow" : base.includes("sleet") ? "sleet" : base.includes("rain") ? "rain" : null;
    const showers = base.includes("showers");
    const fog = base === "fog";
    const clouds = fog || base === "clearsky" ? 0
      : base === "fair" ? 0.25
      : base === "partlycloudy" ? 0.55
      : showers ? 0.75
      : 1;
    const intensity = !precip ? 0 : base.startsWith("light") ? 1 : base.startsWith("heavy") ? 3 : 2;
    const thunder = base.includes("thunder");
    const storm = thunder ? 0.9 : precip ? 0.25 + intensity * 0.15 : 0;
    const p = suffix || period || "day";
    return { period: SKIES[p] ? p : "day", precip, showers, fog, clouds, intensity, thunder, storm, wind: wind || 0 };
  }

  // A soft cloud drawn once to an offscreen canvas, then moved around each frame.
  function cloudSprite(color, scale) {
    const cw = 240 * scale, ch = 120 * scale;
    const c = document.createElement("canvas");
    c.width = Math.ceil(cw * dpr);
    c.height = Math.ceil(ch * dpr);
    const g = c.getContext("2d");
    g.scale(dpr, dpr);
    const puffs = [[0.28, 0.64, 0.2], [0.46, 0.46, 0.25], [0.66, 0.56, 0.21], [0.4, 0.72, 0.2], [0.6, 0.74, 0.2], [0.78, 0.7, 0.15]];
    for (const [px, py, pr] of puffs) {
      const x = (px + rand(-0.03, 0.03)) * cw, y = (py + rand(-0.04, 0.04)) * ch, r = pr * cw * rand(0.9, 1.1);
      const grad = g.createRadialGradient(x, y, 0, x, y, r);
      grad.addColorStop(0, rgba(color, 1));
      grad.addColorStop(0.55, rgba(color, 0.85));
      grad.addColorStop(1, rgba(color, 0));
      g.fillStyle = grad;
      g.beginPath();
      g.arc(x, y, r, 0, Math.PI * 2);
      g.fill();
    }
    return { img: c, w: cw, h: ch };
  }

  // [top, bottom] gradient colours for the described weather.
  function skyColors(s) {
    const pal = SKIES[s.period];
    if (s.fog) return pal.fog;
    return [0, 1].map((i) => mix(mix(pal.clear[i], pal.overcast[i], s.clouds), pal.storm[i], s.storm));
  }

  // The iOS home-screen app's status bar strip takes its colour from theme-color, so keep it
  // matching the top of the sky. The root background follows too, so pulling down past the
  // top shows sky; the body keeps the normal page background for everything below.
  // Done on every weather change, even before the canvas has a size.
  function applyPageColors() {
    const hex = "#" + skyColors(state)[0].map((v) => v.toString(16).padStart(2, "0")).join("");
    document.documentElement.style.backgroundColor = hex;
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", hex);
  }

  // Creates all the moving pieces for the current weather and canvas size.
  function build() {
    if (!state || !w || !h) return;
    const s = state;
    const area = (w * h) / (375 * 330);
    const night = s.period === "night";

    const stars = s.period !== "day" && s.clouds < 0.8 && !s.fog && !s.precip
      ? Array.from({ length: Math.round(70 * area) }, () => ({
        x: Math.random() * w, y: Math.random() * h * 0.85,
        r: rand(0.4, 1.3), phase: rand(0, 6.28), speed: rand(0.6, 2),
      }))
      : [];

    let shade = s.storm ? mix([205, 210, 218], [70, 76, 90], s.storm) : s.clouds >= 1 ? [214, 220, 228] : [255, 255, 255];
    if (night) shade = mix(shade, [0, 0, 0], 0.55);
    else if (s.period === "polartwilight") shade = mix(shade, [70, 55, 80], 0.3);

    const cloudCount = s.clouds ? Math.round((2 + s.clouds * 7) * Math.max(1, w / 375)) : 0;
    const clouds = Array.from({ length: cloudCount }, () => {
      const depth = rand(0.5, 1.2);
      const sprite = cloudSprite(shade, 0.45 + depth * 0.45);
      return {
        sprite, depth,
        x: rand(-sprite.w, w), y: rand(-0.25, 0.7) * h,
        alpha: (0.25 + s.clouds * 0.4) * rand(0.75, 1),
        speed: (5 + s.wind * 2.2) * depth,
      };
    }).sort((a, b) => a.depth - b.depth);

    const rainShare = s.precip === "rain" ? 1 : s.precip === "sleet" ? 0.5 : 0;
    const showerFactor = s.showers ? 0.75 : 1;
    const drops = Array.from({ length: Math.round(area * [0, 55, 120, 210][s.intensity] * rainShare * showerFactor) }, () => ({
      x: rand(-0.2, 1) * w, y: rand(0, h), len: rand(10, 20), vy: rand(650, 950),
    }));
    const flakes = Array.from({ length: Math.round(area * [0, 45, 90, 160][s.intensity] * (s.precip ? 1 - rainShare : 0) * showerFactor) }, () => ({
      x: rand(-0.2, 1) * w, y: rand(0, h), r: rand(1, 3.2), vy: rand(25, 70), phase: rand(0, 6.28), amp: rand(8, 22),
    }));

    const fogBands = s.fog ? Array.from({ length: 5 }, () => ({
      x: rand(0, w), y: rand(0.2, 1.05) * h, rx: rand(0.5, 0.9) * w, ry: rand(25, 55),
      vx: rand(4, 10) * (Math.random() < 0.5 ? -1 : 1), a: rand(0.18, 0.32),
    })) : [];

    const streaks = s.wind >= 8 ? Array.from({ length: Math.min(24, Math.round((s.wind - 6) * 1.6 * area)) }, () => ({
      x: rand(-200, w), y: rand(0.05, 0.95) * h, len: rand(60, 150),
      v: rand(280, 380) + s.wind * 20, amp: rand(2, 6), phase: rand(0, 6.28),
    })) : [];

    const [top, bottom] = skyColors(s);
    scene = { top, bottom, stars, clouds, drops, flakes, fogBands, streaks, flash: 0, nextFlash: time + rand(1.5, 4), echo: 0 };
  }

  function draw(dt) {
    const s = state, sc = scene;
    if (!s || !sc) return;
    time += dt;

    const bg = ctx.createLinearGradient(0, 0, 0, h);
    bg.addColorStop(0, rgba(sc.top));
    bg.addColorStop(1, rgba(sc.bottom));
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);

    // Sun or moon glow in the top-right corner, fading as clouds thicken.
    const clear = 1 - Math.max(s.clouds, s.fog ? 0.7 : 0, s.storm);
    if (clear > 0) {
      const glowColor = s.period === "day" ? [255, 236, 170] : s.period === "night" ? [200, 215, 255] : [255, 190, 150];
      const strength = (s.period === "night" ? 0.28 : 0.55) * clear * (1 + 0.06 * Math.sin(time * 0.8));
      const gx = w * 0.85, gy = h * 0.05, gr = Math.max(w, h) * 0.75;
      const glow = ctx.createRadialGradient(gx, gy, 0, gx, gy, gr);
      glow.addColorStop(0, rgba(glowColor, strength));
      glow.addColorStop(1, rgba(glowColor, 0));
      ctx.fillStyle = glow;
      ctx.fillRect(0, 0, w, h);
    }

    for (const st of sc.stars) {
      const a = (0.45 + 0.45 * Math.sin(time * st.speed + st.phase)) * (1 - s.clouds);
      ctx.fillStyle = `rgba(255,255,255,${a})`;
      ctx.beginPath();
      ctx.arc(st.x, st.y, st.r, 0, Math.PI * 2);
      ctx.fill();
    }

    for (const c of sc.clouds) {
      c.x += c.speed * dt;
      if (c.x > w + 10) {
        c.x = -c.sprite.w - rand(0, 80);
        c.y = rand(-0.25, 0.7) * h;
      }
      ctx.globalAlpha = c.alpha;
      ctx.drawImage(c.sprite.img, c.x, c.y, c.sprite.w, c.sprite.h);
    }
    ctx.globalAlpha = 1;

    // Lightning: a bright flash, sometimes followed by a quick second one.
    if (s.thunder && dt > 0) {
      if (time >= sc.nextFlash) {
        sc.flash = 1;
        sc.echo = Math.random() < 0.5 ? time + rand(0.12, 0.25) : 0;
        sc.nextFlash = time + rand(3, 9);
      }
      if (sc.echo && time >= sc.echo) {
        sc.flash = 0.7;
        sc.echo = 0;
      }
      if (sc.flash > 0) {
        ctx.fillStyle = `rgba(235,240,255,${sc.flash * 0.55})`;
        ctx.fillRect(0, 0, w, h);
        sc.flash = Math.max(0, sc.flash - dt * 3.5);
      }
    }

    // Rain: slanted streaks, more slant in stronger wind.
    if (sc.drops.length) {
      const vx = s.wind * 16;
      ctx.strokeStyle = s.period === "night" ? "rgba(190,205,230,0.35)" : "rgba(220,235,255,0.55)";
      ctx.lineWidth = 1.2;
      ctx.lineCap = "round";
      ctx.beginPath();
      for (const d of sc.drops) {
        d.y += d.vy * dt;
        d.x += vx * dt;
        if (d.y - d.len > h) {
          d.y = rand(-40, -5);
          d.x = rand(-0.2, 1) * w;
        }
        ctx.moveTo(d.x, d.y);
        ctx.lineTo(d.x - (vx / d.vy) * d.len, d.y - d.len);
      }
      ctx.stroke();
    }

    // Snow: slow flakes that sway side to side and drift with the wind.
    if (sc.flakes.length) {
      ctx.fillStyle = s.period === "night" ? "rgba(225,232,245,0.7)" : "rgba(255,255,255,0.9)";
      ctx.beginPath();
      for (const f of sc.flakes) {
        f.y += f.vy * dt;
        f.x += s.wind * 8 * dt;
        if (f.y - f.r > h) {
          f.y = rand(-20, -4);
          f.x = rand(-0.2, 1) * w;
        }
        const x = f.x + Math.sin(time * 1.2 + f.phase) * f.amp;
        ctx.moveTo(x + f.r, f.y);
        ctx.arc(x, f.y, f.r, 0, Math.PI * 2);
      }
      ctx.fill();
    }

    // Fog: wide, soft bands sliding slowly sideways.
    for (const b of sc.fogBands) {
      b.x += b.vx * dt;
      if (b.x - b.rx > w) b.x = -b.rx;
      if (b.x + b.rx < 0) b.x = w + b.rx;
      ctx.save();
      ctx.translate(b.x, b.y);
      ctx.scale(b.rx / b.ry, 1);
      const fg = ctx.createRadialGradient(0, 0, 0, 0, 0, b.ry);
      const fc = s.period === "night" ? "150,158,170" : "235,240,245";
      fg.addColorStop(0, `rgba(${fc},${b.a})`);
      fg.addColorStop(1, `rgba(${fc},0)`);
      ctx.fillStyle = fg;
      ctx.beginPath();
      ctx.arc(0, 0, b.ry, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    // Wind: thin wavy streaks rushing across the sky.
    if (sc.streaks.length) {
      ctx.strokeStyle = s.period === "night" ? "rgba(255,255,255,0.12)" : "rgba(255,255,255,0.25)";
      ctx.lineWidth = 1.3;
      ctx.beginPath();
      for (const k of sc.streaks) {
        k.x += k.v * dt;
        if (k.x > w + 20) {
          k.x = rand(-400, -k.len);
          k.y = rand(0.05, 0.95) * h;
        }
        for (let i = 0; i <= 10; i++) {
          const px = k.x + (i / 10) * k.len;
          const py = k.y + Math.sin(px / 40 + k.phase + time * 2) * k.amp;
          if (i === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        }
      }
      ctx.stroke();
    }
  }

  function frame(now) {
    const dt = last ? Math.min((now - last) / 1000, 0.05) : 0;
    last = now;
    draw(dt);
    raf = requestAnimationFrame(frame);
  }

  function start() {
    stop();
    if (reduceMotion.matches || document.hidden) {
      draw(0);
      return;
    }
    last = 0;
    raf = requestAnimationFrame(frame);
  }

  function stop() {
    cancelAnimationFrame(raf);
    raf = 0;
  }

  function resize() {
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    w = rect.width;
    h = rect.height;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    build();
    start();
  }

  function set(input) {
    const forced = params.get("sky");
    const next = describe(forced
      ? { symbol: forced, wind: params.has("wind") ? +params.get("wind") : input.wind, period: input.period }
      : input);
    if (state && JSON.stringify(state) === JSON.stringify(next)) return;
    state = next;
    applyPageColors();
    build();
    start();
  }

  new ResizeObserver(resize).observe(canvas);
  document.addEventListener("visibilitychange", () => (document.hidden ? stop() : start()));
  reduceMotion.addEventListener?.("change", start);

  // Until a forecast arrives, show a calm sky for the time of day.
  const hour = new Date().getHours();
  set({ symbol: "fair", wind: 2, period: hour >= 7 && hour < 19 ? "day" : "night" });

  return { set };
})();
