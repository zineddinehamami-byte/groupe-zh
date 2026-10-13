/* Groupe ZH — script du site vitrine (index.html, simulateurs.html).
   1. Paramètre ?src=xxx : repris dans l'objet des mailto (« Diagnostic offert [réf xxx] »)
      et propagé vers les liens internes marqués data-keep-src (démos, hub).
   2. Synoptique animé du héros (index.html uniquement).
   Sans JavaScript, les liens et les mailto fonctionnent (objet « Diagnostic offert »). */
(function () {
  "use strict";

  var MAIL = "z.hamami.formations@gmail.com";
  var BODY = "Bonjour,\n\nJe souhaite réserver le diagnostic offert de 30 minutes.\n\n" +
    "Entreprise et site : \nProcédé ou unité concernée : \nNombre d’opérateurs à former : \nCréneaux possibles : \n\nCordialement,";

  // --- 1. Référence de campagne -------------------------------------------
  var src = "";
  try {
    var raw = new URLSearchParams(window.location.search).get("src") || "";
    if (/^[A-Za-z0-9._-]{1,48}$/.test(raw)) src = raw; // valeur filtrée : pas d'injection dans l'objet
  } catch (e) { /* navigateur ancien : on garde les liens par défaut */ }

  var subject = "Diagnostic offert" + (src ? " [réf " + src + "]" : "");
  var href = "mailto:" + MAIL + "?subject=" + encodeURIComponent(subject) + "&body=" + encodeURIComponent(BODY);
  document.querySelectorAll("a[data-mailto]").forEach(function (a) { a.setAttribute("href", href); });

  if (src) {
    document.querySelectorAll("a[data-keep-src]").forEach(function (a) {
      var h = a.getAttribute("href") || "";
      var hash = "";
      var i = h.indexOf("#");
      if (i >= 0) { hash = h.slice(i); h = h.slice(0, i); }
      h += (h.indexOf("?") >= 0 ? "&" : "?") + "src=" + encodeURIComponent(src);
      a.setAttribute("href", h + hash);
    });
  }

  // --- 2. Synoptique du héros ----------------------------------------------
  var svg = document.getElementById("hero-synoptic");
  if (!svg) return;

  var $ = function (id) { return document.getElementById(id); };
  var reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* Scénario joué en boucle (14 s réelles ≈ 140 s de procédé à ×10) :
     - 0–3 s : régime établi, T = 80 °C (consigne).
     - 3 s : perte partielle d'efficacité du refroidissement (encrassement de la double enveloppe) :
       la température d'équilibre monte vers 96 °C.
     - ~4,8 s : alarme haute TAH-101 à 90 °C, clignotante tant qu'elle n'est pas acquittée.
     - 5,4 s : acquittement ; 6 s : l'opérateur ouvre la vanne d'eau de refroidissement TV-101 (35 → 75 %, puis 67 %).
     - le procédé revient à la consigne ; retour à la normale avant la fin de la boucle.
     Modèle : deux premiers ordres en série (τ = 0,9 s chacun) : courbe lisse et réaliste. */
  var DUR = 14, N = 420, dt = DUR / N;
  var T1 = 80, T2 = 80, samples = [];
  for (var k = 0; k <= N; k++) {
    var t = k * dt;
    var dist = t >= 3 ? 16 : 0;
    var open = t < 6 ? 35 : t < 6.6 ? 35 + (t - 6) / 0.6 * 40 : t < 9.2 ? 75 : t < 10.2 ? 75 - (t - 9.2) * 8 : 67;
    var cool = (open - 35) * 0.5;          // 20 °C de marge à 75 % d'ouverture, 16 °C à 67 %
    var eq = 80 + dist - cool;              // équilibre (°C) : à 67 %, retour exact à la consigne
    T1 += (eq - T1) / 0.9 * dt;
    T2 += (T1 - T2) / 0.9 * dt;
    samples.push({ t: t, T: T2 + 0.22 * Math.sin(t * 7.3) + 0.12 * Math.sin(t * 17.9), open: open }); // léger bruit de mesure
  }

  // Zone de tendance (coordonnées du SVG)
  var TX0 = 404, TX1 = 624, TY0 = 66, TY1 = 262, VMIN = 70, VMAX = 100;
  var xOf = function (t) { return TX0 + (t / DUR) * (TX1 - TX0); };
  var yOf = function (v) { return TY1 - (v - VMIN) / (VMAX - VMIN) * (TY1 - TY0); };

  var curve = $("trend-curve"), tVal = $("t-value"), tBox = $("t-box"), vOut = $("v-out"),
      alarmRow = $("alarm-row"), alarmText = $("alarm-text"), alarmBg = $("alarm-bg"), clock = $("hmi-clock"),
      cw = document.querySelectorAll(".cw-flow"), mark = $("op-mark"), tah = $("tah-line"), cursor = $("trend-cursor"),
      status = $("hmi-status");

  function fmt(n) { return n.toFixed(1).replace(".", ","); }
  function hhmmss(s) {
    s = Math.floor(s);
    var h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, ss = s % 60;
    return (h < 10 ? "0" : "") + h + ":" + (m < 10 ? "0" : "") + m + ":" + (ss < 10 ? "0" : "") + ss;
  }

  var state = "";
  function render(t) {
    var idx = Math.min(N, Math.max(0, Math.round(t / dt)));
    var pts = [];
    for (var i = 0; i <= idx; i += 2) pts.push(xOf(samples[i].t).toFixed(1) + "," + yOf(samples[i].T).toFixed(1));
    pts.push(xOf(samples[idx].t).toFixed(1) + "," + yOf(samples[idx].T).toFixed(1));
    curve.setAttribute("points", pts.join(" "));
    cursor.setAttribute("x1", xOf(t)); cursor.setAttribute("x2", xOf(t));

    var s = samples[idx];
    tVal.textContent = fmt(s.T);
    vOut.textContent = Math.round(s.open) + " %";
    clock.textContent = hhmmss(2 * 3600 + 14 * 60 + t * 10);

    // Alarme haute : apparition à 90 °C, disparition sous 88 °C (hystérésis)
    var peakPassed = t > 6.2;
    var active = s.T >= 90 || (peakPassed && s.T >= 88 && t < 9);
    var acked = t >= 5.4;
    var next = !active ? "normal" : acked ? "ack" : "alarm";
    if (next !== state) {
      state = next;
      alarmRow.classList.toggle("blink", next === "alarm" && !reduce);
      tBox.classList.toggle("blink", next === "alarm" && !reduce);
      alarmRow.style.display = next === "normal" ? "none" : "";
      $("alarm-none").style.display = next === "normal" ? "" : "none";
      alarmBg.setAttribute("fill", next === "normal" ? "#c9cbcc" : "#d0021b");
      tBox.setAttribute("fill", next === "normal" ? "#f2f3f3" : "#d0021b");
      tVal.setAttribute("fill", next === "normal" ? "#1d2329" : "#ffffff");
      $("t-unit").setAttribute("fill", next === "normal" ? "#4a5259" : "#ffffff");
      tah.setAttribute("stroke", next === "normal" ? "#8a9096" : "#d0021b");
      status.textContent = next === "normal" ? "Aucune alarme active" : next === "alarm" ? "1 alarme non acquittée" : "1 alarme acquittée";
    }
    if (active) alarmText.textContent = "TAH-101  Température réacteur haute  " + fmt(s.T) + " °C";

    var opened = s.open > 36;
    cw.forEach(function (el) { el.classList.toggle("fast", opened); });
    mark.style.display = t >= 6 ? "" : "none";
  }

  if (reduce) { render(DUR - 0.05); return; }

  var start = null, running = false, raf = 0;
  function frame(ts) {
    if (start === null) start = ts;
    var t = ((ts - start) / 1000) % DUR;
    render(t);
    raf = requestAnimationFrame(frame);
  }
  function play() { if (!running) { running = true; start = null; raf = requestAnimationFrame(frame); } }
  function stop() { running = false; cancelAnimationFrame(raf); }

  render(0);
  if ("IntersectionObserver" in window) {
    new IntersectionObserver(function (entries) {
      entries.forEach(function (e) { e.isIntersecting ? play() : stop(); });
    }).observe(svg);
  } else { play(); }
  document.addEventListener("visibilitychange", function () { document.hidden ? stop() : play(); });
})();
