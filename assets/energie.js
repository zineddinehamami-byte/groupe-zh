/* =====================================================================
   Groupe ZH Sim — ÉNERGIE : chaudière vapeur (assets/energie.js)
   ---------------------------------------------------------------------
   Chaudière industrielle à tubes d'eau, 20 t/h de vapeur saturée à 12 bar (eff.),
   ballon supérieur + ballon inférieur, brûleur gaz, pompes alimentaires A/B
   aspirant dans une bâche dégazante à 105 °C.

   Modèle « à paramètres localisés », simplifié mais physiquement cohérent :
   il s'inspire du modèle de ballon d'Åström & Bell (Automatica, 2000), réduit
   à 4 états pour rester lisible :

     P   pression du ballon (bar eff.)        — bilan d'énergie
     Mw  masse d'eau dans ballon + faisceau (kg) — bilan matière
     Vb  volume des bulles de vapeur SOUS la surface (m³) — 1er ordre
     Q   puissance absorbée par l'eau (kW)     — 1er ordre derrière l'allure brûleur

   1) Bilan d'énergie (eau + métal à saturation, vapeur sèche en sortie) :
        C(P) · dP/dt = Q − Ws·(hg − hl) − Wf·(hl − hfeed)
      C = Mw·dhl/dP + Mmétal·cp·dTsat/dP  ≈ 15 000×17,3 + 50 000×0,5×3,9 ≈ 357 MJ/bar
      En régime établi Ws = Wf et Q = Ws·(hg − hfeed) ≈ 5,56 × 2 346 ≈ 13 MW.
   2) Bilan matière : dMw/dt = Wf − Ws − Wpurge − Wprimage
   3) Gonflement / contraction (« swell & shrink ») : le volume des bulles dans
      les tubes vaporisateurs vaut, à l'équilibre,
        Vb* = τr · Wr / ρg(P)   avec Wr = Ws − (Wf − Ws)·(hl − hfeed)/hfg
      τr ≈ 1,5 s : temps de séjour des bulles. Un appel de vapeur augmente Wr
      ET fait baisser la pression, donc ρg : les bulles gonflent, le niveau
      APPARENT monte alors que la masse d'eau diminue. À l'inverse, une arrivée
      d'eau froide recondense des bulles (contraction). Vb suit Vb* avec τb = 6 s.
   4) Niveau (mm / niveau normal NWL) : L = (Mw/ρl + Vb − Vref)/A
      A = 5 m² (ballon Ø 1,2 m × 4,2 m, section au plan d'eau). ρl = 875 kg/m³
      (eau à 190 °C), supposée constante. Section supposée constante sur ±300 mm.

   Propriétés de l'eau (tables IAPWS, interpolation linéaire autour de 10–14 bar abs) :
     hl = 762,7 + 17,3·(Pabs − 10) kJ/kg ; hfg = 2 154 − 14·Pabs kJ/kg ;
     hg ≈ 2 786 kJ/kg ; ρg ≈ 0,52·Pabs kg/m³ ; hfeed (105 °C) = 440 kJ/kg.

   Régulations (PI forme vitesse, sans à-coup) :
     PIC-101  pression → allure brûleur (20–100 % en marche, minimum technique 20 %)
     LIC-101  1 élément : niveau → vanne alimentaire LV-101
              3 éléments : niveau → correction (kg/s) ajoutée au débit vapeur mesuré
                           = consigne du FIC-103, qui pilote LV-101
   Sécurités (détecteurs indépendants de LT-101, comme sur site) :
     LSLL-101 niveau très bas −200 mm → déclenchement brûleur
     LSHH-101 niveau très haut +200 mm → alarme, primage (entraînement d'eau)
     PSV-101  soupape tarée 13,8 bar eff.
   Toutes les durées sont en secondes simulées.
   ===================================================================== */
(function (root) {
  'use strict';

  var PRM = {
    A: 5.0,            // m², section du ballon au plan d'eau (Ø 1,2 m × 4,2 m)
    rhoL: 875,         // kg/m³
    Mw0: 15000,        // kg, eau en circulation (ballons + faisceau)
    Cmetal: 97500,     // kJ/bar, inertie du métal (50 t × 0,5 kJ/kg/K × 3,9 K/bar)
    dhldP: 17.3,       // kJ/kg/bar
    hg: 2786, hfeed: 440,
    tauR: 0.6,         // s, temps de séjour des bulles dans les tubes vaporisateurs
    tauF: 4.0,       // s, temps de séjour des bulles de détente (flash)
    tauB: 6,           // s, dynamique du volume de bulles
    Qmax: 17000,      // kW absorbés à 100 % d'allure
    tauQ: 15,          // s, flamme + réfractaire + métal
    fireRate: 3,       // %/s, vitesse maxi de variation d'allure (registres d'air)
    lowFire: 20,       // %, minimum technique
    Psp: 12,           // bar eff., consigne nominale
    Wnom: 5.556,       // kg/s = 20 t/h
    Ppump: 20,         // bar eff., refoulement pompe alimentaire (à débit nominal)
    Kv: 3.02,          // kg/s/√bar, LV-101 à 100 %
    Kvb: 1.0,          // kg/s/√bar, by-pass manuel HV-102 à 100 %
    tauValve: 2,       // s, servomoteur LV-101
    pumpStart: 8,      // s, démarrage de la pompe de secours
    purge: 2.5,        // kg/s, purge de fond HV-103 ouverte
    psvSet: 13.8, psvReseat: 13.2, psvCap: 9,
    LAH: 100, LAL: -100, LSHH: 180, LSLL: -180,
    PAL: 10.5, PAH: 13.3,
    delest: 0.25       // délestage : −25 % de la demande des usagers non prioritaires
  };

  function rng(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0; var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

  /** PI forme vitesse (ISA), sortie bornée ; MAN : la sortie est écrite directement. */
  function PI(kp, ti, lo, hi, out) { this.kp = kp; this.ti = ti; this.lo = lo; this.hi = hi; this.out = out; this.e1 = null; this.mode = 'AUTO'; }
  PI.prototype.run = function (e, dt) {
    if (this.mode !== 'AUTO') { this.e1 = null; return this.out; }
    if (this.e1 === null) this.e1 = e;
    this.out = clamp(this.out + this.kp * ((e - this.e1) + dt / this.ti * e), this.lo, this.hi);
    this.e1 = e; return this.out;
  };

  function props(P) {
    var pa = Math.max(1.2, P + 1.013);
    return { hl: 762.7 + PRM.dhldP * (pa - 10), hfg: 2154 - 14 * pa, rhoG: 0.52 * pa };
  }

  /**
   * Crée une partie. opts : {scenario:'a'|'b'|'c', seed, mystery:'lt'|'valve'}
   * API : step(dt) ; act(type, value) ; view() (état affichable, sérialisable) ;
   *       .events (file d'événements procédé à consommer par l'interface)
   */
  function Boiler(opts) {
    opts = opts || {};
    var r = this.rand = rng(opts.seed || 1);
    this.scenario = opts.scenario || 'a';
    this.t = 0;
    this.events = [];
    var P = PRM.Psp, pr = props(P), W = PRM.Wnom;
    // état
    var s = this.s = {
      P: P, Mw: PRM.Mw0, Vb: PRM.tauR * W / pr.rhoG, dP: 0, Q: W * (PRM.hg - PRM.hfeed),
      fire: 0, D: W, Dtarget: W, Dnoise: 0, delest: false,
      x: 0.5, bypass: 0, purge: false, purgeX: 0,
      pumpA: 'run', pumpB: 'stop', spA: 1, spB: 0, startB: 0,
      burner: 'on', prepurge: 0,
      ltSel: 'A', ltA: 0, ltB: 0, ltFrozen: null, valveStuck: false,
      psv: false, Ws: W, Wf: W, Wusers: W, Wpsv: 0, Wpurge: 0, Wcarry: 0,
      L: 0, Lmeas: 0, noiseA: 0, noiseB: 0
    };
    s.fire = s.Q / PRM.Qmax * 100;
    s.x = W / (PRM.Kv * Math.sqrt(PRM.Ppump - P));       // ouverture d'équilibre de LV-101 (≈ 65 %)
    this.Vref = PRM.Mw0 / PRM.rhoL + s.Vb;
    // régulations
    this.pic = new PI(25, 50, 0, 100, s.fire);           // %/bar, s
    this.pic.sp = PRM.Psp;
    this.lic = new PI(0.3, 300, 0, 100, s.x * 100);             // 1 élément : %/mm, s
    this.lic.sp = 0; this.structure = 1;
    this.lic3 = new PI(0.006, 120, -2, 2, 0);              // 3 éléments : (kg/s)/mm, s
    this.fic = new PI(6, 6, 0, 100, s.x * 100);                  // %/(kg/s), s
    this.Fsp = W; this.WsF = W; this.WfF = W;
    // scénario : instant de l'incident tiré au sort
    this.tInc = 360 + Math.floor(r() * 180);              // entre 6 et 9 min de procédé (36 à 54 s réelles à ×10)
    this.mystery = opts.mystery || (r() < 0.5 ? 'lt' : 'valve');
    this.incident = null; this.tripCause = null;
    this.flags = { lal: false, lah: false, lsll: false, lshh: false, psv: false, pal: false };
    this.stats = { Lmin: 0, Lmax: 0, LmeasMin: 0, LmeasMax: 0, Pmin: P, Pmax: P, demandInt: 0, okInt: 0, carryKg: 0, tPrimage: 0, tTrip: 0 };
    this.timeline = [];
  }

  Boiler.prototype.emit = function (type, label, extra) { var e = { t: this.t, type: type, label: label }; if (extra) for (var k in extra) e[k] = extra[k]; this.events.push(e); };

  /** Scénarios (horaires en secondes simulées). */
  Boiler.prototype.script = function () {
    var t = this.t, s = this.s;
    if (!this.fired && t >= this.tInc && this.scenario !== 'x') {
      this.fired = t;
      if (this.incident === null) this.incident = t;
      this.inject(this.scenario === 'a' ? 'steam40' : this.scenario === 'b' ? 'pumpA' : this.mystery === 'lt' ? 'ltFreeze' : 'valveStuck', true);
    }
    if (!this.fired) return;
    if (this.scenario === 'a' && !this.backDone && t >= this.fired + (this.backAfter || 900)) {
      this.backDone = true; s.Dtarget = PRM.Wnom; this.emit('info', 'Usagers : fin de l’appel de vapeur, retour à 20 t/h');
    }
    // scénario mystère : l'atelier monte en charge 40 s après la panne, qui devient visible
    if (this.scenario === 'c' && !this.rampDone && t >= this.fired + 40) { this.rampDone = true; s.Dtarget = s.Dtarget * 1.25; }
  };

  /** Pannes (scénarios et mode formateur). */
  Boiler.prototype.inject = function (id, fromScenario) {
    var s = this.s;
    if (this.incident === null) this.incident = this.t;
    switch (id) {
      case 'steam40': s.Dtarget = s.Dtarget * 1.4; this.emit('incident', fromScenario ? 'Appel de vapeur brutal côté usagers (+40 %)' : 'Appel de vapeur +40 %'); break;
      case 'steamDrop': s.Dtarget = s.Dtarget * 0.6; this.emit('incident', 'Chute brutale de la demande vapeur (−40 %)'); break;
      case 'pumpA': if (s.pumpA === 'run') { s.pumpA = 'fault'; } this.emit('incident', 'Déclenchement de la pompe alimentaire P-101A'); break;
      case 'ltFreeze': s.ltFrozen = s.ltA; this.emit('incident', 'Transmetteur de niveau LT-101A figé (panne cachée)', { hidden: true }); break;
      case 'valveStuck': s.valveStuck = true; this.emit('incident', 'Vanne alimentaire LV-101 grippée (panne cachée)', { hidden: true }); break;
    }
  };

  /** Commandes opérateur. Retourne le libellé journalisé (ou null si sans effet). */
  Boiler.prototype.act = function (type, v) {
    var s = this.s, lbl = null;
    switch (type) {
      case 'licMode':
        if (this.lic.mode === v) break;
        this.lic.mode = v; this.fic.mode = v; this.lic3.mode = v;
        if (v === 'AUTO') { this.lic.e1 = null; this.fic.out = this.lic.out; this.lic3.out = 0; this.lic3.e1 = null; this.fic.e1 = null; }
        lbl = 'LIC-101 niveau en ' + v; break;
      case 'licOut': // sortie manuelle vanne (%)
        this.lic.out = clamp(v, 0, 100); this.fic.out = this.lic.out; lbl = 'LV-101 ouverture manuelle ' + Math.round(this.lic.out) + ' %'; break;
      case 'licSp': this.lic.sp = clamp(v, -100, 100); lbl = 'Consigne niveau ' + Math.round(this.lic.sp) + ' mm'; break;
      case 'structure':
        if (this.structure === v) break;
        this.structure = v;
        if (v === 3) { this.lic3.out = 0; this.lic3.e1 = null; this.fic.out = this.lic.out; this.fic.e1 = null; }
        else { this.lic.out = this.fic.out; this.lic.e1 = null; }
        lbl = 'Régulation de niveau à ' + v + ' élément' + (v > 1 ? 's' : ''); break;
      case 'picMode': if (this.pic.mode === v) break; this.pic.mode = v; this.pic.e1 = null; lbl = 'PIC-101 pression en ' + v; break;
      case 'picOut': this.pic.out = clamp(v, 0, 100); lbl = 'Allure brûleur manuelle ' + Math.round(this.pic.out) + ' %'; break;
      case 'picSp': this.pic.sp = clamp(v, 9, 13.5); lbl = 'Consigne pression ' + this.pic.sp.toFixed(1).replace('.', ',') + ' bar'; break;
      case 'startB': if (s.pumpB === 'stop') { s.pumpB = 'starting'; s.startB = 0; lbl = 'Démarrage pompe de secours P-101B'; } break;
      case 'stopB': if (s.pumpB !== 'stop') { s.pumpB = 'stop'; lbl = 'Arrêt pompe P-101B'; } break;
      case 'bypass': s.bypass = clamp(v, 0, 1); lbl = 'By-pass HV-102 ' + Math.round(s.bypass * 100) + ' %'; break;
      case 'purge': s.purge = !!v; lbl = v ? 'Purge de fond HV-103 ouverte' : 'Purge de fond HV-103 fermée'; break;
      case 'delest': s.delest = !!v; lbl = v ? 'Délestage des usagers non prioritaires (−25 %)' : 'Fin du délestage'; break;
      case 'ltSel': if (s.ltSel !== v) { s.ltSel = v; lbl = 'Niveau : sélection du transmetteur LT-101' + v; } break;
      case 'esd': if (s.burner !== 'trip') { this.trip('Arrêt d’urgence brûleur (opérateur)'); lbl = 'ARRÊT D’URGENCE brûleur'; } break;
      case 'reset':
        if (s.burner === 'trip' && s.L > -150 && s.L < 150) { s.burner = 'prepurge'; s.prepurge = 0; lbl = 'Réarmement brûleur : prébalayage'; }
        break;
    }
    return lbl;
  };

  Boiler.prototype.trip = function (cause) {
    var s = this.s; if (s.burner === 'trip') return;
    s.burner = 'trip'; this.tripCause = cause; this.emit('trip', cause);
  };

  /** Un pas d'intégration (Euler explicite, dt ≤ 0,2 s). */
  Boiler.prototype.step = function (dt) {
    var s = this.s, r = this.rand;
    this.t += dt; this.script();
    var pr = props(s.P);

    // --- demande des usagers : marche aléatoire lente ±2 % + ouverture des vannes usagers (τ 5 s)
    s.Dnoise += (-s.Dnoise / 120 + (r() - 0.5) * 0.002) * dt;
    s.Dnoise = clamp(s.Dnoise, -0.12, 0.12);
    s.D += (s.Dtarget - s.D) * Math.min(1, dt / 5);
    var Dcmd = (s.D + s.Dnoise) * (s.delest ? 1 - PRM.delest : 1);
    s.Wusers = Math.max(0, Dcmd * Math.sqrt(Math.max(0, (s.P + 1.013) / (PRM.Psp + 1.013))));
    // soupape PSV-101 (hystérésis d'ouverture/refermeture)
    if (!s.psv && s.P > PRM.psvSet) s.psv = true;
    if (s.psv && s.P < PRM.psvReseat) s.psv = false;
    s.Wpsv = s.psv ? PRM.psvCap * clamp((s.P - PRM.psvReseat) / 0.6, 0.2, 1) : 0;
    s.Ws = s.Wusers + s.Wpsv;

    // --- pompes alimentaires (vitesse : 1er ordre 2 s ; hauteur ∝ vitesse²)
    if (s.pumpB === 'starting') { s.startB += dt; if (s.startB >= PRM.pumpStart) { s.pumpB = 'run'; this.emit('info', 'P-101B en marche'); } }
    s.spA += ((s.pumpA === 'run' ? 1 : 0) - s.spA) * Math.min(1, dt / 2);
    s.spB += ((s.pumpB === 'run' ? 1 : s.pumpB === 'starting' ? 0.3 * s.startB / PRM.pumpStart : 0) - s.spB) * Math.min(1, dt / 2);
    var sp = Math.max(s.spA, s.spB), Pdis = PRM.Ppump * sp * sp;

    // --- régulation de niveau
    var Lm = s.Lmeas, cmd;
    this.WsF += (s.Ws - this.WsF) * Math.min(1, dt / 2);       // FT-102 filtré 2 s
    if (this.structure === 1) {
      cmd = this.lic.run(this.lic.sp - Lm, dt);
      this.fic.out = this.lic.out;
    } else {
      var bias = this.lic3.run(this.lic.sp - Lm, dt);
      this.Fsp = Math.max(0, this.WsF + bias);
      if (this.lic.mode === 'AUTO') cmd = this.fic.run(this.Fsp - this.WfF, dt); else cmd = this.lic.out;
      this.lic.out = this.fic.out = cmd;
    }
    if (!s.valveStuck) s.x += (cmd / 100 - s.x) * Math.min(1, dt / PRM.tauValve);
    s.Wf = (s.x * PRM.Kv + s.bypass * PRM.Kvb) * Math.sqrt(Math.max(0, Pdis - s.P));
    this.WfF += (s.Wf - this.WfF) * Math.min(1, dt / 1);

    // --- purge et primage
    s.purgeX += ((s.purge ? 1 : 0) - s.purgeX) * Math.min(1, dt / 3);
    s.Wpurge = PRM.purge * s.purgeX * Math.sqrt(Math.max(0, (s.P + 1.013) / 13));
    s.Wcarry = s.L > 150 ? Math.min(2, (s.L - 150) * 0.02) * (s.Wusers / PRM.Wnom) : 0;

    // --- brûleur
    if (s.burner === 'prepurge') { s.prepurge += dt; if (s.prepurge >= 30) { s.burner = 'on'; this.pic.out = PRM.lowFire; this.emit('info', 'Brûleur rallumé (petite allure)'); } }
    var u = this.pic.run(this.pic.sp - s.P, dt);
    var target = s.burner === 'on' ? Math.max(PRM.lowFire, u) : 0;
    var df = clamp(target - s.fire, -PRM.fireRate * dt * (s.burner === 'on' ? 1 : 50), PRM.fireRate * dt);
    s.fire = clamp(s.fire + df, 0, 100);
    s.Q += (s.fire / 100 * PRM.Qmax - s.Q) * Math.min(1, dt / (s.burner === 'on' ? PRM.tauQ : 30));

    // --- bilans
    var C = s.Mw * PRM.dhldP + PRM.Cmetal;
    var dP = (s.Q - s.Ws * (PRM.hg - pr.hl) - s.Wf * (pr.hl - PRM.hfeed)) / C;
    s.P = Math.max(0, s.P + dP * dt);
    s.Mw = Math.max(2000, s.Mw + (s.Wf - s.Ws - s.Wpurge - s.Wcarry) * dt);
    // gonflement / contraction : bulles produites par le flux de chaleur (Wq, réduit par
    // l'eau alimentaire sous-refroidie) + bulles de détente (flash) quand la pression baisse
    var Wq = Math.max(0, (s.Q - s.Wf * (pr.hl - PRM.hfeed)) / pr.hfg);
    var Wfl = Math.max(0, -dP) * s.Mw * PRM.dhldP / pr.hfg;
    s.dP = dP;
    var VbEq = (PRM.tauR * Wq + PRM.tauF * Wfl) / Math.max(0.6, pr.rhoG);
    s.Vb += (VbEq - s.Vb) * Math.min(1, dt / PRM.tauB);
    // ballon plein au-delà de +600 mm (l'excédent part en primage)
    s.Mw = Math.min(s.Mw, (this.Vref + 0.6 * PRM.A - s.Vb) * PRM.rhoL);
    s.L = ((s.Mw / PRM.rhoL + s.Vb) - this.Vref) / PRM.A * 1000;

    // --- mesures (bruit filtré ±1,5 mm ; LT-101A figé si panne)
    s.noiseA += ((r() - 0.5) * 6 - s.noiseA) * Math.min(1, dt / 1.5);
    s.noiseB += ((r() - 0.5) * 6 - s.noiseB) * Math.min(1, dt / 1.5);
    s.ltA = s.ltFrozen !== null ? s.ltFrozen : s.L + s.noiseA;
    s.ltB = s.L + 3 + s.noiseB;   // LT-101B : léger décalage d'étalonnage (+3 mm)
    s.Lmeas = s.ltSel === 'A' ? s.ltA : s.ltB;

    // --- sécurités indépendantes
    if (s.L < PRM.LSLL && s.burner !== 'trip') { this.flags.lsll = true; this.trip('LSLL-101 niveau très bas : déclenchement brûleur'); }
    if (s.L > PRM.LSHH) this.flags.lshh = true;
    if (s.psv) this.flags.psv = true;
    if (Lm < PRM.LAL) this.flags.lal = true;
    if (Lm > PRM.LAH) this.flags.lah = true;
    if (s.P < PRM.PAL) this.flags.pal = true;

    // --- statistiques (production livrée conforme : P ≥ 10,5 bar et sans primage)
    var st = this.stats;
    st.Lmin = Math.min(st.Lmin, s.L); st.Lmax = Math.max(st.Lmax, s.L);
    st.LmeasMin = Math.min(st.LmeasMin, Lm); st.LmeasMax = Math.max(st.LmeasMax, Lm);
    st.Pmin = Math.min(st.Pmin, s.P); st.Pmax = Math.max(st.Pmax, s.P);
    var demand = s.D + s.Dnoise;
    st.demandInt += demand * dt;
    if (s.P >= PRM.PAL && s.Wcarry < 0.05) {
      var served = Math.min(s.Wusers, demand);
      // la vapeur délestée (usagers non prioritaires, prévenus) ne compte que pour moitié en perte
      if (s.delest) served = Math.min(demand, served + 0.5 * (demand - served));
      st.okInt += served * dt;
    }
    st.carryKg += s.Wcarry * dt; if (s.Wcarry > 0.05) st.tPrimage += dt;
    if (s.burner !== 'on') st.tTrip += dt;
  };

  /** État affichable (sérialisable : sert aussi d'instantané pour le rejeu). */
  Boiler.prototype.view = function () {
    var s = this.s;
    return {
      t: this.t, P: s.P, L: s.L, Lmeas: s.Lmeas, ltA: s.ltA, ltB: s.ltB, ltSel: s.ltSel,
      Ws: s.Ws, Wusers: s.Wusers, Wf: s.Wf, Wpsv: s.Wpsv, Wpurge: s.Wpurge, Wcarry: s.Wcarry,
      D: s.D + s.Dnoise, delest: s.delest, fire: s.fire, Q: s.Q, burner: s.burner, prepurge: s.prepurge,
      x: s.x, cmd: this.lic.out, bypass: s.bypass, purge: s.purge, psv: s.psv,
      pumpA: s.pumpA, pumpB: s.pumpB, spA: s.spA, spB: s.spB,
      licMode: this.lic.mode, licSp: this.lic.sp, structure: this.structure, Fsp: this.Fsp,
      picMode: this.pic.mode, picSp: this.pic.sp, picOut: this.pic.out, Mw: s.Mw, Vb: s.Vb
    };
  };

  var api = { Boiler: Boiler, PRM: PRM, props: props };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.ZHBoiler = api;
})(typeof window !== 'undefined' ? window : globalThis);

/* =====================================================================
   INTERFACE (synoptique, faceplates, alarmes, tendances, débriefing)
   S'appuie sur le noyau commun window.ZHSim (assets/zh-sim-core.js).
   ===================================================================== */
(function () {
  'use strict';
  if (typeof document === 'undefined' || !window.ZHSim || !window.ZHBoiler) return;
  var Z = window.ZHSim, U = Z.util, B = window.ZHBoiler, PRM = B.PRM;
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var DURATION = 1800;           // s simulées (3 min réelles à ×10)
  var TH = 3.6;                  // kg/s -> t/h

  /* ------------------------------------------------------------ scénarios */
  var SCN = {
    a: { title: 'Appel de vapeur brutal', short: 'Appel de vapeur +40 %', level: 1,
      desc: 'Un gros consommateur démarre : +40 % de vapeur en quelques secondes. Le niveau du ballon a un comportement surprenant.' },
    b: { title: 'Perte de la pompe alimentaire', short: 'Pompe alimentaire', level: 2,
      desc: 'La pompe en service déclenche. Vous avez quelques minutes de procédé avant le niveau très bas.' },
    c: { title: 'Panne mystère', short: 'Mystère', level: 3, mystery: true,
      desc: 'Une panne tirée au sort, instrument ou actionneur, pendant une montée en charge. À vous de la trouver en croisant les mesures.' }
  };

  var DEBRIEF = {
    a: {
      keyPoints: [
        '<b>Gonflement</b> : lors d’un appel de vapeur, la pression baisse, l’eau se vaporise et les bulles font monter le niveau <i>apparent</i>, alors que la masse d’eau diminue.',
        'Le réflexe de <b>réduire l’eau alimentaire est le mauvais</b> : l’eau manque au moment où les bulles disparaissent, et le niveau chute jusqu’au déclenchement.',
        'La <b>régulation 3 éléments</b> ajoute le débit vapeur en anticipation : l’eau suit la vapeur, le niveau ne fait plus qu’une correction lente.'
      ],
      sequence: [
        'Repérer la hausse brutale de FI-102 (vapeur) et la montée de LI-101 : c’est du gonflement, pas un excès d’eau.',
        'Garder l’eau ouverte ; passer LIC-101 en 3 éléments (ou en MAN, débit d’eau égal au débit vapeur).',
        'Surveiller la pression : brûleur à 100 %, délester les usagers non prioritaires si elle descend vers 10,5 bar.',
        'À la fin de l’appel, laisser passer la contraction (le niveau baisse d’abord) sans sur-réagir.',
        'Acquitter les alarmes et consigner l’événement.'
      ]
    },
    b: {
      keyPoints: [
        'Sans eau alimentaire, le ballon perd environ <b>1,3 mm par seconde</b> à 20 t/h : quelques minutes avant le niveau très bas.',
        '<b>Démarrer la pompe de secours tout de suite</b> ; réduire la charge (délestage) donne du temps.',
        'À la reprise, l’eau froide recondense des bulles : le niveau baisse encore un instant (<b>contraction</b>) avant de remonter. Doser pour éviter le primage.'
      ],
      sequence: [
        'Lire l’alarme P-101A et le débit FI-103 qui tombe à zéro.',
        'Démarrer P-101B immédiatement (8 s de démarrage).',
        'Si le niveau descend vite : délester les usagers non prioritaires.',
        'Vérifier la remontée du débit d’eau, puis le retour du niveau vers la consigne.',
        'Faire expertiser P-101A ; consigner l’événement.'
      ]
    },
    lt: {
      keyPoints: [
        'Une mesure qui ne bouge plus du tout (courbe plate, sans bruit) est <b>suspecte</b>.',
        '<b>Croiser les mesures</b> : niveau à glace, second transmetteur LT-101B, cohérence débit d’eau / débit vapeur.',
        'Les sécurités de niveau sont <b>indépendantes</b> du transmetteur de régulation : c’est ce qui protège la chaudière quand la mesure ment.'
      ],
      sequence: [
        'Constater l’écart entre LI-101 et le niveau à glace, ou l’alarme d’écart LT-101A / LT-101B.',
        'Basculer la régulation sur LT-101B.',
        'Au besoin, passer en MAN et égaler le débit d’eau au débit vapeur, ou passer en 3 éléments.',
        'Revenir en AUTO une fois le niveau stabilisé ; faire intervenir l’instrumentiste.'
      ]
    },
    valve: {
      keyPoints: [
        'Comparer <b>commande et position réelle</b> d’une vanne : un écart durable signale un actionneur grippé.',
        'La régulation ne peut rien si l’actionneur ne suit pas : passer sur le <b>by-pass manuel HV-102</b>.',
        'Réduire la charge donne du temps ; régler le by-pass en regardant le <b>débit d’eau</b>, pas seulement le niveau.'
      ],
      sequence: [
        'Constater l’écart commande / position de LV-101 et le niveau qui ne répond pas.',
        'Ouvrir progressivement le by-pass HV-102 pour égaler débit d’eau et débit vapeur.',
        'Délester si le niveau continue de baisser.',
        'Surveiller la remontée ; appeler la maintenance pour la vanne.'
      ]
    }
  };

  /* ------------------------------------------------------------ état appli */
  var app = {
    model: null, scn: 'a', seed: 1, ended: false, replaying: false,
    firstRelevant: null, wrongReflex: [], timers: { ldev: 0, zdev: 0 }, WsSlow: PRM.Wnom,
    lastView: null, lastDebrief: null, animT: 0
  };

  /* ------------------------------------------------------------ synoptique */
  var GL = { top: 40, bot: 180, range: 300 };          // niveau à glace : ±300 mm
  function yGlass(L) { var c = (GL.top + GL.bot) / 2; return c - U.clamp(L, -GL.range, GL.range) * (GL.bot - GL.top) / 2 / GL.range; }
  function yDrum(L) { return 110 - U.clamp(L, -600, 600) * 0.075; }

  function vb(id, x, y, w, tag, unit, fp, title) {
    return '<g id="' + id + '" class="en-vb' + (fp ? ' en-click' : '') + '"' + (fp ? ' data-fp="' + fp + '"' : '') + '>' +
      (title ? '<title>' + title + '</title>' : '') +
      '<rect class="zh-valbox" x="' + x + '" y="' + y + '" width="' + w + '" height="38" rx="3"/>' +
      '<text class="zh-tag" x="' + (x + 6) + '" y="' + (y + 13) + '">' + tag + '</text>' +
      '<text class="zh-val" id="' + id + '-v" x="' + (x + w - 30) + '" y="' + (y + 31) + '" text-anchor="end">---</text>' +
      '<text class="zh-unit" x="' + (x + w - 26) + '" y="' + (y + 31) + '">' + unit + '</text>' +
      '<g class="zh-almind"><rect x="' + (x + w - 12) + '" y="' + (y + 4) + '" width="8" height="8"/></g>' +
      '</g>';
  }

  function buildSVG() {
    var risers = '', i;
    for (i = 0; i < 14; i++) { var rx = 376 + i * 15; risers += '<line class="en-riser" x1="' + rx + '" y1="160" x2="' + rx + '" y2="430"/>'; }
    var bubbles = '';
    for (i = 0; i < 36; i++) bubbles += '<circle class="en-bubble" r="' + (1.6 + (i % 3) * 0.5) + '" cx="0" cy="0"/>';
    var drumBub = '';
    for (i = 0; i < 14; i++) drumBub += '<circle class="en-bubble" r="1.8" cx="0" cy="0"/>';
    var ticks = [[PRM.LSHH, 'HH', 'en-tick-hh'], [PRM.LAH, 'H', 'en-tick-h'], [0, 'N', 'en-tick'], [PRM.LAL, 'L', 'en-tick-h'], [PRM.LSLL, 'LL', 'en-tick-hh']]
      .map(function (t) { var y = yGlass(t[0]); return '<line class="' + t[2] + '" x1="290" y1="' + y + '" x2="298" y2="' + y + '"/><text class="en-ticklbl" x="301" y="' + (y + 3) + '">' + t[1] + '</text>'; }).join('');
    var puffs = function (id, n) { var s = '<g id="' + id + '">'; for (var k = 0; k < n; k++) s += '<circle class="en-puff" r="6" cx="0" cy="0" opacity="0"/>'; return s + '</g>'; };
    var smoke = '<g id="en-smoke">'; for (i = 0; i < 6; i++) smoke += '<circle class="en-smoke" r="7" cx="0" cy="0" opacity="0"/>'; smoke += '</g>';

    return '<svg class="zh-svg" id="en-svg" viewBox="0 -34 1000 660" role="img" aria-label="Synoptique : chaudière à tubes d’eau, ballon, alimentation en eau, brûleur">' +
      '<defs><linearGradient id="en-flame-g" x1="0" x2="1"><stop offset="0" stop-color="#e9c99c"/><stop offset=".55" stop-color="#d8a776"/><stop offset="1" stop-color="#c98f5f" stop-opacity=".2"/></linearGradient>' +
      '<clipPath id="en-drum-clip"><rect x="332" y="62" width="316" height="96" rx="48"/></clipPath>' +
      '<clipPath id="en-glass-clip"><rect x="273" y="' + GL.top + '" width="16" height="' + (GL.bot - GL.top) + '" rx="3"/></clipPath></defs>' +

      // --- cheminée et fumées
      '<rect class="zh-equip" x="150" y="-10" width="26" height="200"/>' + smoke +
      '<text class="en-small en-hide-sm" x="184" y="8">Cheminée</text>' +

      // --- enveloppe chaudière, foyer, faisceau
      '<rect class="zh-equip" x="110" y="190" width="560" height="305" rx="6"/>' +
      '<rect class="en-refractory" x="124" y="204" width="214" height="276" rx="3"/>' +
      '<text class="en-title en-hide-sm" x="134" y="222">FOYER</text>' +
      '<text class="en-title en-hide-sm" x="420" y="488">FAISCEAU VAPORISATEUR</text>' +
      risers +
      '<line class="en-downcomer" x1="606" y1="160" x2="606" y2="430"/><line class="en-downcomer" x1="622" y1="150" x2="622" y2="436"/>' +
      '<text class="en-small en-hide-sm" x="630" y="300" transform="rotate(90 630 300)">tubes de descente</text>' +
      '<g id="en-bubbles">' + bubbles + '</g>' +
      // ballon inférieur
      '<rect class="zh-equip" x="360" y="430" width="270" height="44" rx="22"/><rect class="en-water" x="363" y="433" width="264" height="38" rx="19"/>' +
      '<text class="en-small en-hide-sm" x="495" y="456" text-anchor="middle">ballon inférieur</text>' +

      // --- brûleur et flamme
      '<line class="zh-line" x1="0" y1="330" x2="64" y2="330"/>' +
      '<path id="en-fv" class="en-valve" d="M24,322 L24,338 L40,330 Z M56,322 L56,338 L40,330 Z"/>' +
      '<text class="en-small en-hide-sm" x="2" y="316">Gaz naturel</text>' +
      '<rect class="zh-equip-dark" x="64" y="314" width="48" height="32" rx="3"/>' +
      '<g id="en-flame-wrap" transform="translate(112 330)"><g id="en-flame" class="en-flame"><g class="en-flicker">' +
      '<path class="en-flame-outer" d="M0,0 C30,-34 120,-36 200,0 C120,36 30,34 0,0 Z"/>' +
      '<path class="en-flame-inner" d="M0,0 C24,-15 70,-16 110,0 C70,16 24,15 0,0 Z"/></g></g></g>' +
      vb('vb-br', 8, 352, 112, 'BR-101 allure', '%', 'pic', 'Allure du brûleur (sortie de PIC-101)') +
      '<text id="en-br-state" class="en-state" x="12" y="406">EN SERVICE</text>' +

      // --- ballon supérieur
      '<rect class="zh-equip" x="330" y="60" width="320" height="100" rx="50"/>' +
      '<g clip-path="url(#en-drum-clip)"><rect id="en-drum-water" class="en-water" x="330" y="110" width="320" height="60"/>' +
      '<line id="en-drum-surf" class="en-surface" x1="330" y1="110" x2="650" y2="110"/><g id="en-drum-bub">' + drumBub + '</g></g>' +
      '<text class="en-title" x="490" y="54" text-anchor="middle">BALLON B-101</text>' +
      '<line class="en-sig" x1="650" y1="96" x2="672" y2="96"/>' +

      // --- niveau à glace
      '<line class="zh-line zh-line--thin" x1="289" y1="70" x2="330" y2="70"/><line class="zh-line zh-line--thin" x1="289" y1="150" x2="336" y2="150"/>' +
      '<g id="vb-lg" class="en-click" data-fp="lic"><title>Niveau à glace LG-101 : niveau réel, relevé local</title>' +
      '<rect class="en-glass" x="272" y="' + (GL.top - 1) + '" width="18" height="' + (GL.bot - GL.top + 2) + '" rx="4"/>' +
      '<g clip-path="url(#en-glass-clip)"><rect id="en-glass-water" class="en-water-glass" x="273" y="110" width="16" height="80"/></g>' +
      ticks +
      '<g class="zh-almind"><rect x="262" y="' + (GL.top - 2) + '" width="7" height="7"/></g></g>' +
      '<text class="zh-tag" x="266" y="' + (GL.top + 2) + '" text-anchor="end">LG-101</text>' +
      '<text class="en-small" x="266" y="' + (GL.top + 15) + '" text-anchor="end">niveau</text>' +
      '<text class="en-small" x="266" y="' + (GL.top + 27) + '" text-anchor="end">à glace</text>' +
      '<text class="zh-val" id="en-lg-v" x="266" y="' + (GL.top + 52) + '" text-anchor="end" style="font-size:13px">0</text>' +
      '<text class="zh-unit" x="266" y="' + (GL.top + 64) + '" text-anchor="end">mm</text>' +

      // --- soupape PSV-101
      '<line class="zh-line zh-line--thin" x1="400" y1="60" x2="400" y2="34"/>' +
      '<path id="en-psv" class="en-valve" d="M393,34 L407,34 L400,24 Z M393,14 L407,14 L400,24 Z"/>' +
      '<line class="zh-line zh-line--thin" x1="400" y1="14" x2="400" y2="-6"/>' + puffs('en-psv-puffs', 8) +
      '<g id="vb-psv"><text class="zh-tag" x="360" y="22" text-anchor="end">PSV-101</text>' +
      '<g class="zh-almind"><rect x="364" y="14" width="8" height="8"/></g></g>' +

      // --- pression, vapeur
      vb('vb-pi', 440, -30, 136, 'PI-101 pression', 'bar', 'pic', 'Pression du ballon (PIC-101)') +
      '<text class="zh-sp en-state" id="en-pi-sp" x="446" y="20">SP 12,0</text>' +
      '<line class="en-sig" x1="508" y1="8" x2="508" y2="60"/>' +
      '<path class="zh-line" d="M600,60 V22 H862"/><path id="en-steam-flow" class="en-flow" d="M600,60 V22 H862"/>' +
      '<line class="zh-line zh-line--thin" x1="700" y1="14" x2="700" y2="30"/><line class="zh-line zh-line--thin" x1="706" y1="14" x2="706" y2="30"/>' +
      vb('vb-fi102', 648, 32, 130, 'FI-102 vapeur', 't/h', 'lic', 'Débit vapeur vers les usagers') +
      // usagers
      '<g id="en-users" class="en-click" data-fp="users"><rect class="zh-equip" x="862" y="-4" width="132" height="70" rx="4"/>' +
      '<text class="en-title" x="928" y="12" text-anchor="middle">USAGERS</text>' +
      '<text class="en-small" x="870" y="30">demande</text><text class="zh-val" id="en-dem-v" x="986" y="32" text-anchor="end" style="font-size:13px">20,0</text>' +
      '<text class="en-small" x="870" y="46">t/h</text>' +
      '<text class="en-state" id="en-delest" x="870" y="60"></text></g>' +
      puffs('en-user-puffs', 6) +

      // --- alimentation en eau
      '<path class="zh-line" d="M650,130 H740 V600 H920"/><path id="en-feed-flow" class="en-flow" d="M920,600 H740 V130 H650"/>' +
      '<path class="zh-line zh-line--thin" d="M740,352 H704 V248 H740"/>' +
      '<path id="en-hv102" class="en-valve" d="M696,288 L712,288 L704,300 Z M696,312 L712,312 L704,300 Z"/>' +
      '<text class="zh-tag en-hide-sm" x="698" y="240" text-anchor="end">HV-102</text>' +
      '<text class="en-small en-hide-sm" x="698" y="252" text-anchor="end">by-pass</text>' +
      '<text class="zh-val" id="en-hv102-v" x="698" y="370" text-anchor="end" style="font-size:12px">0 %</text>' +
      '<g class="en-click" data-fp="feed"><path id="en-lv101" class="en-valve" d="M732,288 L748,288 L740,300 Z M732,312 L748,312 L740,300 Z"/>' +
      '<line class="zh-line zh-line--thin" x1="740" y1="300" x2="756" y2="300"/><path class="en-valve" d="M756,292 a8,8 0 0 1 0,16 Z"/></g>' +
      vb('vb-lv', 768, 262, 132, 'LV-101 position', '%', 'feed', 'Vanne alimentaire : position réelle (recopie)') +
      '<text class="en-state" id="en-lv-cmd" x="774" y="314">commande 65 %</text>' +
      '<line class="zh-line zh-line--thin" x1="734" y1="420" x2="746" y2="420"/><line class="zh-line zh-line--thin" x1="734" y1="426" x2="746" y2="426"/>' +
      vb('vb-fi103', 768, 400, 132, 'FI-103 eau', 't/h', 'feed', 'Débit d’eau alimentaire') +
      vb('vb-li', 672, 74, 140, 'LI-101 niveau', 'mm', 'lic', 'Niveau du ballon mesuré par le transmetteur (régulation)') +
      // bâche alimentaire
      '<rect class="zh-equip" x="790" y="470" width="190" height="54" rx="27"/><rect class="en-water" x="793" y="492" width="184" height="29" rx="14"/>' +
      '<text class="en-small en-hide-sm" x="885" y="463" text-anchor="middle">bâche alimentaire 105 °C</text>' +
      '<line class="zh-line" x1="830" y1="524" x2="830" y2="556"/><line class="zh-line" x1="930" y1="524" x2="930" y2="556"/>' +
      '<g id="en-pa" class="en-click" data-fp="feed"><circle class="en-pump zh-stop" id="en-pa-c" cx="830" cy="574" r="17"/><path id="en-pa-imp" d="M821,566 L841,574 L821,582 Z" fill="#fff" stroke="#5f666d" stroke-width="1.2"/>' +
      '<g class="zh-almind"><rect x="848" y="556" width="8" height="8"/></g></g>' +
      '<g id="en-pb" class="en-click" data-fp="feed"><circle class="en-pump zh-stop" id="en-pb-c" cx="930" cy="574" r="17"/><path id="en-pb-imp" d="M921,566 L941,574 L921,582 Z" fill="#fff" stroke="#5f666d" stroke-width="1.2"/></g>' +
      '<line class="zh-line" x1="830" y1="591" x2="830" y2="600"/><line class="zh-line" x1="930" y1="591" x2="930" y2="600"/>' +
      '<text class="zh-tag" x="808" y="560" text-anchor="end">P-101A</text><text class="en-state" id="en-pa-s" x="808" y="572" text-anchor="end">MARCHE</text>' +
      '<text class="zh-tag" x="956" y="560">P-101B</text><text class="en-state" id="en-pb-s" x="956" y="572">ARRÊT</text>' +

      // --- purge de fond
      '<path class="zh-line zh-line--thin" d="M495,474 V548 H292"/>' +
      '<g class="en-click" data-fp="users"><path id="en-hv103" class="en-valve" d="M398,540 L398,556 L410,548 Z M422,540 L422,556 L410,548 Z"/></g>' +
      '<text class="zh-tag en-hide-sm" x="410" y="574" text-anchor="middle">HV-103 purge de fond</text>' +
      '<rect class="zh-equip" x="232" y="520" width="60" height="56" rx="10"/>' +
      '<text class="en-small en-hide-sm" x="262" y="592" text-anchor="middle">ballon de détente</text>' +
      puffs('en-purge-puffs', 6) +
      '</svg>';
  }

  /* ------------------------------------------------------------ faceplates */
  function seg(name, opts) {
    return '<div class="en-seg" role="group" data-seg="' + name + '">' + opts.map(function (o) {
      return '<button type="button" data-act="' + name + '" data-v="' + o[0] + '">' + o[1] + '</button>';
    }).join('') + '</div>';
  }
  function buildPanel() {
    return '' +
      // LIC-101
      '<div class="zh-fp en-fp" id="fp-lic"><div class="zh-fp-h"><span class="zh-fp-tag">LIC-101</span><span class="zh-fp-title">Niveau du ballon</span>' + seg('licMode', [['AUTO', 'AUTO'], ['MAN', 'MAN']]) + '</div>' +
      '<div class="zh-fp-row"><span class="zh-lbl">Mesure LI-101 (<span data-r="ltsel">A</span>)</span><span class="zh-v" data-r="lic-pv">0 mm</span></div>' +
      '<div class="zh-fp-row"><span class="zh-lbl">Consigne</span><span class="en-step"><button type="button" data-act="licSpD" data-v="-10">−</button><span class="zh-v zh-sp" data-r="lic-sp">0 mm</span><button type="button" data-act="licSpD" data-v="10">+</button></span></div>' +
      '<div class="zh-fp-row"><span class="zh-lbl">Sortie vers LV-101</span><span class="zh-v" data-r="lic-out">65 %</span></div>' +
      '<div class="zh-bar"><i data-r="lic-bar" style="width:65%"></i></div>' +
      '<div class="en-man" data-r="lic-man" hidden><div class="en-step" style="margin-top:6px;justify-content:space-between">' +
      '<button type="button" data-act="licOutD" data-v="-10">−10</button><button type="button" data-act="licOutD" data-v="-2">−2</button>' +
      '<button type="button" data-act="licOutD" data-v="2">+2</button><button type="button" data-act="licOutD" data-v="10">+10</button></div>' +
      '<input type="range" min="0" max="100" step="1" data-act="licOut" aria-label="Ouverture manuelle LV-101"></div>' +
      '<div class="en-fp-sub">Structure de régulation</div>' +
      '<div class="zh-fp-row">' + seg('structure', [['1', '1 élément'], ['3', '3 éléments']]) + '<span class="zh-hint" data-r="struct-h">niveau seul</span></div>' +
      '<div class="en-cmp" data-r="fic" hidden><span>FIC-103 consigne</span><span></span><span class="zh-v zh-sp zh-mono" data-r="fic-sp">20,0 t/h</span>' +
      '<span>vapeur / eau</span><span></span><span class="zh-mono" data-r="fic-pv">20,0 / 20,0</span></div>' +
      '<div class="en-fp-sub">Transmetteurs de niveau</div>' +
      '<div class="zh-fp-row"><span class="zh-lbl">LT-101A <b class="zh-mono" data-r="lta">0</b> · LT-101B <b class="zh-mono" data-r="ltb">0</b> mm</span>' + seg('ltSel', [['A', 'A'], ['B', 'B']]) + '</div>' +
      '</div>' +

      // PIC-101
      '<div class="zh-fp en-fp" id="fp-pic"><div class="zh-fp-h"><span class="zh-fp-tag">PIC-101</span><span class="zh-fp-title">Pression → brûleur</span>' + seg('picMode', [['AUTO', 'AUTO'], ['MAN', 'MAN']]) + '</div>' +
      '<div class="zh-fp-row"><span class="zh-lbl">Mesure PI-101</span><span class="zh-v" data-r="pic-pv">12,00 bar</span></div>' +
      '<div class="zh-fp-row"><span class="zh-lbl">Consigne</span><span class="en-step"><button type="button" data-act="picSpD" data-v="-0.2">−</button><span class="zh-v zh-sp" data-r="pic-sp">12,0 bar</span><button type="button" data-act="picSpD" data-v="0.2">+</button></span></div>' +
      '<div class="zh-fp-row"><span class="zh-lbl">Allure brûleur</span><span class="zh-v" data-r="pic-out">77 %</span></div>' +
      '<div class="zh-bar"><i data-r="pic-bar" style="width:77%"></i></div>' +
      '<div class="en-man" data-r="pic-man" hidden><div class="en-step" style="margin-top:6px;justify-content:space-between">' +
      '<button type="button" data-act="picOutD" data-v="-10">−10</button><button type="button" data-act="picOutD" data-v="-2">−2</button>' +
      '<button type="button" data-act="picOutD" data-v="2">+2</button><button type="button" data-act="picOutD" data-v="10">+10</button></div></div>' +
      '</div>' +

      // Alimentation
      '<div class="zh-fp en-fp" id="fp-feed"><div class="zh-fp-h"><span class="zh-fp-tag">EAU ALIMENTAIRE</span><span class="zh-fp-title">pompes et vannes</span></div>' +
      '<div class="zh-fp-row"><span class="zh-lbl">P-101A (service)</span><span class="zh-state" data-r="pa">MARCHE</span></div>' +
      '<div class="zh-fp-row"><span class="zh-lbl">P-101B (secours)</span><span class="zh-state" data-r="pb">ARRÊT</span></div>' +
      '<div class="en-row-btns"><button type="button" class="zh-btn" data-act="startB">Démarrer P-101B</button><button type="button" class="zh-btn" data-act="stopB">Arrêter P-101B</button></div>' +
      '<div class="zh-fp-row" style="margin-top:6px"><span class="zh-lbl">LV-101 commande / position</span><span class="zh-v" data-r="lv">65 / 65 %</span></div>' +
      '<div class="zh-fp-row"><span class="zh-lbl">By-pass manuel HV-102</span><span class="zh-v" data-r="hv102">0 %</span></div>' +
      '<input type="range" min="0" max="100" step="5" value="0" data-act="bypass" aria-label="Ouverture du by-pass HV-102">' +
      '</div>' +

      // Usagers et purge
      '<div class="zh-fp en-fp" id="fp-users"><div class="zh-fp-h"><span class="zh-fp-tag">USAGERS · PURGE</span><span class="zh-fp-title">charge de la chaudière</span></div>' +
      '<div class="zh-fp-row"><span class="zh-lbl">Demande / vapeur livrée</span><span class="zh-v" data-r="dem">20,0 / 20,0 t/h</span></div>' +
      '<div class="en-row-btns"><button type="button" class="zh-btn" data-act="delest" aria-pressed="false">Délester (−25 %)</button>' +
      '<button type="button" class="zh-btn" data-act="purge" aria-pressed="false">Purge de fond</button></div>' +
      '<p class="zh-hint">Délestage : coupe les usagers non prioritaires. Purge : évacue de l’eau du ballon inférieur (≈ 9 t/h).</p>' +
      '</div>' +

      // Sécurité brûleur
      '<div class="zh-fp zh-fp--sticky en-fp" id="fp-bms"><div class="zh-fp-h"><span class="zh-fp-tag">BMS · BRÛLEUR</span><span class="zh-state zh-state--on" data-r="bms">EN SERVICE</span></div>' +
      '<div class="en-row-btns"><button type="button" class="zh-btn zh-btn--danger en-esd" data-act="esd">Arrêt d’urgence</button>' +
      '<button type="button" class="zh-btn" data-act="reset">Réarmer</button></div>' +
      '<p class="zh-hint" data-r="bms-h">Niveau très bas (LSLL −180 mm) : déclenchement automatique. Réarmement possible quand le niveau est revenu entre −150 et +150 mm.</p>' +
      '</div>';
  }

  function buildKPIs() {
    var k = [['k-li', 'Niveau LI-101', 'mm'], ['k-lg', 'Niveau à glace', 'mm'], ['k-p', 'Pression', 'bar'], ['k-ws', 'Vapeur', 't/h'], ['k-wf', 'Eau alim.', 't/h'], ['k-br', 'Brûleur', '%']];
    return k.map(function (x) { return '<div class="en-kpi" id="' + x[0] + '">' + x[1] + '<b><span>---</span><small>' + x[2] + '</small></b></div>'; }).join('');
  }

  /* ------------------------------------------------------------ montage */
  $('#en-syn').innerHTML = buildSVG() + '<span class="zh-syn-hint">↔ Faites glisser le synoptique · touchez un équipement pour ses commandes</span>';
  $('#zh-panel').innerHTML = buildPanel();
  $('#en-kpis').innerHTML = buildKPIs();

  var svg = $('#en-svg');
  var R = {};  // références SVG
  ['vb-br-v', 'vb-pi-v', 'vb-fi102-v', 'vb-fi103-v', 'vb-lv-v', 'vb-li-v', 'en-lg-v', 'en-pi-sp', 'en-dem-v', 'en-delest', 'en-lv-cmd', 'en-hv102-v',
    'en-drum-water', 'en-drum-surf', 'en-glass-water', 'en-flame', 'en-flame-wrap', 'en-br-state', 'en-pa-c', 'en-pb-c', 'en-pa-imp', 'en-pb-imp', 'en-pa-s', 'en-pb-s',
    'en-psv', 'en-hv103', 'en-hv102', 'en-lv101', 'en-steam-flow', 'en-feed-flow', 'en-fv'].forEach(function (id) { R[id] = document.getElementById(id); });
  var bubbles = Array.prototype.slice.call(document.querySelectorAll('#en-bubbles circle')).map(function (c, i) { return { el: c, x: 376 + (i % 14) * 15, y: 160 + ((i * 53) % 270), v: 0.6 + (i % 5) * 0.15 }; });
  var drumBub = Array.prototype.slice.call(document.querySelectorAll('#en-drum-bub circle')).map(function (c, i) { return { el: c, x: 350 + i * 21, ph: i * 0.7 }; });
  function puffSet(id, x, y, dx) {
    return { x: x, y: y, dx: dx, p: Array.prototype.slice.call(document.querySelectorAll('#' + id + ' circle')).map(function (c, i, a) { return { el: c, age: i / a.length }; }) };
  }
  var PUFF = { psv: puffSet('en-psv-puffs', 400, -6, 6), users: puffSet('en-user-puffs', 976, -6, 10), purge: puffSet('en-purge-puffs', 262, 516, 4) };
  var smoke = Array.prototype.slice.call(document.querySelectorAll('#en-smoke circle')).map(function (c, i, a) { return { el: c, age: i / a.length }; });

  var P = function (r) { return $('[data-r="' + r + '"]', $('#zh-panel')); };

  /* ------------------------------------------------------------ noyau commun */
  var clock = new Z.Clock({ dt: 0.1, speed: 10, speeds: [1, 5, 10], step: step, render: function () { if (!app.replaying) render(app.model.view(), true); } });
  clock.bindUI({ clock: $('#en-clock'), speed: $('#en-speed'), pause: $('#en-pause') });
  var rec = new Z.Recorder({ clock: clock, every: 1 });
  var alarms = new Z.Alarms({ container: '#en-alarms', clock: clock, recorder: rec, onChange: syncDrawerDot });
  var A = [
    ['LSLL', 'LSLL-101', 'Niveau très bas : brûleur déclenché', 1, ['#vb-lg', '#k-lg']],
    ['LSHH', 'LSHH-101', 'Niveau très haut : risque de primage', 1, ['#vb-lg', '#k-lg']],
    ['PUMPA', 'P-101A', 'Pompe alimentaire déclenchée (défaut moteur)', 1, ['#en-pa']],
    ['BURNER', 'BS-101', 'Brûleur à l’arrêt', 1, ['#vb-br', '#k-br']],
    ['PSV', 'PSV-101', 'Soupape de sûreté ouverte', 1, ['#vb-psv', '#vb-pi']],
    ['LAL', 'LI-101', 'Niveau bas', 2, ['#vb-li', '#k-li']],
    ['LAH', 'LI-101', 'Niveau haut', 2, ['#vb-li', '#k-li']],
    ['PAL', 'PI-101', 'Pression vapeur basse', 2, ['#vb-pi', '#k-p']],
    ['PAH', 'PI-101', 'Pression vapeur haute', 2, ['#vb-pi', '#k-p']],
    ['FAL', 'FI-103', 'Débit d’eau alimentaire bas', 2, ['#vb-fi103', '#k-wf']],
    ['LDEV', 'LI-101', 'Écart entre LT-101A et LT-101B', 2, ['#vb-li']],
    ['ZDEV', 'LV-101', 'Écart commande / position de vanne', 2, ['#vb-lv']],
    ['FROC', 'FI-102', 'Hausse rapide du débit vapeur', 3, ['#vb-fi102', '#k-ws']]
  ];
  A.forEach(function (a) { alarms.define(a[0], { tag: a[1], label: a[2], priority: a[3], targets: a[4] }); });

  var trend1 = new Z.Trend('#en-tr1', {
    window: 600, legend: '#en-lg1',
    series: [{ key: 'L', label: 'LI-101 niveau (mm)', color: '#1d2329', width: 2 }, { key: 'Lg', label: 'niveau à glace (mm)', color: '#8a9096', dash: [5, 4], width: 1.6 },
      { key: 'P', label: 'pression (bar, axe droit)', color: '#2f6fdf', axis: 'y2', width: 1.6 }],
    y: { min: -300, max: 300, unit: 'mm' }, y2: { min: 8, max: 14, unit: 'bar' },
    limits: [{ value: PRM.LSHH, color: '#d0021b' }, { value: PRM.LAH, color: '#f5a623' }, { value: PRM.LAL, color: '#f5a623' }, { value: PRM.LSLL, color: '#d0021b' }]
  });
  var trend2 = new Z.Trend('#en-tr2', {
    window: 600, legend: '#en-lg2',
    series: [{ key: 'Ws', label: 'vapeur FI-102 (t/h)', color: '#1d2329', width: 2 }, { key: 'Wf', label: 'eau FI-103 (t/h)', color: '#5f666d', dash: [6, 4], width: 2 },
      { key: 'fire', label: 'allure brûleur (%, axe droit)', color: '#00a3a1', axis: 'y2', width: 1.4 }],
    y: { min: 0, max: 40, unit: 't/h' }, y2: { min: 0, max: 100, unit: '%' }
  });

  var trainer = new Z.Trainer({
    clock: clock, recorder: rec,
    faults: [],
    onNote: function (v) { trend1.mark(clock.t, v, 'note'); },
    extra: function (el) {
      var b = U.el('button', { type: 'button', class: 'zh-btn' }, 'Révéler la panne mystère');
      b.addEventListener('click', function () {
        if (!app.model) return;
        var m = app.scn === 'c' ? (app.model.mystery === 'lt' ? 'Transmetteur LT-101A figé' : 'Vanne LV-101 grippée') : 'Pas de panne cachée dans ce scénario';
        Z.toast('Panne mystère : <b>' + m + '</b>' + (app.scn === 'c' && !app.model.incident ? ' (pas encore injectée)' : ''), 'note', 3500);
      });
      el.appendChild(b);
    }
  });
  function trainerFaults() {
    return [
      { id: 'steam40', label: 'Appel de vapeur +40 %', inject: function () { app.model.inject('steam40'); } },
      { id: 'steamDrop', label: 'Chute de la demande −40 %', inject: function () { app.model.inject('steamDrop'); } },
      { id: 'pumpA', label: 'Déclenchement pompe P-101A', inject: function () { app.model.inject('pumpA'); } },
      { id: 'ltFreeze', label: 'Transmetteur LT-101A figé', inject: function () { app.model.inject('ltFreeze'); } },
      { id: 'valveStuck', label: 'Vanne LV-101 grippée', inject: function () { app.model.inject('valveStuck'); } }
    ];
  }
  Z.drawer('#zh-panel', '#en-drawer-btn');
  function syncDrawerDot() { var b = $('#en-drawer-btn'); if (b) b.classList.toggle('zh-has-alarm', alarms.unackCount() > 0); }

  /* ------------------------------------------------------------ boucle */
  function step(dt) {
    var m = app.model; if (!m || app.ended) return;
    m.step(dt);
    var s = m.s, t = clock.t + dt;
    // événements du modèle -> journal + messages
    while (m.events.length) {
      var e = m.events.shift();
      if (e.type === 'incident') {
        rec.event('incident', e.hidden ? 'Panne cachée : ' + e.label : e.label);
        trend1.mark(t, e.label, 'incident'); trend2.mark(t, e.label, 'incident');
        if (!e.hidden) Z.toast(e.label, 'alarm', 3000);
      } else if (e.type === 'trip') {
        rec.event('outcome', e.label); Z.toast('<b>Déclenchement</b> : ' + U.esc(e.label), 'alarm', 4000);
      } else { rec.event('info', e.label); Z.toast(U.esc(e.label), 'info', 2600); }
    }
    // alarmes
    var Lm = s.Lmeas;
    alarms.limit('LAH', Lm, PRM.LAH, 'H', 8, U.fmt(Lm, 0) + ' mm');
    alarms.limit('LAL', Lm, PRM.LAL, 'L', 8, U.fmt(Lm, 0) + ' mm');
    alarms.limit('LSHH', s.L, PRM.LSHH, 'H', 10, U.fmt(s.L, 0) + ' mm');
    alarms.set('LSLL', s.burner === 'trip' && m.flags.lsll && s.L < PRM.LSLL + 30, U.fmt(s.L, 0) + ' mm');
    alarms.limit('PAL', s.P, PRM.PAL, 'L', 0.1, U.fmt(s.P, 2) + ' bar');
    alarms.limit('PAH', s.P, PRM.PAH, 'H', 0.1, U.fmt(s.P, 2) + ' bar');
    alarms.set('PSV', s.psv);
    alarms.set('PUMPA', s.pumpA === 'fault');
    alarms.set('BURNER', s.burner !== 'on', s.burner === 'prepurge' ? 'prébalayage' : '');
    alarms.set('FAL', s.Wf < 1.0 && s.burner === 'on' && Lm < 60, U.fmt(s.Wf * TH, 1) + ' t/h');
    app.timers.ldev = Math.abs(s.ltA - s.ltB) > 30 ? app.timers.ldev + dt : 0;
    alarms.set('LDEV', app.timers.ldev > 20, U.fmt(s.ltA, 0) + ' / ' + U.fmt(s.ltB, 0) + ' mm');
    app.timers.zdev = Math.abs(m.lic.out - s.x * 100) > 8 ? app.timers.zdev + dt : 0;
    alarms.set('ZDEV', app.timers.zdev > 15, U.fmt(m.lic.out, 0) + ' / ' + U.fmt(s.x * 100, 0) + ' %');
    app.WsSlow += (s.Ws - app.WsSlow) * Math.min(1, dt / 60);
    alarms.set('FROC', s.Ws - app.WsSlow > 1.0, U.fmt(s.Ws * TH, 1) + ' t/h');
    // enregistrement (1 s) : tendances + instantanés pour le rejeu
    var n0 = rec.samples.length;
    rec.tick(t, { L: Lm, Lg: s.L, P: s.P, Ws: s.Ws * TH, Wf: s.Wf * TH, fire: s.fire }, function () { return m.view(); });
    if (rec.samples.length > n0) { var smp = rec.samples[rec.samples.length - 1]; trend1.push(smp.t, smp); trend2.push(smp.t, smp); }
    if (t >= DURATION) finish('time');
  }

  /* ------------------------------------------------------------ rendu */
  var f = function (v, d) { return U.fmt(v, d).replace('.', ','); };
  function setText(el, txt) { if (el && el._t !== txt) { el._t = txt; el.textContent = txt; } }
  function render(v, live) {
    var now = performance.now(), dtA = app.animT ? Math.min(0.1, (now - app.animT) / 1000) : 0; app.animT = now;
    var halted = live && clock.isHalted();
    if (halted) dtA = 0;
    // valeurs
    setText(R['vb-li-v'], f(v.Lmeas, 0)); setText(R['en-lg-v'], f(v.L, 0));
    setText(R['vb-pi-v'], f(v.P, 2)); setText(R['en-pi-sp'], 'SP ' + f(v.picSp, 1) + (v.picMode === 'MAN' ? ' · MAN' : ''));
    setText(R['vb-fi102-v'], f(v.Ws * TH, 1)); setText(R['vb-fi103-v'], f(v.Wf * TH, 1));
    setText(R['vb-lv-v'], f(v.x * 100, 0)); setText(R['en-lv-cmd'], 'commande ' + f(v.cmd, 0) + ' %' + (v.licMode === 'MAN' ? ' · MAN' : ''));
    setText(R['vb-br-v'], f(v.fire, 0)); setText(R['en-hv102-v'], f(v.bypass * 100, 0) + ' %');
    setText(R['en-dem-v'], f(v.D * TH, 1));
    setText(R['en-delest'], v.delest ? 'DÉLESTAGE −25 %' : '');
    var bst = { on: 'EN SERVICE', trip: 'DÉCLENCHÉ', prepurge: 'PRÉBALAYAGE ' + Math.max(0, Math.ceil(30 - v.prepurge)) + ' s' }[v.burner];
    setText(R['en-br-state'], bst); R['en-br-state'].setAttribute('class', 'en-state' + (v.burner === 'trip' ? ' en-state-bad' : ''));
    // ballon et niveau à glace
    var yd = yDrum(v.L); R['en-drum-water'].setAttribute('y', yd); R['en-drum-surf'].setAttribute('y1', yd); R['en-drum-surf'].setAttribute('y2', yd);
    var yg = yGlass(v.L); R['en-glass-water'].setAttribute('y', yg); R['en-glass-water'].setAttribute('height', Math.max(0, GL.bot + 4 - yg));
    // flamme
    var fs = v.burner === 'on' || v.fire > 1 ? 0.25 + 0.75 * v.fire / 100 : 0;
    R['en-flame'].setAttribute('transform', 'scale(' + fs.toFixed(3) + ' ' + (0.45 + 0.55 * fs).toFixed(3) + ')');
    R['en-flame'].style.opacity = fs > 0 ? 1 : 0;
    R['en-fv'].setAttribute('class', 'en-valve' + (v.fire > 1 ? ' en-open' : ''));
    // pompes
    pump('a', v.pumpA, v.spA, dtA); pump('b', v.pumpB, v.spB, dtA);
    // vannes
    R['en-psv'].setAttribute('class', 'en-valve' + (v.psv ? ' en-open' : ''));
    R['en-hv103'].setAttribute('class', 'en-valve' + (v.purge ? ' en-open' : ''));
    R['en-hv102'].setAttribute('class', 'en-valve' + (v.bypass > 0.01 ? ' en-open' : ''));
    R['en-lv101'].setAttribute('class', 'en-valve' + (v.x > 0.02 ? ' en-open' : ''));
    // écoulements (tirets animés, vitesse proportionnelle au débit)
    app.offS = ((app.offS || 0) - dtA * 14 * v.Ws) % 1000; R['en-steam-flow'].style.strokeDashoffset = app.offS;
    R['en-steam-flow'].style.opacity = v.Ws > 0.05 ? 1 : 0;
    app.offF = ((app.offF || 0) - dtA * 14 * v.Wf) % 1000; R['en-feed-flow'].style.strokeDashoffset = app.offF;
    R['en-feed-flow'].style.opacity = v.Wf > 0.05 ? 1 : 0;
    // bulles dans les tubes vaporisateurs (densité et vitesse selon la chaleur reçue)
    var heat = v.Q / PRM.Qmax, nb = Math.round(36 * U.clamp(heat * 1.3, 0, 1));
    bubbles.forEach(function (b, i) {
      if (i >= nb) { b.el.style.display = 'none'; return; }
      b.el.style.display = '';
      b.y -= dtA * (40 + 90 * heat) * b.v; if (b.y < 165) b.y = 425;
      b.el.setAttribute('cx', b.x); b.el.setAttribute('cy', b.y.toFixed(1));
    });
    app.ph = (app.ph || 0) + dtA * 3;
    var vbRel = U.clamp(v.Vb / 0.5, 0, 3);
    drumBub.forEach(function (b, i) {
      var show = i < Math.round(4 + 3 * vbRel);
      b.el.style.display = show ? '' : 'none'; if (!show) return;
      b.el.setAttribute('cx', b.x + Math.sin(app.ph + b.ph) * 4);
      b.el.setAttribute('cy', (yd + 6 + ((i * 7 + app.ph * 9) % 22)).toFixed(1));
    });
    // panaches
    puffs(PUFF.psv, v.psv ? 1 : 0, dtA, 1.4);
    puffs(PUFF.users, U.clamp(v.Wusers / PRM.Wnom, 0, 1.6) * 0.6, dtA, 0.7);
    puffs(PUFF.purge, v.purge ? 0.9 : 0, dtA, 0.9);
    smoke.forEach(function (p) {
      p.age += dtA * 0.35; if (p.age > 1) p.age -= 1;
      var on = v.fire > 1;
      p.el.setAttribute('cx', (163 + p.age * 26).toFixed(1)); p.el.setAttribute('cy', (-14 - p.age * 24).toFixed(1));
      p.el.setAttribute('r', (5 + p.age * 9).toFixed(1)); p.el.setAttribute('opacity', on ? ((1 - p.age) * 0.5 * (0.3 + v.fire / 140)).toFixed(2) : 0);
    });
    renderPanel(v);
    renderKPI(v);
    if (live) { alarms.render(); trend1.draw(); trend2.draw(); }
  }
  function pump(k, st, sp, dtA) {
    var c = R['en-p' + k + '-c'], imp = R['en-p' + k + '-imp'];
    c.setAttribute('class', 'en-pump ' + (st === 'run' ? 'zh-run' : 'zh-stop') + (st === 'fault' ? ' en-fault' : ''));
    imp.setAttribute('fill', st === 'run' ? '#eef0f1' : '#fff');
    setText(R['en-p' + k + '-s'], { run: 'MARCHE', stop: 'ARRÊT', fault: 'DÉFAUT', starting: 'DÉMARRAGE' }[st]);
    R['en-p' + k + '-s'].setAttribute('class', 'en-state' + (st === 'fault' ? ' en-state-bad' : ''));
  }
  function puffs(set, intensity, dtA, speed) {
    set.p.forEach(function (p, i) {
      p.age += dtA * speed * 0.5; if (p.age > 1) p.age -= 1;
      var a = p.age;
      p.el.setAttribute('cx', (set.x + Math.sin(i * 1.7 + a * 3) * 3 + a * set.dx).toFixed(1));
      p.el.setAttribute('cy', (set.y - a * 30).toFixed(1));
      p.el.setAttribute('r', (3 + a * 9 * (0.5 + intensity)).toFixed(1));
      p.el.setAttribute('opacity', (intensity > 0.02 ? (1 - a) * Math.min(1, intensity) * 0.9 : 0).toFixed(2));
    });
  }
  function segSet(name, val) {
    Array.prototype.forEach.call(document.querySelectorAll('[data-seg="' + name + '"] button'), function (b) { b.setAttribute('aria-pressed', String(b.getAttribute('data-v') === String(val))); });
  }
  function renderPanel(v) {
    segSet('licMode', v.licMode); segSet('structure', v.structure); segSet('ltSel', v.ltSel); segSet('picMode', v.picMode);
    setText(P('ltsel'), v.ltSel);
    setText(P('lic-pv'), f(v.Lmeas, 0) + ' mm'); setText(P('lic-sp'), f(v.licSp, 0) + ' mm');
    setText(P('lic-out'), f(v.cmd, 0) + ' %'); P('lic-bar').style.width = U.clamp(v.cmd, 0, 100) + '%';
    P('lic-man').hidden = v.licMode !== 'MAN';
    var rng = $('[data-act="licOut"]'); if (document.activeElement !== rng) rng.value = Math.round(v.cmd);
    setText(P('struct-h'), v.structure === 3 ? 'niveau + vapeur + eau' : 'niveau seul');
    P('fic').hidden = v.structure !== 3;
    setText(P('fic-sp'), f(v.Fsp * TH, 1) + ' t/h'); setText(P('fic-pv'), f(v.Ws * TH, 1) + ' / ' + f(v.Wf * TH, 1));
    setText(P('lta'), f(v.ltA, 0)); setText(P('ltb'), f(v.ltB, 0));
    setText(P('pic-pv'), f(v.P, 2) + ' bar'); setText(P('pic-sp'), f(v.picSp, 1) + ' bar');
    setText(P('pic-out'), f(v.fire, 0) + ' %'); P('pic-bar').style.width = U.clamp(v.fire, 0, 100) + '%';
    P('pic-man').hidden = v.picMode !== 'MAN';
    stateBadge(P('pa'), v.pumpA); stateBadge(P('pb'), v.pumpB);
    setText(P('lv'), f(v.cmd, 0) + ' / ' + f(v.x * 100, 0) + ' %');
    setText(P('hv102'), f(v.bypass * 100, 0) + ' %');
    var bp = $('[data-act="bypass"]'); if (document.activeElement !== bp) bp.value = Math.round(v.bypass * 100);
    setText(P('dem'), f(v.D * (v.delest ? 1 - PRM.delest : 1) * TH, 1) + ' / ' + f(v.Wusers * TH, 1) + ' t/h');
    $('[data-act="delest"]').setAttribute('aria-pressed', String(v.delest));
    $('[data-act="purge"]').setAttribute('aria-pressed', String(v.purge));
    $('[data-act="startB"]').disabled = v.pumpB !== 'stop';
    $('[data-act="stopB"]').disabled = v.pumpB === 'stop';
    var bms = P('bms');
    setText(bms, { on: 'EN SERVICE', trip: 'DÉCLENCHÉ', prepurge: 'PRÉBALAYAGE' }[v.burner]);
    bms.className = 'zh-state ' + (v.burner === 'on' ? 'zh-state--on' : v.burner === 'trip' ? 'zh-state--fault' : 'zh-state--warn');
    $('[data-act="reset"]').disabled = !(v.burner === 'trip' && v.L > -150 && v.L < 150);
    $('[data-act="esd"]').disabled = v.burner === 'trip';
  }
  function stateBadge(el, st) {
    setText(el, { run: 'MARCHE', stop: 'ARRÊT', fault: 'DÉFAUT', starting: 'DÉMARRAGE' }[st]);
    el.className = 'zh-state ' + (st === 'run' ? 'zh-state--on' : st === 'fault' ? 'zh-state--fault' : st === 'starting' ? 'zh-state--warn' : '');
  }
  function renderKPI(v) {
    var set = function (id, txt) { var s = document.querySelector('#' + id + ' span'); setText(s, txt); };
    set('k-li', f(v.Lmeas, 0)); set('k-lg', f(v.L, 0)); set('k-p', f(v.P, 2)); set('k-ws', f(v.Ws * TH, 1)); set('k-wf', f(v.Wf * TH, 1)); set('k-br', f(v.fire, 0));
  }

  /* ------------------------------------------------------------ commandes */
  function act(type, v, silent) {
    var m = app.model; if (!m || app.ended || app.replaying) return;
    var view = m.view(), lbl = m.act(type, v);
    if (!lbl) return;
    if (!silent) {
      rec.event('action', lbl);
      trend1.mark(clock.t, lbl, 'action'); trend2.mark(clock.t, lbl, 'action');
    }
    judge(type, v, view);
    render(m.view(), true);
  }
  /** Pertinence des actions pour la note de réactivité, et détection des mauvais réflexes. */
  function judge(type, v, before) {
    var m = app.model, inc = m.incident; if (inc === null) return;
    var ok = false, scn = app.scn, kind = scn === 'c' ? m.mystery : scn;
    if (m.injectedByTrainer) ok = true;
    else if (kind === 'a') ok = (type === 'structure' && v === 3) || type === 'delest' || (type === 'licOut' && v > before.cmd + 3);
    else if (kind === 'b') ok = type === 'startB' || type === 'delest';
    else if (kind === 'lt') ok = (type === 'ltSel' && v === 'B') || (type === 'licMode' && v === 'MAN') || (type === 'structure' && v === 3);
    else if (kind === 'valve') ok = (type === 'bypass' && v > 0) || type === 'delest';
    if (ok && app.firstRelevant === null) app.firstRelevant = clock.t;
    // mauvais réflexes
    if (kind === 'a' && clock.t - inc < 240) {
      if (type === 'licOut' && v < before.cmd - 3) note('Réduction manuelle de l’eau alimentaire pendant le gonflement');
      if (type === 'purge' && v) note('Purge ouverte pendant le gonflement (le niveau apparent n’est pas de l’eau en trop)');
    }
    if (type === 'esd') note('Arrêt d’urgence du brûleur : sûr, mais la vapeur est perdue pour les usagers');
  }
  function note(t) { if (app.wrongReflex.indexOf(t) < 0) app.wrongReflex.push(t); }

  $('#zh-panel').addEventListener('click', function (e) {
    var b = e.target.closest('button[data-act]'); if (!b || b.disabled) return;
    var a = b.getAttribute('data-act'), v = b.getAttribute('data-v'), m = app.model; if (!m) return;
    var view = m.view();
    switch (a) {
      case 'licMode': act('licMode', v); break;
      case 'picMode': act('picMode', v); break;
      case 'structure': act('structure', +v); break;
      case 'ltSel': act('ltSel', v); break;
      case 'licSpD': act('licSp', view.licSp + (+v)); break;
      case 'picSpD': act('picSp', Math.round((view.picSp + (+v)) * 10) / 10); break;
      case 'licOutD': if (view.licMode !== 'MAN') act('licMode', 'MAN'); act('licOut', U.clamp(m.view().cmd + (+v), 0, 100)); break;
      case 'picOutD': if (view.picMode !== 'MAN') act('picMode', 'MAN'); act('picOut', U.clamp(m.pic.out + (+v), 0, 100)); break;
      case 'startB': act('startB'); break;
      case 'stopB': act('stopB'); break;
      case 'delest': act('delest', !view.delest); break;
      case 'purge': act('purge', !view.purge); break;
      case 'reset': act('reset'); break;
      case 'esd':
        if (!b.classList.contains('zh-armed')) {
          b.classList.add('zh-armed'); b.textContent = 'Confirmer l’arrêt ?';
          clearTimeout(b._t); b._t = setTimeout(function () { b.classList.remove('zh-armed'); b.textContent = 'Arrêt d’urgence'; }, 3000);
        } else { b.classList.remove('zh-armed'); b.textContent = 'Arrêt d’urgence'; act('esd'); }
        break;
    }
  });
  // curseurs : application immédiate, journalisation au relâchement
  $('#zh-panel').addEventListener('input', function (e) {
    var a = e.target.getAttribute('data-act'); if (!app.model) return;
    if (a === 'licOut') act('licOut', +e.target.value, true);
    if (a === 'bypass') act('bypass', +e.target.value / 100, true);
  });
  $('#zh-panel').addEventListener('change', function (e) {
    var a = e.target.getAttribute('data-act'); if (!app.model || app.ended || app.replaying) return;
    var m = app.model, lbl = null, before = m.view();
    if (a === 'licOut') lbl = 'LV-101 ouverture manuelle ' + Math.round(+e.target.value) + ' %';
    if (a === 'bypass') lbl = 'By-pass HV-102 ' + Math.round(+e.target.value) + ' %';
    if (lbl) { rec.event('action', lbl); trend1.mark(clock.t, lbl, 'action'); judge(a, a === 'bypass' ? +e.target.value / 100 : +e.target.value, before); }
  });
  // synoptique : un clic ouvre la faceplate associée
  svg.addEventListener('click', function (e) {
    var g = e.target.closest('[data-fp]'); if (!g) return;
    var fp = document.getElementById('fp-' + g.getAttribute('data-fp')); if (!fp) return;
    var panel = $('#zh-panel');
    if (window.matchMedia('(max-width: 900px)').matches && !panel.classList.contains('zh-open')) $('#en-drawer-btn').click();
    fp.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    fp.classList.remove('en-fp-flash'); void fp.offsetWidth; fp.classList.add('en-fp-flash');
  });
  $('#en-end').addEventListener('click', function () { if (app.model && !app.ended && !app.replaying) finish('user'); });

  /* ------------------------------------------------------------ partie */
  function start(scn, seed) {
    Z.closeOverlays();
    app.scn = scn; app.seed = seed || (Math.floor(Math.random() * 1e9) + 1);
    var mystery; var q = new URLSearchParams(location.search);
    if (q.get('mystere') === 'lt' || q.get('mystere') === 'vanne') mystery = q.get('mystere') === 'lt' ? 'lt' : 'valve';
    app.model = new B.Boiler({ scenario: scn, seed: app.seed, mystery: mystery });
    var inj = app.model.inject;
    app.model.inject = function (id, fromScenario) { if (!fromScenario && this.incident === null) this.injectedByTrainer = true; return inj.call(this, id, fromScenario); };
    app.ended = false; app.replaying = false; app.firstRelevant = null; app.wrongReflex = []; app.timers = { ldev: 0, zdev: 0 }; app.WsSlow = PRM.Wnom;
    document.body.classList.remove('en-replaying');
    clock.reset(); rec.reset(); alarms.reset(); trend1.clear(); trend2.clear();
    trainer.setFaults(trainerFaults());
    var sc = SCN[scn];
    $('#en-scn').innerHTML = '<span class="zh-scn-unit">Chaudière vapeur 20 t/h · </span><b>' + U.esc(sc.title) + '</b>';
    clock.setSpeed(10);
    rec.event('info', 'Prise de poste : ' + sc.title);
    clock.start();
    render(app.model.view(), true);
  }

  function finish(why) {
    if (app.ended) return;
    app.ended = true; clock.stop();
    var m = app.model, st = m.stats, fl = m.flags, scn = app.scn, kind = scn === 'c' ? m.mystery : scn;
    rec.event('outcome', why === 'time' ? 'Fin du poste (30 min de procédé)' : 'Partie terminée par l’opérateur');
    // --- sécurité
    var cap = function (x) { return x.charAt(0).toUpperCase() + x.slice(1); };
    var sec = 1, secTxt = [];
    if (fl.lsll) { sec -= 0.7; secTxt.push('niveau très bas atteint, brûleur déclenché (−35)'); }
    if (fl.lshh && st.carryKg > 20) { var pen = 0.3 + Math.min(0.2, st.tPrimage / 300); sec -= pen; secTxt.push('niveau très haut, primage : ' + Math.round(st.carryKg) + ' kg d’eau entraînée vers les usagers (−' + Math.round(pen * 50) + ')'); }
    else if (fl.lshh) { sec -= 0.1; secTxt.push('niveau très haut atteint, sans entraînement notable (−5)'); }
    if (fl.psv) { sec -= 0.2; secTxt.push('soupape ouverte (−10)'); }
    if (fl.lal && !fl.lsll) { sec -= 0.1; secTxt.push('alarme de niveau bas atteinte (−5)'); }
    if (!secTxt.length) secTxt.push('aucune sécurité sollicitée, niveau tenu dans sa plage');
    // --- production / qualité
    var ratio = st.demandInt > 0 ? st.okInt / st.demandInt : 1;
    var prod = U.clamp((ratio - 0.6) / 0.4, 0, 1);
    // --- réactivité
    var tInc = m.incident, tAl = null;
    rec.events.forEach(function (e) { if (tAl === null && tInc !== null && (e.type === 'alarm' || e.type === 'alarm2') && e.t >= tInc) tAl = e.t; });
    var ref = tAl !== null ? tAl : tInc, react = 0, reactTxt;
    if (tInc === null) { react = 1; reactTxt = 'aucun incident survenu pendant la partie'; }
    else if (app.firstRelevant === null) { react = 0; reactTxt = 'aucune action corrective identifiée'; }
    else {
      var d = Math.max(0, app.firstRelevant - ref);
      react = app.firstRelevant <= ref ? 1 : U.clamp(1 - (d - 45) / (420 - 45), 0, 1);
      reactTxt = app.firstRelevant <= ref ? 'action corrective avant la première alarme' : 'action corrective ' + U.fmtTime(d) + ' après la première alarme';
    }
    // --- issue
    var outcome;
    if (fl.lsll) outcome = { label: 'Brûleur déclenché par niveau très bas', bad: true, text: 'La sécurité a fait son travail : le brûleur s’est arrêté avant le dénoyage des tubes. Mais la vapeur a manqué aux usagers.' };
    else if (fl.lshh && st.carryKg > 20) outcome = { label: 'Primage : de l’eau est partie avec la vapeur', bad: true, text: 'Le niveau a dépassé +180 mm : l’eau entraînée abîme les équipements en aval (coups de bélier, turbines, échangeurs).' };
    else if (m.s.burner !== 'on') outcome = { label: 'Chaudière à l’arrêt en fin de poste', bad: true, text: 'Situation sûre, mais la production de vapeur est interrompue.' };
    else if (ratio < 0.9) outcome = { label: 'Chaudière sauvée, usagers pénalisés', bad: false, text: 'Pas de déclenchement, mais la pression ou le délestage ont réduit la vapeur livrée.' };
    else outcome = { label: 'Installation maîtrisée', bad: false, text: 'Le niveau est resté dans sa plage et les usagers ont été servis.' };
    var mysteryHTML = '';
    if (scn === 'c') mysteryHTML = '<div class="en-mystery-box"><b>La panne mystère était :</b> ' + (m.mystery === 'lt'
      ? 'le transmetteur de niveau <b>LT-101A figé</b>. La régulation croyait le niveau stable ; le niveau à glace et LT-101B disaient la vérité.'
      : 'la vanne alimentaire <b>LV-101 grippée</b>. La commande bougeait, la position non : seul le by-pass HV-102 permettait d’alimenter.') + '</div>';
    if (app.wrongReflex.length) mysteryHTML += '<div class="en-mystery-box"><b>À retravailler :</b><ul style="margin:6px 0 0;padding-left:18px">' + app.wrongReflex.map(function (w) { return '<li>' + U.esc(w) + '</li>'; }).join('') + '</ul></div>';
    var dbk = DEBRIEF[kind] || DEBRIEF.a;
    var cfg = {
      kicker: 'Débriefing · Chaudière vapeur',
      title: SCN[scn].title,
      outcome: outcome,
      scores: { securite: Math.max(0, sec), production: prod, reactivite: react },
      details: { securite: cap(secTxt.join(' ; ')) + '.', production: Math.round(ratio * 100) + ' % de la vapeur demandée livrée conforme (≥ 10,5 bar, sans primage ; délestage compté pour moitié).', reactivite: cap(reactTxt) + '.' },
      productionLabel: 'Production / qualité vapeur',
      stats: [
        { label: '1re alarme', value: tAl !== null ? U.fmtTime(tAl) : '—' },
        { label: 'Temps de réaction', value: app.firstRelevant !== null && ref !== null ? U.fmtTime(Math.max(0, app.firstRelevant - ref)) : '—' },
        { label: 'Niveau maxi (réel)', value: '+' + Math.round(st.Lmax) + ' mm' },
        { label: 'Niveau mini (réel)', value: Math.round(st.Lmin) + ' mm' },
        { label: 'Pression mini', value: f(st.Pmin, 2) + ' bar' },
        { label: 'Vapeur livrée conforme', value: Math.round(ratio * 100) + ' %' }
      ],
      chart: {
        series: [{ key: 'L', label: 'LI-101 niveau (mm)', color: '#1d2329', width: 2 }, { key: 'Lg', label: 'niveau à glace (mm)', color: '#8a9096', dash: [5, 4], width: 1.6 },
          { key: 'P', label: 'pression (bar, axe droit)', color: '#2f6fdf', axis: 'y2', width: 1.6 }],
        y: { min: -300, max: 300, unit: 'mm' }, y2: { min: 6, max: 14, unit: 'bar' },
        limits: [{ value: PRM.LSHH, color: '#d0021b', label: 'LSHH' }, { value: PRM.LSLL, color: '#d0021b', label: 'LSLL' }, { value: PRM.LAH, color: '#f5a623' }, { value: PRM.LAL, color: '#f5a623' }]
      },
      recorder: rec,
      keyPoints: dbk.keyPoints, sequence: dbk.sequence, extraHTML: mysteryHTML,
      onReplay: replay,
      onRetry: function () { start(scn); },
      onOther: showBriefing,
      mailBody: 'Bonjour,\n\nJ’ai joué la démo « Chaudière vapeur » (scénario « ' + SCN[scn].title + ' », score {score}/100). J’aimerais échanger sur la formation de nos conducteurs de chaufferie.\n\nEntreprise et site :\nNombre d’opérateurs concernés :\nTéléphone :\n'
    };
    app.lastDebrief = cfg;
    app.lastScore = Z.debrief(cfg);
    window.ZHEnergie.lastResult = { scenario: scn, mystery: m.mystery, score: app.lastScore, flags: fl, stats: st, ratio: ratio, firstRelevant: app.firstRelevant, wrong: app.wrongReflex.slice() };
  }

  function replay() {
    app.replaying = true; document.body.classList.add('en-replaying');
    Z.replay({
      recorder: rec, speed: 20,
      render: function (state, t) {
        render(state, false);
        // horloge et tendances suivent le rejeu
        clock.t = t; clock._paintUI();
        var upto = rec.samples.filter(function (x) { return x.t <= t; });
        trend1.data = upto; trend2.data = upto; trend1.draw(); trend2.draw();
      },
      onEnd: function () { app.replaying = false; document.body.classList.remove('en-replaying'); Z.debrief(app.lastDebrief); }
    });
  }

  function showBriefing() {
    Z.briefing({
      kicker: 'Briefing de prise de poste · Énergie',
      title: 'Chaudière 20 t/h : tenir le niveau du ballon',
      role: 'Vous êtes <b>conducteur ou conductrice de chaufferie</b>. La chaudière à tubes d’eau fournit 20 t/h de vapeur à 12 bar aux ateliers. Vous pilotez depuis la salle de contrôle.',
      objective: 'Garder le <b>niveau du ballon</b> dans sa plage (±100 mm), la <b>pression</b> vers 12 bar et la vapeur disponible pour les usagers. Niveau très bas : le brûleur déclenche. Niveau très haut : de l’eau part avec la vapeur (primage).',
      rules: [
        'Le <b>niveau à glace LG-101</b> (relevé local) montre le niveau réel ; <b>LI-101</b> est la mesure du transmetteur utilisée par la régulation.',
        'La régulation de niveau démarre en <b>1 élément</b>. La faceplate LIC-101 permet de passer en <b>3 éléments</b> (niveau, débit vapeur, débit d’eau).',
        'Vitesse ×10 : 1 seconde réelle = 10 secondes de procédé ; partie de 30 min de procédé. Pause à tout moment ; touche F : mode formateur.'
      ],
      scenarios: ['a', 'b', 'c'].map(function (k) { return { id: k, title: SCN[k].title, level: SCN[k].level, desc: SCN[k].desc, mystery: SCN[k].mystery }; }),
      footer: 'Démo pédagogique : modèle simplifié (bilans matière et énergie du ballon, gonflement et contraction, régulations PID), paramètres plausibles mais génériques. Elle ne remplace pas les consignes de votre site. Touche F : mode formateur.',
      onStart: function (id) { start(id); }
    });
  }

  // API de recette (scripts headless) — sans effet sur le jeu
  window.ZHEnergie = {
    start: start, act: act, finish: finish, clock: clock, alarms: alarms, recorder: rec,
    get model() { return app.model; }, get app() { return app; },
    /** Avance la simulation de n secondes procédé, sans attendre le temps réel. */
    advance: function (n) { var k = Math.round(n / clock.dt); for (var i = 0; i < k && !app.ended; i++) { step(clock.dt); clock.t += clock.dt; } render(app.model.view(), true); alarms.render(); }
  };

  // première image (fond du briefing) puis briefing
  app.model = new B.Boiler({ scenario: 'x', seed: 7 });
  render(app.model.view(), true);
  var q0 = new URLSearchParams(location.search).get('scenario');
  if (q0 && SCN[q0]) start(q0); else showBriefing();
  // mobile : le synoptique défile dans son cadre ; on centre d'abord le ballon et le niveau à glace
  if (window.matchMedia('(max-width: 900px)').matches) { var syn = $('#en-syn'); syn.scrollLeft = Math.max(0, (syn.scrollWidth - syn.clientWidth) * 0.4); }
})();
