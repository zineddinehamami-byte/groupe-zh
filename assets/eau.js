/* =====================================================================
   Groupe ZH Sim — EAU : station d'épuration à boues activées
   (assets/eau.js, page demo-eau.html)
   ---------------------------------------------------------------------
   S'appuie sur le noyau commun assets/zh-sim-core.js (window.ZHSim) :
   Clock, PID, Alarms, Recorder, Trend, briefing, debrief, Trainer,
   replay, drawer, toast, contact.

   MODÈLE (repères pédagogiques, station type ~30 000 EH, aération prolongée)
   -------------------------------------------------------------------------
   Bassin d'aération parfaitement mélangé, V = 6 000 m³ (séjour ~24 h à Qm).
   États : DBO soluble S, N-NH4, O2 dissous, MES bassin X (g/L), masse de
   boues dans le clarificateur Mc (kg), volume du bassin d'orage.
     dS/dt  = Q/V (Se - S) - rH
     dNH/dt = Q/V (NHe - NH) - rN
     dO2/dt = kLa (Csat - O2) - OUR - (Q + Qr)/V O2      kLa = kA x Qair
     dX/dt  = [Qr Xr - (Q + Qr) X]/V + Yobs rH
     dMc/dt = (Q + Qr) X - (Qr + Qw) Xr - Qe Xe
   Cinétiques de Monod doubles (substrat x oxygène) :
     rH = kH X S/(KS+S) O2/(KOH+O2)   ;  rN = kN X NH/(KNH+NH) O2/(KOA+O2)
     OUR = 0,55 rH + 4,3 rN + kEnd X O2/(KOH+O2)   (≈ 25-35 mg O2/L/h)
   Clarificateur (Ø 30 m, 700 m²) en modèle « masse de voile » :
     hauteur de voile h = Mc / (A x Cvoile) ; foisonnement hydraulique quand
     la vitesse ascensionnelle Qe/A dépasse ~0,45 m/h ;
     concentration de recirculation Xr = Xrmax (1 - exp(-Mc/M0)) (épaississement) ;
     MES de sortie = fond + effet de vitesse ascensionnelle + départ de boues
     quand le voile dépasse ~2,3 m.
   Surpresseurs : 3 x 2 000 Nm³/h (2 en service + 1 secours), vitesse variable
   30-100 %, rampe 1 %/s, démarrage 2 min ; régulation O2 AIC-101 (PI du noyau).
   Recirculation : 2 pompes 450 m³/h (P-301 en service, P-302 secours).
   Bassin d'orage 3 500 m³ : by-pass au-delà d'un débit maximal admis en
   biologie ; restitution automatique à 120 m³/h quand le débit baisse.
   Sondes : O2 (retard 45 s), NH4 (analyseur, retard 10 min), MES de sortie
   (2 min), voile (3 min).
   Temps : le pas fixe est de 5 s de procédé. Le « cycle journalier accéléré »
   est obtenu par la vitesse : ×1 = 18 s de procédé par seconde réelle, donc
   ×10 = 3 min de procédé par seconde ; le poste de jour 06:00-18:00 dure 4 min.
   Toutes les valeurs sont des REPÈRES PÉDAGOGIQUES, pas des données de site.
   ===================================================================== */
(function (global) {
  'use strict';

  /* ------------------------------------------------------------ paramètres */
  var P = {
    dt: 5,                  // pas d'intégration (s de procédé)
    startHour: 6,           // prise de poste 06:00
    duration: 12 * 3600,    // poste de jour : 12 h de procédé
    timeScale: 18,          // ×1 = 18 s de procédé / s réelle
    // Hydraulique et charge d'entrée (temps sec)
    Qm: 250,                // débit moyen, m³/h (6 000 m³/j)
    Sin: 280,               // DBO5 entrée, mg/L
    NHin: 45,               // N-NH4 entrée (après ammonification), mg N/L
    V: 6000,                // bassin d'aération, m³
    // Cinétiques (base MES)
    kH: 0.15, KS: 20, KOH: 0.2, Yobs: 0.75, fOH: 0.55,
    kN: 0.00125, KNH: 1.0, KOA: 1.0, fON: 4.3,
    kEnd: 0.0035,
    Csat: 8.6,              // saturation effective (alpha, température ~15 °C)
    kA: 0.0013,             // kLa (1/h) par Nm³/h d'air insufflé
    // Surpresseurs
    QairMax: 2000, minSpeed: 0.3, ramp: 0.01, blowerStart: 120,
    // Régulation O2 (PI)
    Kp: 15, Ti: 480,
    // Clarificateur
    Ac: 700, Hc: 4.0, XrMax: 11, M0: 4000, Cb: 6, kExp: 0.9,
    // Recirculation
    QpMax: 450, pumpStart: 30,
    // Bassin d'orage
    Vst: 3500, Qret: 120,
    // Normes de rejet (repères pédagogiques)
    normMES: 35, normNH4: 10, normDBO: 25
  };

  // Profil horaire de débit par temps sec (facteur / Qm), normalisé à 1.
  var HQ = [0.65, 0.55, 0.5, 0.47, 0.47, 0.52, 0.7, 0.95, 1.15, 1.25, 1.3, 1.32,
    1.3, 1.22, 1.15, 1.08, 1.05, 1.08, 1.15, 1.2, 1.18, 1.08, 0.92, 0.78];
  (function () { var s = 0; HQ.forEach(function (v) { s += v; }); for (var i = 0; i < 24; i++) HQ[i] *= 24 / s; })();
  function dryFactor(hour) {
    var h = ((hour % 24) + 24) % 24, i = Math.floor(h), f = h - i;
    return HQ[i] * (1 - f) + HQ[(i + 1) % 24] * f;
  }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function noise() { return (Math.random() - 0.5) * 2; }

  /* ---------------------------------------------------------------- modèle */
  /** pid : objet compatible ZHSim.PID ({sp, out, mode, update(pv,dt), setMode}) */
  function EauModel(o) { this.pid = o.pid; this.reset(); }

  EauModel.prototype.reset = function () {
    this.t = 0;
    this.S = 1.5; this.NH = 1.5; this.SO = 2; this.X = 3.5; this.Mc = 4700;
    this.Vst = 0; this.Sst = 0; this.NHst = 0; this.Qr = 200;
    this.storm = null; this.nhPeak = null;
    this.bl = [
      { id: 'S1', state: 'run', speed: 0.6, timer: 0, air: 0 },
      { id: 'S2', state: 'run', speed: 0.6, timer: 0, air: 0 },
      { id: 'S3', state: 'stop', speed: 0, timer: 0, air: 0, secours: true }];
    this.pumps = [
      { id: 'P-301', state: 'run', eff: 1, fail: false, timer: 0, q: 0 },
      { id: 'P-302', state: 'stop', eff: 1, fail: false, timer: 0, q: 0, secours: true }];
    this.rec = { sp: 200 };
    this.byp = { on: false, lim: 400 };
    this.ext = { on: true, q: 7 };
    this.probe = { offset: 0, fouled: false, maint: 0, raw: 2 };
    this.lag = { nh: 1.5, mes: 6, voile: 1.1 };
    this.m = {};
    this.pid.sp = 2; this.pid.out = 60; this.pid.setMode('AUTO');
    this.st = { t: 0, heffMax: 0, mesMax: 0, nhMax: 0, o2Min: 99, ovf: 0, tNC: 0, tO2: 0, Vmax: 0 };
    // mise en régime : 2 jours de temps sec avant la prise de poste
    this.warm = true; this.t = -48 * 3600;
    while (this.t < 0) this.step(P.dt);
    this.t = 0; this.warm = false;
  };

  EauModel.prototype.step = function (dt) {
    var h = dt / 3600, hour = P.startHour + this.t / 3600, fq = dryFactor(hour);
    // --- influent : temps sec + pluie + pointe ammoniacale éventuelle
    var Qdry = P.Qm * fq, Sdry = P.Sin * (1 + 0.45 * (fq - 1)), NHdry = P.NHin * (1 + 0.3 * (fq - 1));
    if (this.nhPeak !== null) { if ((this.t - this.nhPeak) < 3 * 3600) NHdry *= 1.8; else this.nhPeak = null; }
    var Qrain = 0, Sr = 50, NHr = 4;
    if (this.storm !== null) {
      var ts = (this.t - this.storm) / 3600, sh;
      if (ts < 0.67) sh = ts / 0.67; else if (ts < 4.67) sh = 1; else if (ts < 7.67) sh = 1 - (ts - 4.67) / 3; else { sh = 0; this.storm = null; }
      Qrain = 2 * P.Qm * sh;                       // débit ×3 au plus fort de l'orage
      if (ts < 1.2) { Sr = 260; NHr = 15; }         // effet de premier flot
    }
    var Qin = Qdry + Qrain, Sin = (Qdry * Sdry + Qrain * Sr) / Qin, NHin = (Qdry * NHdry + Qrain * NHr) / Qin;
    // --- by-pass vers bassin d'orage
    var Qbio = Qin, Qst = 0, Qovf = 0, Qret = 0, lim = this.byp.lim;
    if (this.byp.on && Qin > lim) {
      Qst = Qin - lim; Qbio = lim;
      var space = (P.Vst - this.Vst) / h; if (Qst > space) { Qovf = Qst - space; Qst = space; }
    } else if (this.Vst > 0 && Qin < lim - 30) {
      Qret = Math.min(P.Qret, lim - 30 - Qin, this.Vst / h);
    }
    if (Qst > 0) {
      var nv = this.Vst + Qst * h;
      this.Sst = (this.Sst * this.Vst + Sin * Qst * h) / nv; this.NHst = (this.NHst * this.Vst + NHin * Qst * h) / nv; this.Vst = nv;
    }
    if (Qret > 0) this.Vst = Math.max(0, this.Vst - Qret * h);
    var SinB = (Qbio * Sin + Qret * this.Sst) / (Qbio + Qret), NHinB = (Qbio * NHin + Qret * this.NHst) / (Qbio + Qret);
    Qbio += Qret;
    // --- sonde O2 (encrassement : dérive vers le haut, réponse lente)
    var pr = this.probe;
    if (pr.fouled) pr.offset = Math.min(1.9, pr.offset + 1.9 * dt / 4500);
    pr.raw += (this.SO + pr.offset - pr.raw) * Math.min(1, dt / (pr.fouled ? 240 : 45));
    if (pr.maint > 0) { pr.maint -= dt; if (pr.maint <= 0) { pr.maint = 0; pr.offset = 0; pr.fouled = false; pr.raw = this.SO; } }
    var o2m = pr.maint > 0 ? NaN : Math.max(0, pr.raw + 0.02 * noise());
    // --- régulation O2 : maintien de la sortie pendant la maintenance de la sonde
    var pid = this.pid;
    if (pr.maint > 0) pid._e1 = null; else pid.update(o2m, dt);
    // --- surpresseurs
    var tgt = clamp(pid.out / 100, P.minSpeed, 1), air = 0;
    this.bl.forEach(function (b) {
      if (b.state === 'start') { b.timer -= dt; if (b.timer <= 0) { b.state = 'run'; b.speed = P.minSpeed; } }
      if (b.state === 'run') { b.speed += clamp(tgt - b.speed, -P.ramp * dt, P.ramp * dt); b.air = b.speed * P.QairMax; }
      else { b.air = 0; b.speed = 0; }
      air += b.air;
    });
    // --- recirculation
    var cap = 0;
    this.pumps.forEach(function (p) {
      if (p.state === 'start') { p.timer -= dt; if (p.timer <= 0) p.state = 'run'; }
      if (p.fail) p.eff *= Math.exp(-dt / 400);    // désamorçage progressif
      p.cap = p.state === 'run' ? P.QpMax * p.eff : 0; cap += p.cap;
    });
    this.Qr += (Math.min(this.rec.sp, cap) - this.Qr) * Math.min(1, dt / 90);
    var Qr = this.Qr;
    this.pumps.forEach(function (p) { p.q = cap > 0 ? Qr * p.cap / cap : 0; });
    // --- clarificateur
    var Qw = this.ext.on ? this.ext.q : 0;
    var Xr = P.XrMax * (1 - Math.exp(-this.Mc / P.M0));
    var Qe = Math.max(0, Qbio - Qw), Vasc = Qe / P.Ac;
    var hb = this.Mc / (P.Ac * P.Cb);
    var heff = Math.min(P.Hc, hb * (1 + P.kExp * Math.max(0, Vasc - 0.45)));
    var Xe = Math.min(3000, 5 + 16 * Math.max(0, Vasc - 0.55) + 300 * Math.pow(Math.max(0, heff - 2.3), 1.5)); // mg/L
    // --- biologie
    var X = this.X, Xg = X * 1000, S = this.S, NH = this.NH, SO = this.SO, fO = SO / (P.KOH + SO);
    var rH = P.kH * Xg * S / (P.KS + S) * fO;
    var rN = P.kN * Xg * NH / (P.KNH + NH) * SO / (P.KOA + SO);
    var OUR = P.fOH * rH + P.fON * rN + P.kEnd * Xg * fO, kLa = P.kA * air;
    this.S = Math.max(0, S + h * (Qbio / P.V * (SinB - S) - rH));
    this.NH = Math.max(0, NH + h * (Qbio / P.V * (NHinB - NH) - rN));
    this.SO = Math.max(0, SO + h * (kLa * (P.Csat - SO) - OUR - (Qbio + Qr) / P.V * SO));
    this.X = Math.max(0.3, X + h * ((Qr * Xr - (Qbio + Qr) * X) / P.V + P.Yobs * rH / 1000));
    this.Mc = Math.max(0, this.Mc + h * ((Qbio + Qr) * X - (Qr + Qw) * Xr - Qe * Xe / 1000));
    // --- mesures
    var L = this.lag, m = this.m;
    L.nh += (this.NH - L.nh) * Math.min(1, dt / 600);
    L.mes += (Xe - L.mes) * Math.min(1, dt / 120);
    L.voile += (heff - L.voile) * Math.min(1, dt / 180);
    var dbo = this.S + 0.4 * Xe;
    m.qin = Qin * (1 + 0.008 * noise()); m.qrain = Qrain; m.qbio = Qbio; m.qst = Qst; m.qovf = Qovf; m.qret = Qret;
    m.sin = Sin; m.nhin = NHin; m.o2 = o2m; m.o2r = this.SO; m.air = air * (1 + 0.004 * noise()); m.kla = kLa;
    m.qr = Math.max(0, Qr + 1.5 * noise()); m.qw = Qw; m.qe = Qe; m.vasc = Vasc; m.xr = Xr;
    m.nh = Math.max(0, L.nh + 0.04 * noise()); m.mes = Math.max(0, L.mes + 0.3 * noise()); m.voile = Math.max(0, L.voile + 0.01 * noise());
    m.heff = heff; m.x = this.X; m.dbo = dbo; m.st = this.Vst / P.Vst * 100; m.our = OUR;
    // --- bilan du poste
    if (!this.warm) {
      var s = this.st; s.t += dt;
      s.heffMax = Math.max(s.heffMax, heff); s.mesMax = Math.max(s.mesMax, Xe); s.nhMax = Math.max(s.nhMax, this.NH);
      s.o2Min = Math.min(s.o2Min, this.SO); s.ovf += Qovf * h; s.Vmax = Math.max(s.Vmax, this.Vst);
      if (Xe > P.normMES || this.NH > P.normNH4 || dbo > P.normDBO || Qovf > 0) s.tNC += dt;
      if (this.SO >= 1.2 && this.SO <= 3.5) s.tO2 += dt;
    }
    this.t += dt;
  };

  /** Pannes : orage | blower | sonde | recirc | nh4 */
  EauModel.prototype.inject = function (kind) {
    var self = this;
    if (kind === 'orage') this.storm = this.t;
    else if (kind === 'nh4') this.nhPeak = this.t;
    else if (kind === 'sonde') this.probe.fouled = true;
    else if (kind === 'blower') {
      var b = this.bl.filter(function (x) { return x.state === 'run' && !x.secours; })[0] || this.bl.filter(function (x) { return x.state === 'run'; })[0];
      if (b) { b.state = 'fault'; b.air = 0; b.speed = 0; }
    } else if (kind === 'recirc') {
      var p = this.pumps.filter(function (x) { return x.state === 'run' && !x.fail; })[0];
      if (p) p.fail = true;
    }
    return self;
  };
  EauModel.prototype.blower = function (id, cmd) {
    var b = this.bl.filter(function (x) { return x.id === id; })[0]; if (!b) return false;
    if (cmd === 'start' && b.state === 'stop') { b.state = 'start'; b.timer = P.blowerStart; return true; }
    if (cmd === 'stop' && (b.state === 'run' || b.state === 'start')) { b.state = 'stop'; return true; }
    return false;
  };
  EauModel.prototype.pump = function (id, cmd) {
    var p = this.pumps.filter(function (x) { return x.id === id; })[0]; if (!p) return false;
    if (cmd === 'start' && p.state === 'stop') { p.state = 'start'; p.timer = P.pumpStart; return true; }
    if (cmd === 'stop' && (p.state === 'run' || p.state === 'start')) { p.state = 'stop'; return true; }
    return false;
  };
  EauModel.prototype.probeClean = function () { if (this.probe.maint > 0) return false; this.probe.maint = 600; return true; };

  if (typeof module !== 'undefined' && module.exports) { module.exports = { EauModel: EauModel, P: P, dryFactor: dryFactor }; }
  if (!global.document || !global.ZHSim) return;

  /* =====================================================================
     INTERFACE
     ===================================================================== */
  var Z = global.ZHSim, U = Z.util;
  var SPEEDS = [P.timeScale, P.timeScale * 5, P.timeScale * 10];
  var model, clock, alarms, rec, trends = {}, trainer, scen = null, incident = null, R = {}, debriefArgs = null;
  var lastRender = 0, replaying = false, endArm = 0;
  var $ = function (s) { return document.querySelector(s); };

  var SCN = {
    orage: { title: 'Orage : débit ×3', level: 1, kind: 'orage' },
    surpresseur: { title: 'Panne d’un surpresseur', level: 2, kind: 'blower' },
    mystere: { title: 'Mystère', level: 3, kind: null }
  };
  var KIND_LABEL = {
    orage: 'Orage : le débit d’entrée triple',
    blower: 'Déclenchement d’un surpresseur en service',
    sonde: 'Sonde O₂ encrassée : elle lit trop haut',
    recirc: 'Pompe de recirculation P-301 désamorcée (moteur en marche, débit nul)',
    nh4: 'Pointe de charge ammoniacale (×1,8 pendant 3 h)'
  };
  var RELEVANT = {
    orage: ['bypass_on', 'qr', 'ext_off', 'ext_q'],
    blower: ['blower_start'],
    sonde: ['probe_check', 'probe_clean', 'pid_man', 'pid_sp'],
    recirc: ['pump_start'],
    nh4: ['pid_sp', 'blower_start']
  };

  /* ------------------------------------------------------------ synoptique */
  function vb(id, x, y, tag, unit, w, fp, extra) {
    w = w || 118;
    return '<g class="zh-click eau-vb" id="' + id + '" data-fp="' + (fp || '') + '" transform="translate(' + x + ' ' + y + ')">' +
      '<rect class="zh-valbox" width="' + w + '" height="42" rx="3"/>' +
      '<g class="zh-almind"><rect x="' + (w - 13) + '" y="4" width="9" height="9"/></g>' +
      '<text class="zh-tag" x="6" y="14">' + tag + '</text>' + (extra || '') +
      '<text class="zh-val" x="6" y="34" data-v>---</text>' +
      '<text class="zh-unit" x="' + (w - 6) + '" y="34" text-anchor="end">' + unit + '</text></g>';
  }
  function pipe(id, d, thin) {
    return '<path class="zh-line' + (thin ? ' zh-line--thin' : '') + '" d="' + d + '"/>' +
      '<path class="zh-flowover eau-fo" id="' + id + '" d="' + d + '"/>';
  }
  function blower(id, cx, cy, label) {
    return '<g class="zh-click eau-blower" id="bl_' + id + '" data-fp="fp_bl">' +
      '<circle class="zh-equip eau-blc" cx="' + cx + '" cy="' + cy + '" r="22"/>' +
      '<g class="eau-fan" data-cx="' + cx + '" data-cy="' + cy + '">' +
      [0, 120, 240].map(function (a) {
        return '<path d="M' + cx + ' ' + cy + ' q 4 -14 0 -17 q -6 3 0 17 z" transform="rotate(' + a + ' ' + cx + ' ' + cy + ')"/>';
      }).join('') + '<circle cx="' + cx + '" cy="' + cy + '" r="3"/></g>' +
      '<text class="zh-tag" x="' + (cx + 28) + '" y="' + (cy - 8) + '" style="font-size:12px;fill:#1d2329">' + label + '</text>' +
      '<text class="zh-label eau-st" x="' + (cx + 28) + '" y="' + (cy + 6) + '">ARRÊT</text>' +
      '<text class="zh-unit eau-air" x="' + (cx + 28) + '" y="' + (cy + 20) + '"></text></g>';
  }
  function pumpSym(id, cx, cy) {
    return '<g class="zh-click eau-pump" id="pp_' + id + '" data-fp="fp_rec">' +
      '<circle class="zh-equip eau-pc" cx="' + cx + '" cy="' + cy + '" r="14"/>' +
      '<path class="eau-pt" d="M' + (cx + 8) + ' ' + (cy - 9) + ' L' + (cx - 12) + ' ' + cy + ' L' + (cx + 8) + ' ' + (cy + 9) + ' z"/>' +
      '<text class="zh-tag" x="' + cx + '" y="' + (id === 'P-302' ? cy + 28 : cy - 19) + '" text-anchor="middle">' + id + '</text></g>';
  }
  function valve(id, cx, cy, vertical) {
    var d = vertical ? 'M' + (cx - 9) + ' ' + (cy - 11) + ' H' + (cx + 9) + ' L' + (cx - 9) + ' ' + (cy + 11) + ' H' + (cx + 9) + ' Z'
      : 'M' + (cx - 11) + ' ' + (cy - 9) + ' V' + (cy + 9) + ' L' + (cx + 11) + ' ' + (cy - 9) + ' V' + (cy + 9) + ' Z';
    return '<path class="eau-valve" id="' + id + '" d="' + d + '"/>';
  }

  function buildSVG() {
    var s = '';
    s += '<defs>' +
      '<clipPath id="clipBasin"><rect x="264" y="117" width="384" height="301"/></clipPath>' +
      '<clipPath id="clipClar"><path d="M762 118 V330 L900 396 H920 L1058 330 V118 Z"/></clipPath>' +
      '<clipPath id="clipSt"><rect x="32" y="302" width="156" height="126"/></clipPath>' +
      '<linearGradient id="gBlanket" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#8a9096"/><stop offset="1" stop-color="#4a535b"/></linearGradient>' +
      '<marker id="arr" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0 L10 5 L0 10 z" fill="#5f666d"/></marker>' +
      '</defs>';
    // pluie (information)
    s += '<g id="rain" class="eau-rain" style="display:none">' +
      (function () { var r = ''; for (var i = 0; i < 14; i++) r += '<line x1="' + (18 + i * 9) + '" y1="0" x2="' + (14 + i * 9) + '" y2="10" data-i="' + i + '"/>'; return r; })() +
      '<text x="150" y="40" class="eau-raintxt" id="rainTxt">Pluie</text></g>';
    // arrivée
    s += '<text class="zh-label" x="10" y="140" style="font-weight:700">EAUX USÉES</text>';
    s += pipe('fl_in', 'M0 150 H262');
    s += vb('vb_qin', 12, 72, 'FT-001 Entrée', 'm³/h', 128, 'fp_byp');
    s += vb('vb_in', 12, 162, 'DBO₅ / NH₄ entrée', 'mg/L', 128, '');
    // by-pass et bassin d'orage
    s += pipe('fl_byp', 'M150 150 V302');
    s += valve('xv001', 150, 240, true);
    s += '<g class="zh-click" data-fp="fp_byp"><text class="zh-tag" x="164" y="236">XV-001</text><text class="zh-label" id="xv001t" x="164" y="250">fermée</text></g>';
    s += '<rect class="zh-equip" x="30" y="300" width="160" height="130"/>';
    s += '<rect id="stLvl" class="zh-fill" clip-path="url(#clipSt)" x="32" y="428" width="156" height="0"/>';
    s += '<text class="zh-label" x="110" y="447" text-anchor="middle" style="font-weight:700">BASSIN D’ORAGE</text><text class="zh-unit" x="110" y="460" text-anchor="middle">3 500 m³</text>';
    s += vb('vb_st', 40, 334, 'LT-501 Niveau', '%', 120, 'fp_byp');
    s += pipe('fl_ret', 'M190 412 H222 V152', true);
    s += '<circle class="zh-equip" cx="222" cy="330" r="8"/><text class="zh-tag" x="222" y="314" text-anchor="middle" style="font-size:9px">P-501</text>';
    s += pipe('fl_ovf', 'M30 318 H12 V630', true);
    s += '<path class="zh-line zh-line--thin" d="M12 622 V636" marker-end="url(#arr)"/><text class="zh-label" id="ovfTxt" x="20" y="640">Déversoir → milieu naturel</text>';
    // recirculation (colonne montante)
    s += pipe('fl_rec', 'M795 596 H246 V200 H262');
    // bassin d'aération
    s += '<text class="zh-label" x="456" y="88" text-anchor="middle" style="font-weight:700">BASSIN D’AÉRATION · 6 000 m³</text>';
    s += '<rect class="zh-fill" x="264" y="117" width="384" height="301" opacity=".55"/>';
    s += '<rect class="zh-equip" x="262" y="96" width="388" height="324" style="fill:none"/>';
    s += '<path class="eau-surf" d="M264 117 H648"/>';
    s += '<g id="bubbles" clip-path="url(#clipBasin)"></g>';
    s += '<path class="zh-line zh-line--thin" d="M285 404 H630"/>';
    for (var i = 0; i < 10; i++) s += '<ellipse class="eau-diff" cx="' + (298 + i * 37) + '" cy="404" rx="9" ry="3"/>';
    s += vb('vb_o2', 280, 128, 'AT-101 O₂', 'mg/L', 150, 'fp_o2', '<text class="zh-tag zh-sp" x="132" y="14" text-anchor="end" id="o2sp">SP 2.0</text>');
    s += '<g class="zh-click" data-fp="fp_o2"><circle cx="458" cy="149" r="17" fill="#eef0f1" stroke="#5f666d" stroke-width="1.5"/><line x1="441" y1="149" x2="475" y2="149" stroke="#5f666d"/>' +
      '<text class="zh-tag" x="458" y="146" text-anchor="middle" style="font-size:9px">AIC</text><text class="zh-tag" x="458" y="160" text-anchor="middle" style="font-size:9px">101</text>' +
      '<text class="zh-label" x="482" y="146">Sortie</text><text class="zh-val" id="pidOut" x="482" y="162" style="font-size:12px">60 %</text>' +
      '<text class="zh-label" id="pidMode" x="530" y="162" style="font-weight:700">AUTO</text></g>';
    s += vb('vb_x', 280, 182, 'AT-104 MES bassin', 'g/L', 150, 'fp_ext');
    // air
    s += pipe('fl_air', 'M585 470 H285 V404', true);
    s += blower('S1', 330, 512, 'S1') + blower('S2', 445, 512, 'S2') + blower('S3', 560, 512, 'S3 secours');
    s += '<path class="zh-line zh-line--thin" d="M330 490 V470 M445 490 V470 M560 490 V470"/>';
    s += vb('vb_air', 596, 448, 'FT-201 Air total', 'Nm³/h', 132, 'fp_bl');
    // vers clarificateur
    s += pipe('fl_mix', 'M650 140 H910 V180');
    // clarificateur
    s += '<text class="zh-label" x="910" y="88" text-anchor="middle" style="font-weight:700">CLARIFICATEUR · Ø 30 m</text>';
    s += '<path d="M762 118 V330 L900 396 H920 L1058 330 V118 Z" fill="#cdd2d6"/>';
    s += '<g id="g_clar"><path id="blanket" clip-path="url(#clipClar)" fill="url(#gBlanket)" d=""/><path id="blTop" class="eau-bltop" clip-path="url(#clipClar)" d=""/></g>';
    s += '<g id="carry" clip-path="url(#clipClar)"></g>';
    s += '<path class="zh-equip" style="fill:none" d="M760 112 V330 L900 398 H920 L1060 330 V112"/>';
    s += '<rect x="893" y="116" width="34" height="96" fill="none" stroke="#8a9096" stroke-width="2"/>';
    s += '<path class="zh-line zh-line--thin" d="M760 124 H776 V132 M1060 124 H1044 V132"/>';
    s += '<path class="eau-surf" d="M762 120 H1058"/>';
    s += '<path id="blMark" class="eau-blmark" d=""/>';
    s += vb('vb_voile', 656, 232, 'LT-301 Voile', 'm', 100, 'fp_rec');
    s += '<path class="zh-line zh-line--signal" d="M754 253 H768"/>';
    // rejet
    s += pipe('fl_eff', 'M1060 124 H1200');
    s += '<text class="zh-label" x="1196" y="110" text-anchor="end" style="font-weight:700">REJET → MILIEU</text>';
    s += vb('vb_mes', 1074, 146, 'AT-401 MES ≤35', 'mg/L', 122, '');
    s += vb('vb_nh', 1074, 196, 'AT-102 NH₄ ≤10', 'mg/L', 122, 'fp_o2');
    s += vb('vb_dbo', 1074, 246, 'DBO₅ estim. ≤25', 'mg/L', 122, '');
    s += vb('vb_vasc', 1074, 296, 'Vasc = Qe/A', 'm/h', 122, 'fp_byp');
    // soutirage, pompes, extraction
    s += pipe('fl_und', 'M910 398 V596 H824');
    s += pipe('fl_rec2', 'M880 596 V626 H824 M796 626 H770 V596', false);
    s += pumpSym('P-301', 810, 596) + pumpSym('P-302', 810, 626);
    s += '<text class="zh-label" x="470" y="588" style="font-weight:700">RECIRCULATION DES BOUES</text>';
    s += vb('vb_qr', 600, 602, 'FIC-301', 'm³/h', 132, 'fp_rec', '<text class="zh-tag zh-sp" x="114" y="14" text-anchor="end" id="qrsp"></text>');
    s += pipe('fl_ext', 'M910 520 H1012', true);
    s += valve('xv302', 960, 520, false);
    s += '<text class="zh-tag" x="960" y="504" text-anchor="middle">XV-302</text>';
    s += '<text class="zh-label" x="1016" y="516" style="font-weight:700">EXTRACTION</text><text class="zh-unit" x="1016" y="530">vers traitement des boues</text>';
    s += vb('vb_qw', 1016, 540, 'FT-302 Extraction', 'm³/h', 132, 'fp_ext');
    var host = $('#syn');
    host.innerHTML = '<svg class="zh-svg" viewBox="0 30 1200 630" role="img" aria-label="Synoptique de la station d’épuration">' + s + '</svg>';
    // références
    R.vb = {};
    Array.prototype.forEach.call(host.querySelectorAll('.eau-vb'), function (g) { R.vb[g.id] = { v: g.querySelector('[data-v]'), last: null }; });
    R.fo = {};
    Array.prototype.forEach.call(host.querySelectorAll('.eau-fo'), function (p) { R.fo[p.id] = { el: p, last: null }; });
    R.bub = []; var bg = $('#bubbles'), ns = 'http://www.w3.org/2000/svg';
    for (var b = 0; b < 70; b++) {
      var c = document.createElementNS(ns, 'circle');
      c.setAttribute('r', (1.6 + Math.random() * 2.2).toFixed(1)); c.setAttribute('class', 'eau-bub');
      bg.appendChild(c); R.bub.push({ el: c, x: 0, y: 420 + Math.random() * 300, v: 0.6 + Math.random() * 0.8, ph: Math.random() * 6 });
    }
    R.car = []; var cg = $('#carry');
    for (var k = 0; k < 24; k++) {
      var d = document.createElementNS(ns, 'circle'); d.setAttribute('r', '1.8'); d.setAttribute('class', 'eau-car'); cg.appendChild(d);
      R.car.push({ el: d, x: 770 + Math.random() * 280, y: 300, v: 0.5 + Math.random() });
    }
    R.blowers = {}; ['S1', 'S2', 'S3'].forEach(function (id) {
      var g = $('#bl_' + id); R.blowers[id] = { g: g, fan: g.querySelector('.eau-fan'), st: g.querySelector('.eau-st'), air: g.querySelector('.eau-air'), a: 0, last: '' };
    });
    R.pumps = {}; ['P-301', 'P-302'].forEach(function (id) { R.pumps[id] = $('#pp_' + id.replace(/[^\w-]/g, '')); });
    R.rain = Array.prototype.slice.call(document.querySelectorAll('#rain line'));
    // clic sur un équipement : ouvre la faceplate correspondante
    host.addEventListener('click', function (e) {
      var g = e.target.closest('[data-fp]'); if (!g) return; var id = g.getAttribute('data-fp'); if (!id) return;
      focusFP(id);
    });
  }

  function focusFP(id) {
    var fp = document.getElementById(id); if (!fp) return;
    var panel = $('#zh-panel');
    if (global.matchMedia('(max-width: 900px)').matches && !panel.classList.contains('zh-open')) $('#drawerBtn').click();
    fp.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    fp.classList.remove('eau-flash'); void fp.offsetWidth; fp.classList.add('eau-flash');
  }

  /* --------------------------------------------------------- faceplates */
  function buildPanel() {
    var p = $('#zh-panel');
    p.innerHTML =
      '<div class="zh-fp" id="fp_o2"><div class="zh-fp-h"><span class="zh-fp-tag">AIC-101</span><span class="zh-fp-title">Oxygène dissous · bassin</span></div>' +
      '<div class="zh-fp-row"><span class="zh-lbl">Mesure</span><span class="zh-v" id="f_o2pv">--</span></div>' +
      '<div class="zh-bar eau-pvbar"><i id="f_o2bar"></i><b id="f_o2spm"></b></div>' +
      '<div class="zh-fp-row"><span class="zh-lbl">Consigne</span><span class="eau-step"><button type="button" class="zh-btn eau-sm" data-a="sp-" aria-label="Baisser la consigne">−</button>' +
      '<span class="zh-v zh-sp" id="f_o2sp">2.0 mg/L</span><button type="button" class="zh-btn eau-sm" data-a="sp+" aria-label="Monter la consigne">+</button></span></div>' +
      '<div class="zh-fp-row"><span class="zh-lbl">Sortie vers surpresseurs</span><span class="zh-v" id="f_o2out">--</span></div>' +
      '<div class="zh-fp-row"><span class="zh-lbl">Mode</span><span class="zh-mode"><button type="button" data-a="auto">AUTO</button><button type="button" data-a="man">MAN</button></span></div>' +
      '<input type="range" id="f_o2man" min="0" max="100" step="1" aria-label="Sortie manuelle" disabled>' +
      '<p class="zh-hint" id="f_o2hint">AUTO : la régulation ajuste la vitesse des surpresseurs.</p></div>' +

      '<div class="zh-fp" id="fp_bl"><div class="zh-fp-h"><span class="zh-fp-tag">SURPRESSEURS</span><span class="zh-fp-title">3 × 2 000 Nm³/h</span></div>' +
      ['S1', 'S2', 'S3'].map(function (id) {
        return '<div class="zh-fp-row eau-eq"><span><b class="zh-mono">' + id + '</b>' + (id === 'S3' ? ' <small>secours</small>' : '') + ' <span class="zh-state" id="f_' + id + 'st">--</span></span>' +
          '<span class="zh-v" id="f_' + id + 'air">--</span><button type="button" class="zh-btn eau-sm" data-bl="' + id + '">--</button></div>';
      }).join('') +
      '<div class="zh-fp-row"><span class="zh-lbl">Air total FT-201</span><span class="zh-v" id="f_airt">--</span></div>' +
      '<p class="zh-hint">Le secours S3 démarre en 2 min, puis prend la consigne de la régulation.</p></div>' +

      '<div class="zh-fp" id="fp_rec"><div class="zh-fp-h"><span class="zh-fp-tag">FIC-301</span><span class="zh-fp-title">Recirculation des boues</span></div>' +
      '<div class="zh-fp-row"><span class="zh-lbl">Débit mesuré</span><span class="zh-v" id="f_qr">--</span></div>' +
      '<div class="zh-fp-row"><span class="zh-lbl">Consigne</span><span class="zh-v zh-sp" id="f_qrsp">--</span></div>' +
      '<input type="range" id="f_qrr" min="0" max="800" step="10" aria-label="Consigne de recirculation">' +
      '<div class="zh-fp-row"><span class="zh-lbl">Taux de recirculation</span><span class="zh-v" id="f_qrratio">--</span></div>' +
      ['P-301', 'P-302'].map(function (id) {
        return '<div class="zh-fp-row eau-eq"><span><b class="zh-mono">' + id + '</b>' + (id === 'P-302' ? ' <small>secours</small>' : '') + ' <span class="zh-state" id="f_' + id + 'st">--</span></span>' +
          '<span class="zh-v" id="f_' + id + 'q">--</span><button type="button" class="zh-btn eau-sm" data-pp="' + id + '">--</button></div>';
      }).join('') +
      '<div class="zh-fp-row"><span class="zh-lbl">Voile LT-301</span><span class="zh-v" id="f_voile">--</span></div></div>' +

      '<div class="zh-fp" id="fp_byp"><div class="zh-fp-h"><span class="zh-fp-tag">XV-001</span><span class="zh-fp-title">By-pass vers bassin d’orage</span></div>' +
      '<div class="zh-fp-row"><span class="zh-lbl">Débit d’entrée FT-001</span><span class="zh-v" id="f_qin">--</span></div>' +
      '<div class="zh-fp-row"><span class="zh-lbl">Débit max admis en biologie</span><span class="zh-v zh-sp" id="f_lim">--</span></div>' +
      '<input type="range" id="f_limr" min="300" max="500" step="10" aria-label="Débit maximal admis en biologie">' +
      '<div class="zh-fp-row"><span class="zh-lbl">Bassin d’orage LT-501</span><span class="zh-v" id="f_st">--</span></div>' +
      '<div class="zh-fp-btns"><button type="button" class="zh-btn zh-btn--block" id="f_bypb">--</button></div>' +
      '<p class="zh-hint">Le bassin d’orage se vide automatiquement vers l’entrée quand le débit redescend.</p></div>' +

      '<div class="zh-fp" id="fp_ext"><div class="zh-fp-h"><span class="zh-fp-tag">XV-302</span><span class="zh-fp-title">Extraction des boues en excès</span></div>' +
      '<div class="zh-fp-row"><span class="zh-lbl">Débit d’extraction</span><span class="zh-v zh-sp" id="f_qw">--</span></div>' +
      '<input type="range" id="f_qwr" min="0" max="20" step="1" aria-label="Débit d’extraction">' +
      '<div class="zh-fp-row"><span class="zh-lbl">MES bassin · MES recirculées</span><span class="zh-v" id="f_x">--</span></div>' +
      '<div class="zh-fp-btns"><button type="button" class="zh-btn zh-btn--block" id="f_extb">--</button></div></div>' +

      '<div class="zh-fp" id="fp_probe"><div class="zh-fp-h"><span class="zh-fp-tag">AT-101</span><span class="zh-fp-title">Sonde O₂ du bassin</span></div>' +
      '<div class="zh-fp-row"><span class="zh-lbl">État</span><span class="zh-state" id="f_prst">EN SERVICE</span></div>' +
      '<div class="zh-fp-btns"><button type="button" class="zh-btn" id="f_chk">Mesure de contrôle (sonde portable)</button>' +
      '<button type="button" class="zh-btn" id="f_cln">Nettoyer et étalonner (10 min)</button></div>' +
      '<p class="zh-hint" id="f_chkres">Contrôle croisé : comparez la sonde fixe à une mesure portable.</p></div>' +
      '<p class="zh-hint eau-legal">Valeurs : repères pédagogiques (station type 30 000 EH), pas des données de site.</p>';

    p.addEventListener('click', function (e) {
      var b = e.target.closest('button'); if (!b || replaying) return;
      var a = b.getAttribute('data-a');
      if (a === 'sp+' || a === 'sp-') {
        var v = Math.round((model.pid.sp + (a === 'sp+' ? 0.1 : -0.1)) * 10) / 10; v = U.clamp(v, 0.5, 4);
        if (v !== model.pid.sp) { var up = v > model.pid.sp; model.pid.sp = v; act(up ? 'pid_sp' : 'pid_spdown', 'Consigne O₂ → ' + v.toFixed(1) + ' mg/L', true); }
      } else if (a === 'auto' && model.pid.mode !== 'AUTO') { model.pid.setMode('AUTO'); act('pid_auto', 'Régulation O₂ en AUTO'); }
      else if (a === 'man' && model.pid.mode !== 'MAN') { model.pid.setMode('MAN'); act('pid_man', 'Régulation O₂ en MAN (sortie ' + Math.round(model.pid.out) + ' %)'); }
      var bl = b.getAttribute('data-bl');
      if (bl) {
        var B = model.bl.filter(function (x) { return x.id === bl; })[0];
        if (B.state === 'fault') { Z.toast(bl + ' en défaut : intervention de la maintenance nécessaire.', 'alarm'); return; }
        var cmd = B.state === 'stop' ? 'start' : 'stop';
        if (model.blower(bl, cmd)) act(cmd === 'start' ? 'blower_start' : 'blower_stop', (cmd === 'start' ? 'Démarrage surpresseur ' : 'Arrêt surpresseur ') + bl);
      }
      var pp = b.getAttribute('data-pp');
      if (pp) {
        var Pm = model.pumps.filter(function (x) { return x.id === pp; })[0], c2 = Pm.state === 'stop' ? 'start' : 'stop';
        if (model.pump(pp, c2)) act(c2 === 'start' ? 'pump_start' : 'pump_stop', (c2 === 'start' ? 'Démarrage pompe ' : 'Arrêt pompe ') + pp);
      }
      if (b.id === 'f_bypb') { model.byp.on = !model.byp.on; act(model.byp.on ? 'bypass_on' : 'bypass_off', model.byp.on ? 'Ouverture du by-pass vers le bassin d’orage' : 'Fermeture du by-pass'); }
      if (b.id === 'f_extb') { model.ext.on = !model.ext.on; act(model.ext.on ? 'ext_on' : 'ext_off', model.ext.on ? 'Extraction des boues remise en marche' : 'Extraction des boues arrêtée'); }
      if (b.id === 'f_chk') {
        var v2 = model.SO + 0.05 * noise();
        $('#f_chkres').innerHTML = 'Sonde portable à ' + hhmm(model.t) + ' : <b class="zh-mono">' + v2.toFixed(2) + ' mg/L</b> · sonde fixe : <b class="zh-mono">' + U.fmt(model.m.o2, 2) + ' mg/L</b>';
        act('probe_check', 'Mesure de contrôle O₂ : portable ' + v2.toFixed(2) + ' / fixe ' + U.fmt(model.m.o2, 2) + ' mg/L');
      }
      if (b.id === 'f_cln') { if (model.probeClean()) act('probe_clean', 'Nettoyage et étalonnage de la sonde AT-101'); }
      renderPanel(view(), true);
    });
    var sliders = { f_o2man: 'pid_out', f_qrr: 'qr', f_limr: 'bypass_lim', f_qwr: 'ext_q' };
    Object.keys(sliders).forEach(function (id) {
      var el = document.getElementById(id);
      el.addEventListener('input', function () {
        var v = +el.value;
        if (id === 'f_o2man') model.pid.out = v;
        if (id === 'f_qrr') model.rec.sp = v;
        if (id === 'f_limr') model.byp.lim = v;
        if (id === 'f_qwr') model.ext.q = v;
        renderPanel(view(), true);
      });
      el.addEventListener('change', function () {
        var v = +el.value, lbl = {
          pid_out: 'Sortie manuelle O₂ → ' + v + ' %', qr: 'Consigne recirculation → ' + v + ' m³/h',
          bypass_lim: 'Débit max admis en biologie → ' + v + ' m³/h', ext_q: 'Débit d’extraction → ' + v + ' m³/h'
        }[sliders[id]];
        act(sliders[id], lbl, true);
      });
    });
  }

  var lastAct = {};
  /** Journalise une action opérateur (fusion des réglages successifs d'un même paramètre). */
  function act(key, label, merge) {
    var t = clock.t, ev;
    if (merge && lastAct[key] && t - lastAct[key].t < 120) { ev = lastAct[key]; ev.label = label; }
    else { ev = rec.event('action', label, { key: key }); }
    lastAct[key] = ev;
    trends.o2 && Object.keys(trends).forEach(function (k) { trends[k].mark(ev.t, label, 'action'); });
  }

  /* ----------------------------------------------------------------- vue */
  function view() {
    var st = {};
    alarms.order.forEach(function (id) { st[id] = alarms.state[id].st; });
    return {
      t: model.t, m: Object.assign({}, model.m),
      bl: model.bl.map(function (b) { return { id: b.id, state: b.state, air: b.air }; }),
      pumps: model.pumps.map(function (p) { return { id: p.id, state: p.state, q: p.q }; }),
      byp: { on: model.byp.on, lim: model.byp.lim }, ext: { on: model.ext.on, q: model.ext.q },
      pid: { out: model.pid.out, mode: model.pid.mode, sp: model.pid.sp }, qrsp: model.rec.sp,
      maint: model.probe.maint, alm: st
    };
  }
  function hhmm(t) {
    var mins = Math.floor(P.startHour * 60 + t / 60), hh = Math.floor(mins / 60) % 24, mm = mins % 60;
    return (hh < 10 ? '0' : '') + hh + ':' + (mm < 10 ? '0' : '') + mm;
  }
  function setVB(id, txt) { var r = R.vb[id]; if (r && r.last !== txt) { r.v.textContent = txt; r.last = txt; } }
  function setTxt(sel, txt) { var e = typeof sel === 'string' ? document.getElementById(sel) : sel; if (e && e._t !== txt) { e.textContent = txt; e._t = txt; } }
  function setHTML(id, h) { var e = document.getElementById(id); if (e && e._h !== h) { e.innerHTML = h; e._h = h; } }
  function fmtI(v) { return isNaN(v) ? '---' : Math.round(v).toLocaleString('fr-FR'); }
  function setFlow(id, q, qref) {
    var r = R.fo[id]; if (!r) return;
    var key = q <= 0.5 ? 'off' : q / qref > 1.6 ? 'f' : q / qref > 0.6 ? 'm' : 's';
    if (key === r.last) return; r.last = key;
    r.el.style.display = key === 'off' ? 'none' : '';
    r.el.style.animationDuration = { f: '0.45s', m: '0.9s', s: '1.8s' }[key] || '1s';
  }
  var BL_TXT = { run: 'MARCHE', stop: 'ARRÊT', start: 'DÉMARRAGE', fault: 'DÉFAUT' };
  var PP_TXT = { run: 'MARCHE', stop: 'ARRÊT', start: 'DÉMARRAGE' };

  function renderView(v, rdt) {
    var m = v.m;
    // horloge station
    setHTML('clk', '<small>Heure station</small>' + hhmm(v.t) + ' <span class="eau-elapsed" title="Temps écoulé depuis la prise de poste">+' + U.fmtTime(v.t) + '</span>');
    // valeurs
    setVB('vb_qin', fmtI(m.qin));
    setVB('vb_in', Math.round(m.sin) + ' / ' + Math.round(m.nhin));
    setVB('vb_st', U.fmt(m.st, 0));
    setVB('vb_o2', v.maint > 0 ? 'MAINT.' : U.fmt(m.o2, 2));
    setTxt('o2sp', 'SP ' + v.pid.sp.toFixed(1));
    setVB('vb_x', U.fmt(m.x, 2));
    setVB('vb_air', fmtI(m.air));
    setVB('vb_voile', U.fmt(m.voile, 2));
    setVB('vb_mes', U.fmt(m.mes, 1));
    setVB('vb_nh', U.fmt(m.nh, 1));
    setVB('vb_dbo', U.fmt(m.dbo, 1));
    setVB('vb_vasc', U.fmt(m.vasc, 2));
    setVB('vb_qr', fmtI(m.qr));
    setTxt('qrsp', 'SP ' + Math.round(v.qrsp));
    setVB('vb_qw', U.fmt(m.qw, 0));
    setTxt('pidOut', Math.round(v.pid.out) + ' %');
    setTxt('pidMode', v.maint > 0 ? 'MAINTIEN' : v.pid.mode);
    // écoulements
    setFlow('fl_in', m.qin, 250); setFlow('fl_byp', m.qst, 200); setFlow('fl_ret', m.qret, 100); setFlow('fl_ovf', m.qovf, 100);
    setFlow('fl_mix', m.qbio + m.qr, 450); setFlow('fl_eff', m.qe, 250); setFlow('fl_air', m.air, 3000);
    setFlow('fl_und', m.qr + m.qw, 200); setFlow('fl_ext', m.qw, 7);
    var p1 = v.pumps[0], p2 = v.pumps[1];
    setFlow('fl_rec', m.qr, 200); setFlow('fl_rec2', p2.q, 200);
    document.getElementById('fl_ovf').classList.toggle('eau-bad', m.qovf > 0);
    $('#ovfTxt').classList.toggle('eau-badtxt', m.qovf > 0);
    // vannes
    $('#xv001').classList.toggle('eau-open', v.byp.on); setTxt('xv001t', v.byp.on ? 'ouverte · ' + v.byp.lim + ' m³/h max' : 'fermée');
    $('#xv302').classList.toggle('eau-open', v.ext.on && v.ext.q > 0);
    // bassin d'orage
    var lv = U.clamp(m.st / 100, 0, 1) * 126; var sl = $('#stLvl'); sl.setAttribute('y', (428 - lv).toFixed(1)); sl.setAttribute('height', lv.toFixed(1));
    // pluie
    var rain = $('#rain'); rain.style.display = m.qrain > 5 ? '' : 'none';
    if (m.qrain > 5) {
      setTxt('rainTxt', 'Pluie : +' + Math.round(m.qrain) + ' m³/h');
      var tt = performance.now() / 1000;
      R.rain.forEach(function (l, i) { var y = ((tt * 60 + i * 13) % 50); l.setAttribute('y1', y.toFixed(1)); l.setAttribute('y2', (y + 9).toFixed(1)); });
    }
    // surpresseurs
    v.bl.forEach(function (b) {
      var r = R.blowers[b.id];
      if (r.last !== b.state) {
        r.last = b.state; r.g.classList.toggle('eau-on', b.state === 'run'); r.g.classList.toggle('eau-fault', b.state === 'fault');
        r.g.classList.toggle('eau-starting', b.state === 'start'); r.st.textContent = BL_TXT[b.state];
      }
      setTxt(r.air, b.state === 'run' ? fmtI(b.air) + ' Nm³/h' : '');
      if (b.state === 'run') {
        r.a = (r.a + rdt * (180 + b.air / 4)) % 360;
        r.fan.setAttribute('transform', 'rotate(' + r.a.toFixed(1) + ' ' + r.fan.getAttribute('data-cx') + ' ' + r.fan.getAttribute('data-cy') + ')');
      }
    });
    // pompes
    v.pumps.forEach(function (p) {
      var g = R.pumps[p.id]; g.classList.toggle('eau-on', p.state === 'run'); g.classList.toggle('eau-starting', p.state === 'start');
    });
    // bulles d'aération (nombre et vitesse selon le débit d'air)
    var nAct = Math.round(R.bub.length * U.clamp(m.air / 5200, 0, 1)), sp = 40 + m.air / 60;
    R.bub.forEach(function (b, i) {
      if (i >= nAct) { if (b.vis !== false) { b.el.setAttribute('cy', '-20'); b.vis = false; } return; }
      if (b.vis === false || b.y < 112) { b.y = 404 + Math.random() * 8; b.x = 290 + Math.random() * 340; b.vis = true; }
      b.y -= rdt * sp * b.v; b.ph += rdt * 3;
      b.el.setAttribute('cx', (b.x + Math.sin(b.ph) * 2).toFixed(1)); b.el.setAttribute('cy', b.y.toFixed(1));
    });
    // voile de boues (y = 396 - 69 px/m)
    var yb = 396 - U.clamp(m.heff, 0, 4) * 69.5, tw = performance.now() / 700, top = 'M760 ' + yb.toFixed(1);
    for (var x = 760; x <= 1060; x += 20) top += ' L' + x + ' ' + (yb + Math.sin(tw + x / 23) * 1.6).toFixed(1);
    $('#blanket').setAttribute('d', top + ' L1060 400 L760 400 Z');
    $('#blTop').setAttribute('d', top);
    var ym = 396 - U.clamp(m.voile, 0, 4) * 69.5;
    $('#blMark').setAttribute('d', 'M768 ' + ym.toFixed(1) + ' l-8 -5 v10 z');
    // départ de boues : particules au-dessus du voile
    var nCar = Math.round(R.car.length * U.clamp((m.mes - 15) / 80, 0, 1));
    R.car.forEach(function (c, i) {
      if (i >= nCar) { c.el.setAttribute('cy', '-20'); c.y = yb; return; }
      c.y -= rdt * 30 * c.v; if (c.y < 122 || c.y > yb) { c.y = yb - Math.random() * 10; c.x = 770 + Math.random() * 280; }
      c.el.setAttribute('cx', c.x.toFixed(1)); c.el.setAttribute('cy', c.y.toFixed(1));
    });
    // KPI mobiles
    setTxt('k_o2v', v.maint > 0 ? 'MAINT.' : U.fmt(m.o2, 2)); setTxt('k_nhv', U.fmt(m.nh, 1)); setTxt('k_mesv', U.fmt(m.mes, 1));
    setTxt('k_voilev', U.fmt(m.voile, 2)); setTxt('k_qinv', fmtI(m.qin)); setTxt('k_qrv', fmtI(m.qr));
    setTxt('k_airv', fmtI(m.air)); setTxt('k_stv', U.fmt(m.st, 0));
    renderPanel(v);
  }

  var lastPanel = 0;
  function renderPanel(v, force) {
    var now = performance.now(); if (!force && now - lastPanel < 150) return; lastPanel = now;
    var m = v.m, ae = document.activeElement;
    setTxt('f_o2pv', v.maint > 0 ? 'MAINTENANCE' : U.fmt(m.o2, 2) + ' mg/L');
    $('#f_o2bar').style.width = (U.clamp((m.o2 || 0) / 5, 0, 1) * 100) + '%';
    $('#f_o2spm').style.left = (v.pid.sp / 5 * 100) + '%';
    setTxt('f_o2sp', v.pid.sp.toFixed(1) + ' mg/L');
    setTxt('f_o2out', Math.round(v.pid.out) + ' %');
    var modeBtns = document.querySelectorAll('#fp_o2 .zh-mode button');
    modeBtns[0].setAttribute('aria-pressed', String(v.pid.mode === 'AUTO')); modeBtns[1].setAttribute('aria-pressed', String(v.pid.mode === 'MAN'));
    var man = $('#f_o2man'); man.disabled = v.pid.mode !== 'MAN' || replaying; if (ae !== man) man.value = Math.round(v.pid.out);
    setTxt('f_o2hint', v.maint > 0 ? 'Sonde en maintenance : la sortie est maintenue à sa dernière valeur.' : v.pid.mode === 'MAN' ? 'MAN : vous réglez vous-même la vitesse des surpresseurs.' : 'AUTO : la régulation ajuste la vitesse des surpresseurs.');
    v.bl.forEach(function (b) {
      var st = $('#f_' + b.id + 'st'); setTxt(st, BL_TXT[b.state]);
      st.className = 'zh-state' + (b.state === 'fault' ? ' zh-state--fault' : b.state === 'run' ? ' zh-state--on' : b.state === 'start' ? ' zh-state--warn' : '');
      setTxt('f_' + b.id + 'air', b.state === 'run' ? fmtI(b.air) + ' Nm³/h' : '—');
      var btn = document.querySelector('[data-bl=' + b.id + ']');
      setTxt(btn, b.state === 'stop' ? 'Démarrer' : b.state === 'fault' ? 'Défaut' : 'Arrêter'); btn.disabled = b.state === 'fault' || replaying;
    });
    setTxt('f_airt', fmtI(m.air) + ' Nm³/h');
    setTxt('f_qr', fmtI(m.qr) + ' m³/h'); setTxt('f_qrsp', Math.round(v.qrsp) + ' m³/h');
    var qrr = $('#f_qrr'); if (ae !== qrr) qrr.value = v.qrsp;
    setTxt('f_qrratio', Math.round(100 * m.qr / Math.max(1, m.qbio)) + ' %');
    v.pumps.forEach(function (p) {
      var st = $('#f_' + p.id + 'st'); setTxt(st, PP_TXT[p.state]);
      st.className = 'zh-state' + (p.state === 'run' ? ' zh-state--on' : p.state === 'start' ? ' zh-state--warn' : '');
      setTxt('f_' + p.id + 'q', p.state === 'run' ? fmtI(p.q) + ' m³/h' : '—');
      var btn = document.querySelector('[data-pp=' + p.id + ']'); setTxt(btn, p.state === 'stop' ? 'Démarrer' : 'Arrêter'); btn.disabled = replaying;
    });
    setTxt('f_voile', U.fmt(m.voile, 2) + ' m');
    setTxt('f_qin', fmtI(m.qin) + ' m³/h'); setTxt('f_lim', v.byp.lim + ' m³/h');
    var lr = $('#f_limr'); if (ae !== lr) lr.value = v.byp.lim;
    setTxt('f_st', U.fmt(m.st, 0) + ' %' + (m.qret > 1 ? ' · restitution ' + Math.round(m.qret) + ' m³/h' : m.qst > 1 ? ' · remplissage ' + Math.round(m.qst) + ' m³/h' : ''));
    var bb = $('#f_bypb'); setTxt(bb, v.byp.on ? 'Fermer le by-pass' : 'Ouvrir le by-pass vers le bassin d’orage'); bb.setAttribute('aria-pressed', String(v.byp.on));
    setTxt('f_qw', v.ext.q + ' m³/h'); var qw = $('#f_qwr'); if (ae !== qw) qw.value = v.ext.q;
    setTxt('f_x', U.fmt(m.x, 2) + ' · ' + U.fmt(m.xr, 1) + ' g/L');
    var eb = $('#f_extb'); setTxt(eb, v.ext.on ? 'Arrêter l’extraction' : 'Remettre l’extraction en marche'); eb.setAttribute('aria-pressed', String(v.ext.on));
    var ps = $('#f_prst'); setTxt(ps, v.maint > 0 ? 'MAINTENANCE ' + Math.ceil(v.maint / 60) + ' min' : 'EN SERVICE');
    ps.className = 'zh-state' + (v.maint > 0 ? ' zh-state--warn' : '');
    $('#f_cln').disabled = v.maint > 0 || replaying; $('#f_chk').disabled = replaying;
    Array.prototype.forEach.call(document.querySelectorAll('#zh-panel input, #zh-panel button[data-a]'), function (e) { if (replaying) e.disabled = true; else if (e.id !== 'f_o2man') e.disabled = false; });
    // pastille d'alarme sur le bouton du tiroir
    $('#drawerBtn').classList.toggle('zh-has-alarm', alarms.unackCount() > 0);
  }

  /* ------------------------------------------------------------- alarmes */
  function defineAlarms() {
    var A = [
      ['AT101_LL', 'AT-101', 'Oxygène dissous très bas', 1, ['#vb_o2', '#k_o2']],
      ['AT101_L', 'AT-101', 'Oxygène dissous bas', 2, ['#vb_o2', '#k_o2']],
      ['AT101_H', 'AT-101', 'Oxygène dissous haut : air en excès', 3, ['#vb_o2', '#k_o2']],
      ['AT102_HH', 'AT-102', 'NH₄ de sortie au-delà de la norme', 1, ['#vb_nh', '#k_nh']],
      ['AT102_H', 'AT-102', 'NH₄ de sortie haut', 2, ['#vb_nh', '#k_nh']],
      ['AT401_HH', 'AT-401', 'MES de sortie au-delà de la norme', 1, ['#vb_mes', '#k_mes']],
      ['AT401_H', 'AT-401', 'MES de sortie hautes', 2, ['#vb_mes', '#k_mes']],
      ['LT301_HH', 'LT-301', 'Voile de boues très haut : départ de boues', 1, ['#vb_voile', '#k_voile', '#g_clar']],
      ['LT301_H', 'LT-301', 'Voile de boues haut', 2, ['#vb_voile', '#k_voile', '#g_clar']],
      ['FT001_H', 'FT-001', 'Débit d’entrée élevé (temps de pluie)', 3, ['#vb_qin', '#k_qin']],
      ['FT301_L', 'FT-301', 'Débit de recirculation bas', 2, ['#vb_qr', '#k_qr']],
      ['FT201_L', 'FT-201', 'Débit d’air bas', 3, ['#vb_air', '#k_air']],
      ['S1_DEF', 'S1', 'Surpresseur S1 en défaut (déclenchement thermique)', 1, ['#bl_S1']],
      ['S2_DEF', 'S2', 'Surpresseur S2 en défaut (déclenchement thermique)', 1, ['#bl_S2']],
      ['LT501_H', 'LT-501', 'Bassin d’orage plein à 80 %', 2, ['#vb_st', '#k_st']],
      ['LT501_HH', 'LT-501', 'Bassin d’orage plein : déversement au milieu', 1, ['#vb_st', '#k_st']]
    ];
    A.forEach(function (a) { alarms.define(a[0], { tag: a[1], label: a[2], priority: a[3], targets: a[4] }); });
  }
  function pair(hhId, hId, v, hh, hi, db, txt) {
    alarms.limit(hhId, v, hh, 'H', db, txt);
    if (alarms.isActive(hhId)) alarms.set(hId, false); else alarms.limit(hId, v, hi, 'H', db, txt);
  }
  function evalAlarms() {
    var m = model.m, o2 = model.probe.maint > 0 ? NaN : m.o2;
    if (!isNaN(o2)) {
      alarms.limit('AT101_LL', o2, 0.5, 'L', 0.1, U.fmt(o2, 2) + ' mg/L');
      if (alarms.isActive('AT101_LL')) alarms.set('AT101_L', false); else alarms.limit('AT101_L', o2, 1.0, 'L', 0.15, U.fmt(o2, 2) + ' mg/L');
      alarms.limit('AT101_H', o2, 4.0, 'H', 0.3, U.fmt(o2, 2) + ' mg/L');
    }
    pair('AT102_HH', 'AT102_H', m.nh, 10, 8, 0.3, U.fmt(m.nh, 1) + ' mg/L');
    pair('AT401_HH', 'AT401_H', m.mes, 35, 25, 2, U.fmt(m.mes, 0) + ' mg/L');
    pair('LT301_HH', 'LT301_H', m.voile, 2.6, 2.0, 0.1, U.fmt(m.voile, 2) + ' m');
    alarms.limit('FT001_H', m.qin, 450, 'H', 30, fmtI(m.qin) + ' m³/h');
    alarms.set('FT301_L', model.rec.sp > 60 && m.qr < 0.5 * model.rec.sp, fmtI(m.qr) + ' m³/h');
    alarms.limit('FT201_L', m.air, 1800, 'L', 100, fmtI(m.air) + ' Nm³/h');
    alarms.set('S1_DEF', model.bl[0].state === 'fault'); alarms.set('S2_DEF', model.bl[1].state === 'fault');
    alarms.set('LT501_HH', m.qovf > 0 || (alarms.isActive('LT501_HH') && m.st > 99));
    if (alarms.isActive('LT501_HH')) alarms.set('LT501_H', false); else alarms.limit('LT501_H', m.st, 80, 'H', 3, U.fmt(m.st, 0) + ' %');
  }

  /* ------------------------------------------------------------ boucle */
  function step(dt, t) {
    if (incident && !incident.done && t >= incident.t) {
      incident.done = true; model.inject(incident.kind);
      rec.event('incident', 'Incident : ' + KIND_LABEL[incident.kind], { kind: incident.kind });
    }
    model.step(dt);
    evalAlarms();
    var m = model.m, smp = {
      o2: model.probe.maint > 0 ? null : m.o2, o2r: m.o2r, sp: model.pid.sp, air: m.air, nh: m.nh, mes: m.mes,
      voile: m.voile, qin: m.qin, qbio: m.qbio, qr: m.qr, st: m.st
    };
    rec.tick(t, smp, view);
    if (Math.floor(t / 60) !== Math.floor((t - dt) / 60) || t === 0) Object.keys(trends).forEach(function (k) { trends[k].push(t, smp); });
    if (t + dt >= P.duration) { setTimeout(endGame, 0); clock.stop(); }
  }
  function render() {
    var now = performance.now(), rdt = lastRender ? Math.min(0.1, (now - lastRender) / 1000) : 0; lastRender = now;
    renderView(view(), rdt);
    alarms.render();
    Object.keys(trends).forEach(function (k) { trends[k].draw(); });
  }

  /* ------------------------------------------------------- scénarios */
  function startScenario(id) {
    ZHSim.closeOverlays();
    scen = id; replaying = false; document.body.classList.remove('eau-replay');
    var kind = SCN[id].kind || (Math.random() < 0.5 ? 'sonde' : 'recirc');
    // incident injecté à un instant aléatoire entre 1 h et 2 h 30 de procédé
    incident = { kind: kind, t: Math.round((3600 + Math.random() * 5400) / P.dt) * P.dt, done: false };
    clock.reset(); rec.reset(); alarms.reset(); lastAct = {};
    model = new EauModel({ pid: new Z.PID({ kp: P.Kp, ti: P.Ti, sp: 2, bias: 60 }) });
    Object.keys(trends).forEach(function (k) { trends[k].clear(); });
    trainer.setFaults(trainerFaults());
    setHTML('scnName', SCN[id].title);
    $('#f_chkres').textContent = 'Contrôle croisé : comparez la sonde fixe à une mesure portable.';
    clock.setSpeed(SPEEDS[2]);
    clock.start();
    Z.toast('Prise de poste à 06:00. Bonne surveillance !', 'info', 2600);
  }
  function trainerFaults() {
    return ['orage', 'blower', 'sonde', 'recirc', 'nh4'].map(function (k) {
      return { id: k, label: KIND_LABEL[k], inject: function () { model.inject(k); } };
    });
  }

  function endGame() {
    if (replaying || !model) return;
    clock.stop();
    var st = model.st, kind = incident.kind;
    var tInj = incident.done ? incident.t : null;
    var evs = rec.events;
    var firstAl = null, firstAct = null;
    evs.forEach(function (e) {
      if (tInj === null || e.t < tInj) return;
      if (!firstAl && (e.type === 'alarm' || e.type === 'alarm2')) firstAl = e;
      if (!firstAct && e.type === 'action' && RELEVANT[kind].indexOf(e.key) >= 0) firstAct = e;
    });
    // --- sécurité du milieu / ouvrage (50)
    var penBoue = U.clamp((st.heffMax - 2.0) / 1.0, 0, 1);
    var penNC = U.clamp(st.tNC / (4 * 3600), 0, 1);
    var penOvf = U.clamp(st.ovf / 1500, 0, 1);
    var sec = U.clamp(1 - (0.5 * penBoue + 0.4 * penNC + 0.3 * penOvf), 0, 1);
    // --- qualité du rejet (30)
    var fConf = 1 - st.tNC / Math.max(1, st.t), fO2 = st.tO2 / Math.max(1, st.t);
    var prod = U.clamp((22 * fConf + 8 * fO2) / 30, 0, 1);
    // --- réactivité (20)
    var react = 0, reactTxt;
    if (firstAct && (!firstAl || firstAct.t <= firstAl.t)) { react = 1; reactTxt = 'Action utile avant la première alarme : anticipation.'; }
    else if (firstAct && firstAl) {
      var dtr = firstAct.t - firstAl.t; react = U.clamp(1 - (dtr - 600) / (7200 - 600), 0, 1);
      reactTxt = 'Première action utile ' + Math.round(dtr / 60) + ' min (procédé) après la première alarme.';
    } else reactTxt = firstAl ? 'Aucune action utile après la première alarme.' : 'Aucune alarme et aucune action utile.';
    var reactVal = firstAct && firstAl ? Math.max(0, Math.round((firstAct.t - firstAl.t) / 60)) + ' min' : firstAct ? 'anticipée' : '—';

    var bad = st.heffMax > 2.6 || st.mesMax > P.normMES ? 'Départ de boues : MES hors norme au rejet'
      : st.nhMax > P.normNH4 ? 'Nitrification dégradée : NH₄ hors norme au rejet'
        : st.ovf > 1 ? 'Déversement d’eaux non traitées au milieu' : null;
    var outcome = bad ? { label: bad, bad: true } : { label: 'Rejet conforme : incident maîtrisé', bad: false };
    outcome.text = 'Incident ' + (scen === 'mystere' ? 'tiré au sort' : 'du scénario') + ' : <b>' + KIND_LABEL[kind] + '</b>' +
      (tInj !== null ? ', survenu à ' + hhmm(tInj) + ' (+' + U.fmtTime(tInj) + ' dans la chronologie).' : '.') + ' Temps hors norme : ' + Math.round(st.tNC / 60) + ' min sur ' + Math.round(st.t / 3600) + ' h de poste.';

    var D = DEBRIEF[kind];
    debriefArgs = {
      kicker: 'Débriefing · Station d’épuration', title: SCN[scen].title + (scen === 'mystere' ? ' · ' + KIND_LABEL[kind] : ''),
      outcome: outcome,
      scores: { securite: sec, production: prod, reactivite: react },
      productionLabel: 'Qualité du rejet',
      details: {
        securite: 'Voile max. ' + U.fmt(st.heffMax, 2) + ' m (alerte 2,6 m) · ' + Math.round(st.tNC / 60) + ' min hors norme · ' + fmtI(st.ovf) + ' m³ déversés.',
        production: Math.round(100 * fConf) + ' % du poste conforme · O₂ dans la plage 1,2-3,5 mg/L ' + Math.round(100 * fO2) + ' % du temps.',
        reactivite: reactTxt
      },
      stats: [
        { label: '1re alarme', value: firstAl ? hhmm(firstAl.t) : '—' },
        { label: 'Temps de réaction', value: reactVal },
        { label: 'Voile maximal', value: U.fmt(st.heffMax, 2) + ' m' },
        { label: 'MES max. au rejet', value: U.fmt(st.mesMax, 0) + ' mg/L' },
        { label: 'NH₄ max. au rejet', value: U.fmt(st.nhMax, 1) + ' mg/L' },
        { label: 'O₂ réel minimal', value: U.fmt(st.o2Min, 2) + ' mg/L' },
        { label: 'Déversé non traité', value: fmtI(st.ovf) + ' m³' },
        { label: 'Bassin d’orage max.', value: fmtI(st.Vmax) + ' m³' }
      ],
      chart: D.chart, recorder: rec, keyPoints: D.points, sequence: D.seq,
      extraHTML: '<p class="zh-note">Temps exprimés en heures de procédé depuis la prise de poste de 06:00. Normes et seuils : repères pédagogiques.</p>',
      onReplay: startReplay, onRetry: function () { startScenario(scen); }, onOther: showBriefing,
      mailBody: 'Bonjour,\n\nJ’ai joué la démo « Station d’épuration » (scénario « ' + SCN[scen].title + ' », score {score}/100). J’aimerais échanger sur la formation de nos exploitants.\n\nEntreprise et site :\nNombre d’opérateurs concernés :\nTéléphone :\n'
    };
    Z.debrief(debriefArgs);
  }

  var DEBRIEF = {
    orage: {
      chart: {
        series: [{ key: 'mes', label: 'MES de sortie (mg/L)', color: '#1d2329', width: 2 }, { key: 'qin', label: 'Débit d’entrée (÷10, m³/h)', color: '#8a9096', width: 1.5, scale: 0.1 },
          { key: 'voile', label: 'Voile de boues (m, axe droit)', color: '#2f6fdf', width: 2, axis: 'y2' }],
        y: { min: 0, max: 120, unit: 'mg/L' }, y2: { min: 0, max: 4, unit: 'm' },
        limits: [{ value: 35, color: '#d0021b', label: 'norme MES 35' }, { value: 2.6, color: '#f5a623', label: 'voile 2,6 m', axis: 'y2' }]
      },
      points: [
        'C’est la <b>charge hydraulique</b> qui fait partir les boues : au-delà de ~0,6 m/h de vitesse ascensionnelle, le voile gonfle et monte vers les goulottes.',
        'Le <b>bassin d’orage</b> protège la biologie : on stocke l’excédent pendant la pointe et on le restitue ensuite. On traite tout, mais plus tard.',
        'Pendant l’orage, on <b>suspend l’extraction</b> et on <b>adapte la recirculation</b> pour garder la masse de boues dans le bassin d’aération.'],
      seq: ['Repérer la montée du débit FT-001 et l’information « temps de pluie ».', 'Ouvrir le by-pass XV-001 vers le bassin d’orage (≈ 1,6 × Qm en biologie).',
        'Arrêter l’extraction des boues pendant l’épisode.', 'Monter la recirculation vers 100 % du débit traité.', 'Surveiller voile LT-301 et MES de sortie ; laisser le bassin d’orage se vider après l’épisode.']
    },
    blower: {
      chart: {
        series: [{ key: 'nh', label: 'NH₄ de sortie (mg/L)', color: '#1d2329', width: 2 }, { key: 'o2r', label: 'O₂ réel (mg/L, axe droit)', color: '#8a9096', width: 2, axis: 'y2' },
          { key: 'sp', label: 'Consigne O₂', color: '#2f6fdf', dash: [6, 4], width: 1.5, axis: 'y2' }],
        y: { min: 0, max: 25, unit: 'mg/L' }, y2: { min: 0, max: 5, unit: 'O₂' },
        limits: [{ value: 10, color: '#d0021b', label: 'norme NH₄ 10' }]
      },
      points: [
        'Un défaut de surpresseur se traite <b>tout de suite</b> : l’O₂ chute en quelques minutes, la régulation sature à 100 % et ne peut plus rien.',
        'La <b>nitrification</b> est la première victime du manque d’oxygène : le NH₄ monte lentement et met des heures à redescendre.',
        'Le <b>secours</b> est là pour ça : le démarrer, vérifier la reprise de l’O₂, puis prévenir la maintenance.'],
      seq: ['Lire et acquitter l’alarme de défaut S1 / S2.', 'Constater la sortie AIC-101 à 100 % et l’O₂ qui chute.', 'Démarrer le surpresseur de secours S3.',
        'Vérifier le retour de l’O₂ à la consigne et la sortie de la régulation.', 'Suivre le NH₄ de sortie et consigner l’événement (maintenance).']
    },
    sonde: {
      chart: {
        series: [{ key: 'nh', label: 'NH₄ de sortie (mg/L)', color: '#1d2329', width: 2 }, { key: 'o2', label: 'O₂ mesuré AT-101 (axe droit)', color: '#2f6fdf', width: 2, axis: 'y2' },
          { key: 'o2r', label: 'O₂ réel (axe droit)', color: '#8a9096', width: 2, dash: [5, 3], axis: 'y2' }],
        y: { min: 0, max: 25, unit: 'mg/L' }, y2: { min: 0, max: 5, unit: 'O₂' },
        limits: [{ value: 10, color: '#d0021b', label: 'norme NH₄ 10' }]
      },
      points: [
        'Une mesure <b>stable et parfaite</b> peut mentir : la sonde encrassée affichait la consigne pendant que le bassin manquait d’oxygène.',
        'Une régulation ne vaut que ce que vaut son capteur : ici elle a <b>réduit l’air</b> en croyant bien faire. Le débit d’air bas était l’indice.',
        'Réflexe d’exploitant : <b>croiser les mesures</b> (air, NH₄, O₂) et contrôler avec une sonde portable avant de nettoyer et d’étalonner.'],
      seq: ['Remarquer l’incohérence : O₂ à la consigne, débit d’air en baisse, NH₄ en hausse.', 'Faire une mesure de contrôle avec la sonde portable.',
        'Passer la régulation en MAN (ou monter la sortie) pour réaérer pendant le diagnostic.', 'Nettoyer et étalonner la sonde AT-101, puis repasser en AUTO.', 'Suivre le retour du NH₄ sous la norme.']
    },
    recirc: {
      chart: {
        series: [{ key: 'mes', label: 'MES de sortie (mg/L)', color: '#1d2329', width: 2 }, { key: 'qr', label: 'Recirculation (÷10, m³/h)', color: '#8a9096', width: 1.5 },
          { key: 'voile', label: 'Voile de boues (m, axe droit)', color: '#2f6fdf', width: 2, axis: 'y2' }],
        y: { min: 0, max: 120, unit: 'mg/L' }, y2: { min: 0, max: 4, unit: 'm' },
        limits: [{ value: 35, color: '#d0021b', label: 'norme MES 35' }, { value: 2.6, color: '#f5a623', label: 'voile 2,6 m', axis: 'y2' }]
      },
      points: [
        'Sans recirculation, les boues <b>s’accumulent dans le clarificateur</b> : le voile monte jusqu’aux goulottes.',
        'Un moteur en marche ne garantit pas le débit : la pompe désamorcée tournait toujours. C’est le <b>débitmètre FT-301</b> qui dit la vérité.',
        '<b>Basculer sur la pompe de secours</b> rétablit le soutirage ; il faut ensuite vérifier la redescente du voile.'],
      seq: ['Lire l’alarme « recirculation bas » malgré la pompe en marche.', 'Démarrer la pompe de secours P-302 (et arrêter P-301).',
        'Contrôler le débit FT-301 et le voile LT-301.', 'Arrêter l’extraction tant que le voile est haut.', 'Faire intervenir la maintenance sur P-301.']
    }
  };
  DEBRIEF.nh4 = DEBRIEF.blower;

  // séries « ÷10 » : le noyau ne connaît pas d'échelle, on ajoute des clés dérivées
  function addScaled() { rec.samples.forEach(function (s) { if (s.qin !== undefined) { s.qin10 = s.qin / 10; s.qr10 = s.qr / 10; } }); }
  (function () {
    DEBRIEF.orage.chart.series[1].key = 'qin10';
    DEBRIEF.recirc.chart.series[1].key = 'qr10';
  })();
  var _endGame = endGame;
  endGame = function () { if (rec) addScaled(); _endGame(); };

  /* ---------------------------------------------------------------- rejeu */
  function startReplay() {
    replaying = true; document.body.classList.add('eau-replay');
    Z.closeOverlays();
    var savedAlm = {}; alarms.order.forEach(function (id) { savedAlm[id] = alarms.state[id].st; });
    var r = Z.replay({
      recorder: rec, speed: P.timeScale * 20,
      render: function (state) {
        Object.keys(state.alm).forEach(function (id) { if (alarms.state[id].st !== state.alm[id]) { alarms.state[id].st = state.alm[id]; alarms._dirty = true; } });
        var now = performance.now(), rdt = lastRender ? Math.min(0.1, (now - lastRender) / 1000) : 0; lastRender = now;
        renderView(state, rdt); alarms.render();
      },
      onEnd: function () {
        replaying = false; document.body.classList.remove('eau-replay');
        Object.keys(savedAlm).forEach(function (id) { alarms.state[id].st = savedAlm[id]; }); alarms._dirty = true; alarms.render();
        if (debriefArgs) Z.debrief(debriefArgs);
      }
    });
    var bl = document.querySelector('#zh-replay-bar b'); if (bl) bl.textContent = 'Rejeu ×20';
    return r;
  }

  /* ------------------------------------------------------------- briefing */
  function showBriefing() {
    if (clock) clock.stop();
    Z.briefing({
      kicker: 'Briefing de prise de poste · Eau',
      title: 'Station d’épuration à boues activées (30 000 EH)',
      role: 'Vous êtes l\'<b>exploitant de conduite</b> du poste de jour. Vous pilotez l’aération, la recirculation des boues, l’extraction et le by-pass vers le bassin d’orage.',
      objective: 'Un <b>rejet conforme</b> toute la journée (MES ≤ 35 mg/L, NH₄ ≤ 10 mg N/L, DBO₅ ≤ 25 mg/L) en gardant les boues dans l’ouvrage. O₂ régulé à 2 mg/L.',
      rules: ['Le poste dure 12 h de procédé (≈ 4 min à ×10). Un incident survient dans les premières heures.',
        'Cliquez une alarme pour l’acquitter ; cliquez un équipement pour ouvrir sa commande.',
        'Valeurs et normes : repères pédagogiques, pas les données de votre site.'],
      scenarios: [
        { id: 'orage', title: 'Orage : débit ×3', level: 1, desc: 'Le débit d’entrée triple pendant plusieurs heures. Gardez vos boues dans le clarificateur.' },
        { id: 'surpresseur', title: 'Panne d’un surpresseur', level: 2, desc: 'Un surpresseur déclenche. L’oxygène chute et la nitrification se dégrade.' },
        { id: 'mystere', title: 'Mystère', level: 3, mystery: true, desc: 'Une panne tirée au sort, sans alarme évidente. À vous de mener l’enquête.' }],
      footer: 'Démo pédagogique : modèle simplifié (bilans matière, cinétiques de Monod, clarificateur à voile), paramètres plausibles mais génériques. Elle ne remplace pas les consignes de votre site. Touche F : mode formateur.',
      onStart: startScenario
    });
  }

  /* --------------------------------------------------------------- init */
  function init() {
    Z.bindDemoBanner();
    buildSVG(); buildPanel();
    rec = new Z.Recorder({ every: 30 });
    clock = new Z.Clock({ dt: P.dt, speeds: SPEEDS, speed: SPEEDS[2], step: step, render: render });
    rec.clock = clock;
    clock.bindUI({ speed: $('#speed'), pause: $('#pause') });
    Array.prototype.forEach.call($('#speed').children, function (b, i) { b.textContent = ['×1', '×5', '×10'][i]; b.title = 'Vitesse ×' + [1, 5, 10][i]; });
    alarms = new Z.Alarms({ container: '#alarmbar', clock: clock, recorder: rec });
    defineAlarms();
    model = new EauModel({ pid: new Z.PID({ kp: P.Kp, ti: P.Ti, sp: 2, bias: 60 }) });
    trends.o2 = new Z.Trend('#tr_o2', {
      window: 6 * 3600, legend: '#lg_o2',
      series: [{ key: 'o2', label: 'O₂ mesuré AT-101', color: '#1d2329', width: 2 }, { key: 'sp', label: 'Consigne', color: '#2f6fdf', dash: [6, 4], width: 1.5 },
        { key: 'air', label: 'Air FT-201 (axe droit)', color: '#8a9096', width: 1.5, axis: 'y2' }],
      y: { min: 0, max: 5, unit: 'mg/L' }, y2: { min: 0, max: 8000, unit: 'Nm³/h' }
    });
    trends.rej = new Z.Trend('#tr_rej', {
      window: 6 * 3600, legend: '#lg_rej',
      series: [{ key: 'mes', label: 'MES AT-401', color: '#1d2329', width: 2 }, { key: 'nh', label: 'NH₄ AT-102', color: '#5f666d', width: 2, dash: [4, 3] }],
      y: { min: 0, max: 60, unit: 'mg/L' },
      limits: [{ value: 35, color: '#d0021b', label: 'MES 35', legend: 'Normes (repères)' }, { value: 10, color: '#d0021b', label: 'NH₄ 10' }]
    });
    trends.hyd = new Z.Trend('#tr_hyd', {
      window: 6 * 3600, legend: '#lg_hyd',
      series: [{ key: 'qin', label: 'Débit entrée', color: '#1d2329', width: 2 }, { key: 'qbio', label: 'Débit traité', color: '#8a9096', width: 1.5 },
        { key: 'qr', label: 'Recirculation', color: '#5f666d', width: 1.5, dash: [5, 3] }, { key: 'voile', label: 'Voile (m, axe droit)', color: '#2f6fdf', width: 2, axis: 'y2' }],
      y: { min: 0, max: 900, unit: 'm³/h' }, y2: { min: 0, max: 4, unit: 'm' },
      limits: [{ value: 2.6, color: '#f5a623', label: 'voile 2,6 m', axis: 'y2' }]
    });
    // onglets de tendances
    Array.prototype.forEach.call(document.querySelectorAll('.eau-tabs button'), function (b) {
      b.addEventListener('click', function () {
        Array.prototype.forEach.call(document.querySelectorAll('.eau-tabs button'), function (x) { x.setAttribute('aria-selected', String(x === b)); });
        Array.prototype.forEach.call(document.querySelectorAll('.eau-tpane'), function (p) { p.hidden = p.id !== 'tp_' + b.getAttribute('data-t'); });
        trends[b.getAttribute('data-t')].draw(true);
      });
    });
    trainer = new Z.Trainer({ clock: clock, recorder: rec, faults: trainerFaults(), onNote: function (v) { Object.keys(trends).forEach(function (k) { trends[k].mark(clock.t, v, 'note'); }); } });
    Z.drawer('#zh-panel', '#drawerBtn');
    $('#endBtn').addEventListener('click', function () {
      if (!model || replaying || !clock.running) return;
      endGame();
    });
    renderView(view(), 0);
    showBriefing();
    global.EAU = { get model() { return model; }, get clock() { return clock; }, get alarms() { return alarms; }, get rec() { return rec; }, start: startScenario, end: function () { endGame(); }, P: P };
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})(typeof window !== 'undefined' ? window : globalThis);
