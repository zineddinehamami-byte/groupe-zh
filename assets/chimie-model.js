/* =====================================================================
   Groupe ZH Sim — CHIMIE : modèle du réacteur semi-batch R-101
   (assets/chimie-model.js — sans DOM, testable sous Node)
   ---------------------------------------------------------------------
   Réaction principale  A + B -> C   exothermique, A chargé en excès (pied de cuve),
   B coulé par la pompe P-101. Cinétique d'ordre 1 en B (A en excès) :
       r = k(T) · nB · φ        [mol/s]
       k(T) = k80 · exp(-Ea/R · (1/T - 1/353,15))     k80 = 0,010 s⁻¹, Ea = 75 kJ/mol
       φ = 1 agité ; 0,12 sans agitation (B reste en couche, peu de surface de contact)
   Accumulation : dnB/dt = F_B - r. Si T est basse, k chute (÷4,6 à 60 °C) et B
   s'accumule ; une remontée de T ou le redémarrage de l'agitateur libère alors
   brutalement l'énergie accumulée (ΔT_ad,acc = nB·ΔHr / (m·cp)). C'est le piège.

   Réaction secondaire (décomposition de la masse réactionnelle, « runaway ») :
       q_d = Qd0 · exp(Ed/R · (1/383,15 - 1/T)) · (1 - Xd)   [kW]
       Qd0 = 60 kW à 110 °C, Ed = 140 kJ/mol (≈ ×2 tous les 6 K) ; énergie totale Ed_tot = 2,4 GJ
       génère des incondensables : +15 bar à conversion totale.

   Bilan thermique réacteur (masse thermique m·cp variable avec la coulée) :
       (m·cp + Cp_paroi) dT/dt = r·ΔHr + q_d + P_agit - UA·(T - Tj) - F_B·cp_B·(T - T_B)
       ΔHr = 180 kJ/mol ; cp mélange 2,0 kJ/kg/K ; pied de cuve 4 000 kg ; paroi 1 500 kJ/K
       UA = 30 kW/K agité, 6 kW/K sans agitation (convection naturelle)
   Double enveloppe (eau de refroidissement EG, mélange parfait) :
       Cj dTj/dt = Fw·cpw·(Tin - Tj) + UA·(T - Tj)      Cj = 300 kg · 4,18 = 1 254 kJ/K
       Fw = 14 kg/s × ouverture TV-101 × disponibilité EG (1 en normal)
   Pression ciel gazeux (azote + vapeur de solvant de type toluène + gaz de décomposition) :
       P_abs = 1,2·T/353 + exp(10,6 - 4070/T) + 15·Xd   [bar abs] ; disque de rupture à 6 bar g
   Sondes : premier ordre τ = 8 s (doigt de gant) + bruit 0,05 °C ; TT-101A régule (TIC-101),
   TT-101B est la sonde de sécurité indépendante.
   Coulée nominale : 62,5 % = 5 mol/s = 1 800 kg/h (900 kW dégagés), 10 kmol de B au total,
   1 kmol déjà coulé à t = 0 -> environ 30 min de coulée restante.
   Capacité de refroidissement à 80 °C : ≈ 1 090 kW (marge ≈ 20 %).

   Incidents (scénarios) :
     'cw'    panne partielle EG (perte d'une pompe + tour aéroréfrigérante) : disponibilité -> 12 % en 60 s, Tin -> 35 °C
     'agit'  déclenchement thermique de l'agitateur M-101 (réarmement possible après 60 s)
     'drift' dérive de TT-101A : -4 °C/min (plafonnée à -55 °C) (la régulation surchauffe le réacteur)

   Valeurs plausibles mais génériques, à visée pédagogique — pas un modèle de dimensionnement.
   ===================================================================== */
(function (root) {
  'use strict';
  var R = 8.314, TK = 273.15;
  var P = {
    k80: 0.010, Ea: 75000, dH: 180, phiNoAgit: 0.12,
    Qd0: 60, Ed: 140000, EdTot: 2.4e6, Pgas: 15,
    m0: 4000, cp: 2.0, Cwall: 1500, cpB: 2.0, MB: 0.1, TB: 20,
    UA: 30, UAnat: 6, Cj: 1254, FwMax: 14, cpw: 4.18, Tin: 25,
    feedMax: 8.0, nTot: 10000, nFed0: 1000, feedNom: 62.5,
    rhoMix: 900, rhoB: 1000, Vvessel: 8.0,
    tauS: 8, Pdisc: 6.0, Tboom: 160,
    quenchMass: 1500, quenchTime: 40, agitPower: 7.5,
    cwRestore: 1e9, agitRearm: 60, driftRate: -4 / 60
  };

  function kArr(T) { return P.k80 * Math.exp(-P.Ea / R * (1 / (T + TK) - 1 / (80 + TK))); }

  function Model(opts) {
    opts = opts || {};
    this.P = P;
    var s = this.s = {
      T: 80, Tj: 0, nB: 0, nFed: P.nFed0, Xd: 0, mWater: 0,
      feedPct: P.feedNom, xv101: true,       // vitesse pompe % et vanne tout-ou-rien
      valve: 50, cwAvail: 1, Tin: P.Tin,      // TV-101 % ; disponibilité EG
      agit: 'RUN', agitTrip: -1,              // RUN | STOP | TRIP
      TA: 80, TB: 80, driftA: 0,              // mesures
      tic: { mode: 'AUTO', sp: 80, src: 'A', kp: 4, ti: 150, e1: null },
      inhib: 1, quench: false, quenchT: 0, esd: false,
      t: 0, incident: null, incidentT: null, maxNB: 0, Tmax: 80, Pmax: 0
    };
    // état initial stationnaire : nB = F/k ; refroidissement = chaleur dégagée
    var F = P.feedMax * s.feedPct / 100;
    s.nB = F / kArr(80);
    var Q = F * P.dH - F * P.cpB * P.MB * (80 - P.TB);
    s.Tj = 80 - Q / P.UA;
    var Fw = Q / (P.cpw * (s.Tj - P.Tin));
    s.valve = 100 * Fw / P.FwMax;
    s.nFed = P.nFed0 + 0; this.reactantFed0 = s.nFed;
    this.rng = opts.rng || Math.random;
    this.noise = opts.noise === false ? 0 : 0.05;
    this.derive();
  }
  Model.P = P; Model.kArr = kArr;

  Model.prototype.mass = function () { var s = this.s; return P.m0 + s.nFed * P.MB + s.mWater; };
  Model.prototype.feedRate = function () {
    var s = this.s; if (!s.xv101 || s.esd || s.quench || s.nFed >= P.nTot) return 0;
    return P.feedMax * s.feedPct / 100;
  };
  Model.prototype.inject = function (kind) {
    var s = this.s; if (s.incident === kind) return;
    s.incident = s.incident ? s.incident + '+' + kind : kind; if (s.incidentT === null) s.incidentT = s.t;
    if (kind === 'cw') { s.cwT0 = s.t; }
    if (kind === 'agit') { s.agit = 'TRIP'; s.agitTrip = s.t; }
    if (kind === 'drift') { s.driftT0 = s.t; }
  };

  /** Rétablissement de l'eau de refroidissement (action formateur). */
  Model.prototype.restoreCW = function () { var s = this.s; if (s.cwT0 !== undefined && !s.cwRestoreE) s.cwRestoreE = s.t - s.cwT0; };

  Model.prototype.step = function (dt) {
    var s = this.s, inc = s.incident || '';
    // --- incidents évolutifs
    if (inc.indexOf('cw') >= 0) {
      var e = s.t - s.cwT0;
      var eR = s.cwRestoreE || P.cwRestore;
      if (e < eR) { var x = Math.min(1, e / 60); s.cwAvail = 1 - 0.88 * x; s.Tin = P.Tin + 10 * Math.min(1, e / 240); }
      else { var y = Math.min(1, (e - eR) / 60); s.cwAvail = 0.12 + 0.88 * y; s.Tin = P.Tin + 10 * (1 - y); s.cwRestored = true; }
    }
    if (inc.indexOf('drift') >= 0) s.driftA = Math.max(-55, P.driftRate * (s.t - s.driftT0));

    // --- TIC-101 (PI forme vitesse, action inverse : T monte -> vanne s'ouvre)
    var c = s.tic;
    if (c.mode === 'AUTO' && !s.esd) {
      var pv = c.src === 'B' ? s.mTB : s.mTA, err = pv - c.sp;
      if (c.e1 === null) c.e1 = err;
      s.valve = Math.max(0, Math.min(100, s.valve + c.kp * ((err - c.e1) + dt / c.ti * err)));
      c.e1 = err;
    } else c.e1 = null;
    if (s.esd) s.valve = 100;

    // --- débits
    var FB = this.feedRate();
    if (s.nFed + FB * dt > P.nTot) FB = (P.nTot - s.nFed) / dt;
    var Fw = P.FwMax * s.valve / 100 * s.cwAvail;
    var agitOn = s.agit === 'RUN';
    var UA = agitOn ? P.UA : P.UAnat;
    var phi = agitOn ? 1 : P.phiNoAgit;

    // --- noyage : eau froide + inhibiteur en 40 s
    var mq = 0;
    if (s.quench && s.mWater < P.quenchMass) {
      mq = Math.min(P.quenchMass - s.mWater, P.quenchMass / P.quenchTime * dt);
      s.mWater += mq; s.inhib = Math.max(0.02, s.inhib - dt / 20);
    }

    // --- cinétique
    var r = kArr(s.T) * s.nB * phi * s.inhib;
    r = Math.min(r, s.nB / dt + FB);
    var qd = P.Qd0 * Math.exp(P.Ed / R * (1 / (110 + TK) - 1 / (s.T + TK))) * (1 - s.Xd) * (s.quench ? 0.1 : 1);
    qd = Math.min(qd, (1 - s.Xd) * P.EdTot / dt);

    // --- bilans
    var m = this.mass();
    var Cth = (P.m0 + s.nFed * P.MB) * P.cp + s.mWater * 4.18 + P.Cwall;
    var Qr = r * P.dH, Qc = UA * (s.T - s.Tj);
    var Qfeed = FB * P.MB * P.cpB * (s.T - P.TB), Qq = mq / dt * 4.18 * (s.T - 20);
    var Qag = agitOn ? P.agitPower : 0;
    var dT = (Qr + qd + Qag - Qc - Qfeed - Qq) / Cth;
    var dTj = (Fw * P.cpw * (s.Tin - s.Tj) + Qc) / P.Cj;
    s.T += dT * dt; s.Tj += dTj * dt;
    s.nB = Math.max(0, s.nB + (FB - r) * dt);
    s.nFed += FB * dt;
    s.Xd = Math.min(1, s.Xd + qd * dt / P.EdTot);
    s.t += dt;

    // --- mesures (doigt de gant, 1er ordre) + bruit
    var a = Math.min(1, dt / P.tauS), n = this.noise;
    s.TB += (s.T - s.TB) * a; s.TA += (s.T - s.TA) * a;
    s.Qr = Qr; s.Qc = Qc; s.qd = qd; s.FB = FB; s.Fw = Fw; s.r = r; s.dTdt = dT;
    this.derive();
    s.maxNB = Math.max(s.maxNB, s.nB); s.Tmax = Math.max(s.Tmax, s.T); s.Pmax = Math.max(s.Pmax, s.P);
    s.mTA = s.TA + s.driftA + (n ? (this.rng() - 0.5) * 2 * n : 0);
    s.mTB = s.TB + (n ? (this.rng() - 0.5) * 2 * n : 0);
  };
  Model.prototype.derive = function () {
    var s = this.s, Tk = s.T + TK;
    s.P = 1.2 * Tk / 353.15 + Math.exp(10.6 - 4070 / Tk) + P.Pgas * s.Xd - 1.013;
    var V = (P.m0 + (s.nFed - s.nB) * P.MB) / P.rhoMix + s.nB * P.MB / P.rhoB + s.mWater / 1000;
    s.L = 100 * V / P.Vvessel;
    s.Cth = (P.m0 + s.nFed * P.MB) * P.cp + s.mWater * 4.18 + P.Cwall;
    s.dTad = s.nB * P.dH * s.inhib / s.Cth;           // ΔT adiabatique de l'accumulation
    s.MTSR = s.T + s.dTad;
    if (s.mTA === undefined) { s.mTA = s.TA; s.mTB = s.TB; }
    s.fedPct = 100 * s.nFed / P.nTot;
    s.runaway = s.T >= P.Tboom || s.P >= P.Pdisc;
  };

  root.ZHChimieModel = Model;
  if (typeof module !== 'undefined' && module.exports) module.exports = Model;
})(typeof window !== 'undefined' ? window : globalThis);
