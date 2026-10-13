/* =====================================================================
   Groupe ZH Sim — CHIMIE : interface et scénarios du réacteur R-101
   (assets/chimie.js) — s'appuie sur zh-sim-core.js et chimie-model.js
   ---------------------------------------------------------------------
   Scénarios : 'cw' (eau de refroidissement), 'agit' (agitateur),
   'drift' (dérive de sonde), 'mystery' (tirage au sort parmi les trois).
   Incident injecté à un instant aléatoire entre 3 et 6 min (temps procédé).
   Barème : sécurité 50 %, production 30 %, réactivité 20 % (voir finish()).
   Hook de recette : window.ZHChimie (start, act, state) pour les tests scriptés.
   ===================================================================== */
(function () {
  'use strict';
  var Z = window.ZHSim, U = Z.util, Model = window.ZHChimieModel, P = Model.P;
  var $ = function (id) { return document.getElementById(id); };

  /* ------------------------------------------------------------ scénarios */
  var SCN = {
    cw: {
      title: 'Perte partielle de l’eau de refroidissement', level: 1,
      desc: 'Quart de nuit, coulée en cours. Une utilité se dégrade : saurez-vous le voir avant la température ?',
      incident: 'Panne partielle de l’eau de refroidissement (débit EG à 12 %, EG à 35 °C)',
      keyPoints: [
        'La capacité de refroidissement disponible fixe la coulée maximale. Quand l’eau manque, réduire ou couper la coulée est le levier rapide sur la chaleur dégagée.',
        'Une vanne de régulation saturée à 100 % signale que la boucle ne tient plus : la température va suivre, même si elle paraît encore normale.',
        'En semi-batch bien conduit, couper la coulée éteint la production de chaleur en quelques minutes : c’est tout l’intérêt d’un procédé contrôlé par la coulée.'
      ],
      sequence: [
        'Lire les signes : TV-101 à 100 %, débit FT-102 bas, T enveloppe et TI-103 qui montent.',
        'Couper ou réduire fortement la coulée (≤ 25 %).',
        'Prévenir le chef de quart et l’exploitant des utilités.',
        'Surveiller T et P ; arrêt d’urgence si T atteint 110 °C.',
        'Reprendre la coulée quand la capacité de refroidissement est rétablie.'
      ]
    },
    agit: {
      title: 'Agitateur qui décroche', level: 2,
      desc: 'La température baisse, tout semble calme… Un grand classique des accidents de semi-batch.',
      incident: 'Déclenchement thermique de l’agitateur M-101',
      keyPoints: [
        'Sans agitation, le réactif coulé ne réagit presque plus : il s’accumule, et la température qui baisse donne une fausse impression de sécurité.',
        'Redémarrer l’agitateur sur une charge accumulée libère toute l’énergie d’un coup : on ne redémarre qu’après avoir évalué l’accumulation, selon la consigne du site.',
        'Le réflexe à ancrer : agitation perdue = coulée coupée immédiatement.'
      ],
      sequence: [
        'Constater le déclenchement de M-101 (alarme, puissance à 0 kW).',
        'Couper la coulée immédiatement.',
        'Ne pas redémarrer l’agitateur sans l’accord du chef de quart.',
        'Maintenir le refroidissement, surveiller T et P.',
        'Évaluer l’accumulation (bilan de coulée, analyse) avant toute reprise.'
      ]
    },
    drift: {
      title: 'Dérive d’une sonde de température', level: 3,
      desc: 'La régulation est parfaite, la courbe est plate. Trop plate ?',
      incident: 'Dérive de la sonde de régulation TT-101A (−4 °C/min)',
      keyPoints: [
        'Une régulation ne vaut que par sa mesure : si la sonde dérive, la boucle conduit le procédé loin de la consigne, en toute confiance.',
        'Croiser les mesures indépendantes : TT-101B, T enveloppe, pression et ouverture de vanne doivent raconter la même histoire.',
        'En cas de doute sur une mesure, se placer du côté sûr : refroidissement en manuel, coulée réduite, puis diagnostic.'
      ],
      sequence: [
        'Repérer l’écart entre TT-101A et TT-101B.',
        'Croiser avec la pression, la T enveloppe et la vanne TV-101 qui se ferme.',
        'Basculer la régulation sur TT-101B, ou passer TIC-101 en MAN et ouvrir le refroidissement.',
        'Réduire la coulée tant que la mesure n’est pas fiabilisée.',
        'Faire intervenir l’instrumentation, consigner l’événement.'
      ]
    }
  };
  var CARDS = [
    { id: 'cw', title: SCN.cw.title, level: 1, desc: SCN.cw.desc },
    { id: 'agit', title: SCN.agit.title, level: 2, desc: SCN.agit.desc },
    { id: 'drift', title: SCN.drift.title, level: 3, desc: SCN.drift.desc },
    { id: 'mystery', title: 'Quart mystère', level: 3, mystery: true, desc: 'Une panne tirée au sort, à un instant inconnu. Comme en vrai.' }
  ];

  /* ---------------------------------------------------------------- état */
  var G = { model: null, scn: null, card: null, tInc: 0, injected: false, phase: 'brief', tCorrect: null,
            badRestart: false, restartNB: 0, ended: false, lastFeedLog: null, armed: {} };
  var recorder, alarms, trend, clock, trainer;

  /* -------------------------------------------------------------- alarmes */
  function defineAlarms() {
    alarms = new Z.Alarms({ container: '#alarms', clock: clock, recorder: recorder, onChange: function () {
      $('drawer-btn').classList.toggle('zh-has-alarm', alarms.unackCount() > 0);
    } });
    alarms.define('TAH', { tag: 'TAH-101A', label: 'T réacteur haute (90 °C)', priority: 2, targets: ['#v-tt101a'] });
    alarms.define('TAL', { tag: 'TAL-101A', label: 'T réacteur basse (70 °C) : risque d’accumulation', priority: 2, targets: ['#v-tt101a'] });
    alarms.define('TAHH', { tag: 'TAHH-101B', label: 'T réacteur très haute (100 °C)', priority: 1, targets: ['#v-tt101b'] });
    alarms.define('TAU', { tag: 'TZA-101B', label: 'Seuil d’arrêt d’urgence atteint (110 °C)', priority: 1, targets: ['#v-tt101b'] });
    alarms.define('TDA', { tag: 'TDA-101', label: 'Écart TT-101A / TT-101B > 5 °C', priority: 2, targets: ['#v-tt101a', '#v-tt101b'] });
    alarms.define('PAH', { tag: 'PAH-101', label: 'Pression réacteur haute (1,5 bar g)', priority: 2, targets: ['#v-pt101'] });
    alarms.define('PAHH', { tag: 'PAHH-101', label: 'Pression très haute (2,5 bar g)', priority: 1, targets: ['#v-pt101'] });
    alarms.define('FAL', { tag: 'FAL-102', label: 'Débit eau de refroidissement bas', priority: 2, targets: ['#v-ft102'] });
    alarms.define('XA', { tag: 'XA-M101', label: 'Agitateur M-101 déclenché', priority: 1, targets: ['#v-ji101'] });
    alarms.define('LAH', { tag: 'LAH-101', label: 'Niveau réacteur haut (85 %)', priority: 3, targets: ['#v-lt101'] });
    alarms.define('ZSAT', { tag: 'TV-101', label: 'Vanne de refroidissement saturée à 100 %', priority: 3, targets: [] });
  }
  function evalAlarms(s) {
    var A = s.mTA, B = s.mTB;
    alarms.limit('TAH', A, 90, 'H', 1, U.fmt(A) + ' °C');
    alarms.limit('TAL', A, 70, 'L', 1, U.fmt(A) + ' °C');
    alarms.limit('TAHH', B, 100, 'H', 1, U.fmt(B) + ' °C');
    alarms.limit('TAU', B, 110, 'H', 1, U.fmt(B) + ' °C');
    alarms.limit('TDA', Math.abs(A - B), 5, 'H', 1, U.fmt(A - B) + ' °C');
    alarms.limit('PAH', s.P, 1.5, 'H', 0.05, U.fmt(s.P, 2) + ' bar g');
    alarms.limit('PAHH', s.P, 2.5, 'H', 0.05, U.fmt(s.P, 2) + ' bar g');
    var expected = P.FwMax * s.valve / 100;
    alarms.set('FAL', s.valve > 15 && s.Fw < 0.6 * expected, U.fmt(s.Fw * 3.6, 1) + ' m³/h');
    alarms.set('XA', s.agit === 'TRIP');
    alarms.limit('LAH', s.L, 85, 'H', 1, U.fmt(s.L, 0) + ' %');
    G.satT = s.valve >= 99.5 ? (G.satT || s.t) : null;
    alarms.set('ZSAT', !!G.satT && s.t - G.satT > 30);
  }

  /* -------------------------------------------------------------- actions */
  /** Toute action opérateur passe par act() : journalisée et évaluée. */
  function act(kind, val) {
    var m = G.model; if (!m || G.ended) return; var s = m.s, label = '';
    switch (kind) {
      case 'feed':
        s.feedPct = val; label = 'Coulée P-101 réglée à ' + Math.round(val) + ' %'; break;
      case 'feedStop': s.xv101 = false; label = 'Coulée coupée (XV-101 fermée)'; break;
      case 'feedOpen': if (s.esd) return; s.xv101 = true; label = 'XV-101 ouverte'; break;
      case 'ticMode': s.tic.mode = val; label = 'TIC-101 en ' + val; break;
      case 'ticSrc': s.tic.src = val; s.tic.e1 = null; label = 'TIC-101 régule sur TT-101' + val; break;
      case 'sp': s.tic.sp = U.clamp(val, 60, 95); label = 'Consigne TIC-101 : ' + U.fmt(s.tic.sp) + ' °C'; break;
      case 'out': s.valve = val; label = 'TV-101 (MAN) : ' + Math.round(val) + ' %'; break;
      case 'agitOn':
        if (s.agit === 'TRIP' && s.t - s.agitTrip < P.agitRearm) return;
        if (s.nB > 1500) { G.badRestart = true; G.restartNB = s.nB; }
        s.agit = 'RUN'; label = 'Redémarrage agitateur M-101'; break;
      case 'agitOff': s.agit = 'STOP'; label = 'Arrêt agitateur M-101'; break;
      case 'esd': s.esd = true; s.xv101 = false; s.tic.mode = 'MAN'; label = 'ARRÊT D’URGENCE déclenché'; break;
      case 'quench': s.quench = true; s.xv101 = false; label = 'NOYAGE déclenché (XV-103)'; break;
    }
    if (label) recorder.event('action', label, { kind: kind });
    checkCorrect(kind);
    render(true);
  }
  function checkCorrect(kind) {
    var s = G.model.s; if (!G.injected || G.tCorrect !== null) return;
    var feedLow = !s.xv101 || s.feedPct <= 30, ok = false;
    if (kind === 'esd' || kind === 'quench') ok = true;
    else if (G.scn === 'cw') ok = feedLow;
    else if (G.scn === 'agit') ok = !s.xv101 || s.feedPct <= 5;
    else if (G.scn === 'drift') ok = s.tic.src === 'B' || (s.tic.mode === 'MAN' && s.valve >= 60) || feedLow;
    if (ok) G.tCorrect = s.t;
  }

  /* -------------------------------------------------------------- boucle */
  function step(dt) {
    var m = G.model, s = m.s;
    if (!G.injected && s.t >= G.tInc) {
      G.injected = true; m.inject(G.scn);
      recorder.event('incident', 'Incident : ' + SCN[G.scn].incident);
    }
    m.step(dt);
    evalAlarms(s);
    recorder.tick(s.t, sample(s), function () { return view(); });
    trend.push(s.t, { A: s.mTA, B: s.mTB, J: s.Tj, P: s.P });
    checkEnd(s);
  }
  function sample(s) {
    return { T: +s.T.toFixed(2), A: +s.mTA.toFixed(2), B: +s.mTB.toFixed(2), J: +s.Tj.toFixed(2), P: +s.P.toFixed(3),
             F: +(s.xv101 && !s.esd ? s.feedPct : 0).toFixed(1), nB: Math.round(s.nB) };
  }
  function checkEnd(s) {
    if (G.ended) return;
    if (s.runaway) return finish('runaway');
    if (s.quench && s.mWater >= P.quenchMass - 1 && s.T < 90 && s.dTdt <= 0) return finish('quench');
    if (s.nFed >= P.nTot - 0.5 && s.nB < 150 && s.T < 95) return finish('done');
    if (G.tCorrect !== null && s.t - G.tCorrect > 540 && s.T < 95 && s.dTdt * 60 < 0.3 && (s.dTdt * 60 > -0.5 || s.esd || !s.xv101 || s.feedPct < 5) &&
        !alarms.isActive('TAHH') && !alarms.isActive('TAU') && !s.quench) {
      G.stableFor = (G.stableFor || 0) + clock.dt;
      if (G.stableFor > 180) return finish('stable');
    } else G.stableFor = 0;
    if (s.t >= 3000) return finish('timeout');
  }

  /* -------------------------------------------------------------- rendu */
  var feedFlow = $('flow-feed'), cwFlow = $('flow-cw'), qFlow = $('flow-quench'), imp1 = $('imp1'), imp2 = $('imp2');
  var angle = 0, lastRT = 0;
  function view() {
    var s = G.model.s;
    var alm = {}; alarms.order.forEach(function (id) { var st = alarms.state[id]; if (st.st !== 'NORM') alm[id] = [st.st, st.t, st.value]; });
    return { t: s.t, T: s.T, mTA: s.mTA, mTB: s.mTB, Tj: s.Tj, P: s.P, L: s.L, FB: s.FB || 0, feedPct: s.feedPct, xv101: s.xv101,
             valve: s.valve, Fw: s.Fw || 0, agit: s.agit, agitTrip: s.agitTrip, Tin: s.Tin, quench: s.quench, mWater: s.mWater,
             esd: s.esd, tic: { mode: s.tic.mode, sp: s.tic.sp, src: s.tic.src }, fedPct: s.fedPct, Qc: s.Qc || 0, cwAvail: s.cwAvail, alm: alm };
  }
  function txt(id, v) { var e = $(id); if (e && e._v !== v) { e._v = v; e.textContent = v; } }
  function paint(v, force) {
    // valeurs
    txt('tt101a', U.fmt(v.mTA)); txt('tt101b', U.fmt(v.mTB)); txt('tt102', U.fmt(v.Tj)); txt('ti103', U.fmt(v.Tin));
    txt('pt101', U.fmt(v.P, 2)); txt('lt101', U.fmt(v.L, 0));
    var kgh = v.FB * P.MB * 3600; txt('ft101', U.fmt(kgh, 0)); txt('ft102', U.fmt(v.Fw * 3.6, 1));
    var agitKW = v.agit === 'RUN' ? P.agitPower * (1 + 0.004 * Math.sin(v.t / 3)) : 0; txt('ji101', U.fmt(agitKW));
    var spd = v.esd || !v.xv101 ? 0 : v.feedPct; txt('p101-spd', Math.round(v.feedPct) + ' %');
    txt('tv101-pct', Math.round(v.valve) + ' %'); txt('tic-sp', U.fmt(v.tic.sp)); txt('tic-out', Math.round(v.valve));
    var pv = v.tic.src === 'B' ? v.mTB : v.mTA; txt('tic-pv', U.fmt(pv));
    txt('tic-mode', (v.esd ? 'MAN (AU)' : v.tic.mode) + ' · TT-101' + v.tic.src);
    // QI-101 : puissance évacuée calculée par le bilan enveloppe (débit × ΔT)
    var qmeas = v.Fw * P.cpw * (v.Tj - v.Tin); txt('qi101', U.fmt(Math.max(0, qmeas), 0));
    $('qi101-bar').setAttribute('width', U.clamp(180 * qmeas / 1400, 0, 180).toFixed(1));
    // bacs et niveau
    var t102 = U.clamp(1 - v.fedPct / 100, 0, 1) * 0.92 + 0.04; $('t102-liq').setAttribute('y', (190 - 128 * t102).toFixed(1)); txt('t102-pct', Math.round(t102 * 100) + ' %');
    var t103 = 1 - v.mWater / P.quenchMass; $('t103-liq').setAttribute('y', (140 - 86 * t103 * 0.9).toFixed(1));
    var ly = 472 - (472 - 142) * v.L / 100; $('r101-liq').setAttribute('y', ly.toFixed(1));
    // équipements
    var feeding = v.FB > 0.01;
    $('p101-body').setAttribute('class', feeding ? 'zh-equip-dark' : 'zh-equip');
    $('xv101').classList.toggle('zh-open', v.xv101 && !v.esd);
    $('tv101').classList.toggle('zh-open', v.valve > 0.5);
    $('xv103').classList.toggle('zh-open', v.quench);
    feedFlow.style.display = feeding ? '' : 'none';
    cwFlow.style.display = v.Fw > 0.2 ? '' : 'none'; cwFlow.classList.toggle('zh-slow', v.Fw < 5);
    qFlow.style.display = v.quench && v.mWater < P.quenchMass ? '' : 'none';
    var mb = $('m101-body'), run = v.agit === 'RUN';
    mb.setAttribute('class', run ? 'zh-equip-dark' : 'zh-equip'); mb.classList.toggle('zh-fault', v.agit === 'TRIP');
    $('m101-txt').setAttribute('fill', run ? '#fff' : '#1d2329');
    $('m101-fault').style.display = v.agit === 'TRIP' ? '' : 'none';
    $('sig-a').style.opacity = v.tic.src === 'A' ? 1 : 0.35; $('sig-b').style.opacity = v.tic.src === 'B' ? 1 : 0.35;
    // panneau
    txt('fp-fi', U.fmt(kgh, 0)); txt('fp-spd', Math.round(v.feedPct)); txt('fp-fed', Math.round(v.fedPct));
    $('fp-fed-bar').style.width = U.clamp(v.fedPct, 0, 100) + '%';
    var xv = $('fp-xv'), xvOpen = v.xv101 && !v.esd && !v.quench; txt('fp-xv', xvOpen ? 'OUVERTE' : 'FERMÉE');
    xv.className = 'zh-state' + (xvOpen ? ' zh-state--on' : '');
    var inF = $('in-feed'); if (document.activeElement !== inF) inF.value = Math.round(v.feedPct);
    $('btn-feed-open').disabled = xvOpen || v.esd || v.quench; $('btn-feed-stop').disabled = !xvOpen;
    $('btn-feed-nom').disabled = v.esd || v.quench;
    txt('fp-pv', U.fmt(pv)); txt('fp-sp', U.fmt(v.tic.sp)); txt('fp-out', Math.round(v.valve));
    $('fp-out-bar').style.width = v.valve + '%';
    var man = v.tic.mode === 'MAN' || v.esd;
    Array.prototype.forEach.call($('tic-modes').children, function (b) { b.setAttribute('aria-pressed', String(b.getAttribute('data-m') === (man ? 'MAN' : 'AUTO'))); b.disabled = v.esd; });
    Array.prototype.forEach.call($('tic-srcs').children, function (b) { b.setAttribute('aria-pressed', String(b.getAttribute('data-s') === v.tic.src)); });
    var inO = $('in-out'); inO.disabled = !man || v.esd; if (document.activeElement !== inO) inO.value = Math.round(v.valve);
    txt('tic-hint', v.esd ? 'Arrêt d’urgence : TV-101 forcée à 100 %.' : man ? 'MAN : vous pilotez l’ouverture de TV-101 avec le curseur.' : 'AUTO : la vanne suit la régulation. Passez en MAN pour piloter l’ouverture.');
    var st = $('fp-agit-st');
    txt('fp-agit-st', v.agit === 'RUN' ? 'MARCHE' : v.agit === 'TRIP' ? 'DÉFAUT' : 'ARRÊT');
    st.className = 'zh-state' + (v.agit === 'RUN' ? ' zh-state--on' : v.agit === 'TRIP' ? ' zh-state--fault' : '');
    txt('fp-agit-kw', U.fmt(agitKW));
    var lock = v.agit === 'TRIP' ? Math.max(0, P.agitRearm - (v.t - v.agitTrip)) : 0;
    $('btn-agit-on').disabled = run || lock > 0; $('btn-agit-off').disabled = !run;
    txt('agit-hint', v.agit === 'TRIP' ? (lock > 0 ? 'Défaut thermique moteur. Réarmement possible dans ' + Math.ceil(lock) + ' s.' : 'Réarmement possible. Avant de redémarrer : que s’est-il passé dans la cuve ?') : '');
    var esd = $('btn-esd'), q = $('btn-quench');
    if (v.esd) { txt('btn-esd', 'ARRÊT D’URGENCE ACTIF'); esd.disabled = true; esd.classList.add('zh-armed'); }
    else if (!G.armed || !G.armed.esd) { txt('btn-esd', 'ARRÊT D’URGENCE'); esd.disabled = false; esd.classList.remove('zh-armed'); }
    if (v.quench) { txt('btn-quench', 'NOYAGE EN COURS'); q.disabled = true; q.classList.add('zh-armed'); }
    else if (!G.armed || !G.armed.quench) { txt('btn-quench', 'NOYAGE (XV-103)'); q.disabled = false; q.classList.remove('zh-armed'); }
  }
  function animate(v, rdt) {
    if (v.agit === 'RUN') angle += rdt * 9;
    var c = Math.cos(angle), c2 = Math.cos(angle + 1.3);
    imp1.setAttribute('transform', 'translate(500,330) scale(' + (0.25 + 0.75 * Math.abs(c)).toFixed(3) + ',1)');
    imp2.setAttribute('transform', 'translate(500,412) scale(' + (0.25 + 0.75 * Math.abs(c2)).toFixed(3) + ',1)');
  }
  function render(force) {
    if (!G.model) return;
    var now = performance.now(), rdt = lastRT ? Math.min(0.1, (now - lastRT) / 1000) : 0; lastRT = now;
    var v = view(); paint(v, force); animate(v, rdt * (clock.isHalted() ? 0 : 1));
    alarms.render(); trend.draw(force);
  }

  /* ---------------------------------------------------------- début / fin */
  function start(id) {
    var card = id, scn = id;
    if (id === 'mystery') scn = ['cw', 'agit', 'drift'][Math.floor(Math.random() * 3)];
    clock.stop(); clock.reset();
    G = { model: new Model(), scn: scn, card: card, tInc: Math.round(180 + Math.random() * 180), injected: false, phase: 'run',
          tCorrect: null, badRestart: false, restartNB: 0, ended: false, armed: {} };
    recorder.reset(); alarms.reset(); trend.clear();
    resetButtons();
    $('scn-label').innerHTML = '<span class="zh-scn-unit">Réacteur R-101 · </span><b>' + (card === 'mystery' ? 'Quart mystère' : SCN[scn].title) + '</b>';
    trainer.setFaults(trainerFaults());
    recorder.event('info', 'Prise de poste : coulée en cours, T = 80 °C');
    clock.setSpeed(clock.speed || 10);
    clock.start(); render(true);
  }
  function resetButtons() {
    var esd = $('btn-esd'), q = $('btn-quench');
    esd.textContent = 'ARRÊT D’URGENCE'; esd.disabled = false; esd.classList.remove('zh-armed');
    q.textContent = 'NOYAGE (XV-103)'; q.disabled = false; q.classList.remove('zh-armed');
  }
  function trainerFaults() {
    return [
      { id: 'cw', label: 'Panne partielle eau de refroidissement', inject: function () { G.model.inject('cw'); markInjected('cw'); } },
      { id: 'cwr', label: 'Rétablir l’eau de refroidissement', inject: function () { G.model.restoreCW(); } },
      { id: 'agit', label: 'Déclenchement agitateur M-101', inject: function () { G.model.inject('agit'); markInjected('agit'); } },
      { id: 'drift', label: 'Dérive sonde TT-101A', inject: function () { G.model.inject('drift'); markInjected('drift'); } }
    ];
  }
  function markInjected(kind) { if (!G.injected) { G.injected = true; G.scn = kind; G.tInc = G.model.s.t; } }

  function finish(kind) {
    if (G.ended) return; G.ended = true; clock.stop();
    var s = G.model.s, sc = SCN[G.scn], ev = recorder;
    var outcomes = {
      runaway: { label: 'Emballement thermique : rupture du disque PSE-101', bad: true,
        text: 'La température a dépassé le point de non-retour : la décomposition de la masse réactionnelle a pris le dessus sur le refroidissement. Dans la réalité : rejet à l’évent, arrêt de l’atelier, enquête.' },
      quench: { label: 'Réacteur mis en sécurité par noyage', text: 'L’installation est sûre. Le lot est perdu et le réacteur devra être vidangé et nettoyé.' },
      done: { label: 'Lot terminé en sécurité', text: 'Coulée achevée, réactif consommé, température maîtrisée.' },
      stable: { label: 'Situation maîtrisée', text: 'La température est stable et sous contrôle depuis plusieurs minutes.' },
      abort: { label: 'Partie interrompue', bad: true, text: G.injected ? 'L’incident était en cours et n’a pas été traité.' : 'La partie a été arrêtée avant l’incident.' },
      timeout: { label: s.T < 95 ? 'Fin du quart : situation sous contrôle' : 'Fin du quart : situation dégradée', bad: s.T >= 95, text: '' }
    };
    var out = outcomes[kind];
    // ---- sécurité (50 %)
    var Tm = s.Tmax, saf;
    if (kind === 'runaway') saf = 0;
    else saf = Tm <= 95 ? 1 : Tm <= 100 ? 0.85 : Tm <= 110 ? 0.6 : Tm <= 130 ? 0.35 : 0.2;
    if (G.badRestart) saf = Math.max(0, saf - 0.3);
    if (kind === 'abort') saf = G.tCorrect === null ? 0 : saf * 0.5;
    // ---- production (30 %)
    var prod;
    if (kind === 'runaway') prod = 0;
    else if (kind === 'quench') prod = 0.1;
    else if (kind === 'done') prod = 1;
    else if (kind === 'abort') prod = 0.3 * s.fedPct / 100;
    else if (s.esd) prod = 0.45;
    else if (s.xv101 && s.feedPct > 5) prod = 0.85;
    else prod = 0.6;
    if (kind === 'timeout' && s.T >= 95) prod *= 0.5;
    // ---- réactivité (20 %) : délai entre la 1re alarme après l'incident et la 1re action pertinente
    var firstAlarm = null;
    ev.events.forEach(function (e) { if (firstAlarm === null && (e.type === 'alarm' || e.type === 'alarm2') && e.t >= G.tInc) firstAlarm = e.t; });
    var react = 0, rt = null;
    if (G.tCorrect !== null) {
      rt = firstAlarm === null ? 0 : Math.max(0, G.tCorrect - firstAlarm);
      react = rt <= 60 ? 1 : rt >= 600 ? 0.15 : 1 - 0.85 * (rt - 60) / 540;
    }
    var detail = {
      securite: kind === 'runaway' ? 'Emballement.' : 'T max ' + U.fmt(Tm) + ' °C' + (G.badRestart ? ' ; redémarrage de l’agitateur sur ' + Math.round(G.restartNB) + ' mol accumulées (−15 pts)' : ''),
      production: { runaway: 'Installation perdue.', quench: 'Lot perdu (noyage).', done: 'Lot complet.', stable: s.esd ? 'Lot interrompu par l’arrêt d’urgence.' : (s.xv101 && s.feedPct > 5 ? 'Coulée poursuivie à débit adapté.' : 'Lot suspendu, reprise possible.'), timeout: 'Lot inachevé.', abort: 'Lot inachevé.' }[kind],
      reactivite: G.tCorrect === null ? 'Aucune action corrective détectée.' : (firstAlarm === null || G.tCorrect < firstAlarm ? 'Action avant la première alarme : anticipation.' : (rt < 5 ? 'Action immédiate dès la première alarme.' : 'Action ' + U.fmtTime(rt) + ' après la première alarme.'))
    };
    var dTadMax = s.maxNB * P.dH / s.Cth;
    var stats = [
      { label: '1re alarme', value: firstAlarm === null ? '—' : U.fmtTime(firstAlarm) },
      { label: 'Temps de réaction', value: rt === null ? '—' : (G.tCorrect < (firstAlarm || 1e9) ? 'anticipée' : U.fmtTime(rt)) },
      { label: 'Incident survenu à', value: U.fmtTime(G.tInc) },
      { label: 'T max réacteur (TT-101B)', value: U.fmt(Tm) + ' °C' },
      { label: 'Pression max', value: U.fmt(s.Pmax, 2) + ' bar g' },
      { label: 'Accumulation max. de B', value: Math.round(s.maxNB) + ' mol' },
      { label: 'ΔTad de l’accumulation', value: Math.round(dTadMax) + ' K' },
      { label: 'Coulée réalisée', value: Math.round(s.fedPct) + ' %' }
    ];
    out = { label: out.label, bad: out.bad, text: (out.text ? out.text + '<br>' : '') + '<b>Incident :</b> ' + U.esc(sc.incident) + '.' };
    recorder.event('outcome', out.label);
    Z.debrief({
      kicker: 'Débriefing · Réacteur semi-batch R-101',
      title: (G.card === 'mystery' ? 'Quart mystère · ' : '') + sc.title,
      outcome: out, scores: { securite: saf, production: prod, reactivite: react }, details: detail,
      productionLabel: 'Production', stats: stats, recorder: recorder,
      chart: { series: [
          { key: 'B', label: 'T réacteur réelle (TT-101B)', color: '#1d2329', width: 2.2 },
          { key: 'A', label: 'TT-101A (régulation)', color: '#7a8189', dash: [5, 3], width: 1.5 },
          { key: 'J', label: 'T enveloppe', color: '#00a3a1', width: 1.5 },
          { key: 'F', label: 'Coulée % (axe droit)', color: '#2f6fdf', width: 1.5, axis: 'y2' } ],
        y: { min: 20, max: 170, unit: '°C' }, y2: { min: 0, max: 100, unit: '%' },
        limits: [{ value: 90, color: '#c27c0e', label: 'H 90' }, { value: 100, color: '#d0021b', label: 'HH 100' }, { value: 110, color: '#d0021b', label: 'AU 110' }] },
      keyPoints: sc.keyPoints, sequence: sc.sequence,
      extraHTML: '<p class="zh-note"><b>Pour aller plus loin :</b> la température maximale atteignable en cas de perte de refroidissement (MTSR) vaut T + ΔTad de l’accumulation. Ici, l’accumulation maximale représentait ' + Math.round(dTadMax) + ' K. Bonne pratique : conduire à une température où le réactif est consommé au fur et à mesure de la coulée.</p>',
      onReplay: function () { replay(); },
      onRetry: function () { start(G.card); },
      onOther: function () { brief(); },
      mailBody: 'Bonjour,\n\nJ’ai joué la démo « Réacteur semi-batch » (scénario « ' + (G.card === 'mystery' ? 'Quart mystère' : sc.title) + ' », score {score}/100). J’aimerais échanger sur la formation de nos opérateurs aux situations anormales.\n\nEntreprise et site :\nNombre d’opérateurs concernés :\nTéléphone :\n'
    });
  }

  function replay() {
    var savedModel = G.model;
    trend.clear(); var lastT = -1;
    Z.replay({ recorder: recorder, speed: 20,
      render: function (v, t) {
        if (t > lastT) { trend.push(t, { A: v.mTA, B: v.mTB, J: v.Tj, P: v.P }); lastT = t; }
        // alarmes rejouées
        alarms.order.forEach(function (id) { var a = v.alm[id]; alarms.state[id] = a ? { st: a[0], t: a[1], value: a[2] } : { st: 'NORM', t: null, value: '' }; });
        alarms._dirty = true;
        clock.t = t; clock._paintUI();
        paint(v, true); animate(v, 0.016); alarms.render(); trend.draw();
      },
      onEnd: function () { G.model = savedModel; finishAgain(); }
    });
  }
  function finishAgain() { G.ended = false; finish(lastKind()); }
  function lastKind() {
    var e = recorder.events.filter(function (x) { return x.type === 'outcome'; }).pop();
    recorder.events = recorder.events.filter(function (x) { return x.type !== 'outcome'; });
    var s = G.model.s;
    if (s.runaway) return 'runaway';
    if (e && /noyage/.test(e.label)) return 'quench';
    if (e && /terminé en sécurité/.test(e.label)) return 'done';
    if (e && /maîtrisée/.test(e.label)) return 'stable';
    if (e && /interrompue/.test(e.label)) return 'abort';
    return 'timeout';
  }

  function brief() {
    clock.stop();
    Z.briefing({
      kicker: 'Briefing de prise de poste · Chimie',
      title: 'Réacteur semi-batch exothermique : évitez l’emballement',
      role: 'Vous êtes <b>opérateur en salle de contrôle</b>. Le réacteur R-101 est en cours de coulée du réactif B sur le pied de cuve : la réaction dégage environ <b>900 kW</b>, évacués par l’eau de la double enveloppe.',
      objective: 'Terminer la coulée en gardant la température proche de <b>80 °C</b>. Un incident va survenir : <b>diagnostiquez et réagissez</b> avant l’emballement. Durée : 3 à 5 minutes à vitesse ×10.',
      rules: [
        'Seuils : alarme haute 90 °C, très haute 100 °C ; à <b>110 °C, la consigne impose l’arrêt d’urgence</b>. Au-delà de 150 °C environ, la masse se décompose.',
        'Vos leviers : <b>coulée</b> (P-101 / XV-101), <b>refroidissement</b> (TIC-101, TV-101), <b>agitateur</b> M-101, <b>arrêt d’urgence</b>, <b>noyage</b>.',
        'Pour l’exercice, les sécurités automatiques sont neutralisées : vous êtes la dernière barrière.'
      ],
      scenarios: CARDS,
      footer: 'Démo pédagogique : modèle simplifié (bilans matière et énergie, cinétique d’Arrhenius), paramètres plausibles mais génériques. Elle ne remplace pas les consignes de votre site. Touche F : mode formateur.',
      onStart: start
    });
  }

  /* --------------------------------------------------------- liaisons UI */
  function confirm2(btn, kind, label) {
    btn.addEventListener('click', function () {
      if (btn.disabled) return;
      if (G.armed[kind]) { clearTimeout(G.armed[kind]); G.armed[kind] = null; act(kind); return; }
      btn.classList.add('zh-armed'); btn._v = null; btn.textContent = 'CONFIRMER : ' + label;
      G.armed[kind] = setTimeout(function () { G.armed[kind] = null; btn._v = null; render(true); }, 3000);
    });
  }
  function bindUI() {
    var inF = $('in-feed');
    inF.addEventListener('input', function () { txt('fp-spd', inF.value); });
    inF.addEventListener('change', function () { act('feed', +inF.value); });
    $('btn-feed-stop').addEventListener('click', function () { act('feedStop'); });
    $('btn-feed-open').addEventListener('click', function () { act('feedOpen'); });
    $('btn-feed-nom').addEventListener('click', function () { act('feed', P.feedNom); if (!G.model.s.xv101) act('feedOpen'); });
    Array.prototype.forEach.call($('tic-modes').children, function (b) { b.addEventListener('click', function () { act('ticMode', b.getAttribute('data-m')); }); });
    Array.prototype.forEach.call($('tic-srcs').children, function (b) { b.addEventListener('click', function () { act('ticSrc', b.getAttribute('data-s')); }); });
    $('sp-up').addEventListener('click', function () { act('sp', G.model.s.tic.sp + 1); });
    $('sp-dn').addEventListener('click', function () { act('sp', G.model.s.tic.sp - 1); });
    var inO = $('in-out');
    inO.addEventListener('input', function () { if (G.model && G.model.s.tic.mode === 'MAN') G.model.s.valve = +inO.value; });
    inO.addEventListener('change', function () { act('out', +inO.value); });
    $('btn-agit-on').addEventListener('click', function () { act('agitOn'); });
    $('btn-agit-off').addEventListener('click', function () { act('agitOff'); });
    confirm2($('btn-esd'), 'esd', 'ARRÊT D’URGENCE');
    confirm2($('btn-quench'), 'quench', 'NOYAGE');
    $('btn-end').addEventListener('click', function () { if (G.model && !G.ended) finish(G.model.s.runaway ? 'runaway' : (G.tCorrect !== null && G.model.s.T < 95) ? 'timeout' : 'abort'); });
    // clic sur un équipement du synoptique -> faceplate
    $('syn').addEventListener('click', function (e) {
      var g = e.target.closest('[data-fp]'); if (!g) return;
      var fp = $(g.getAttribute('data-fp')); var panel = $('zh-panel');
      if (window.matchMedia('(max-width: 900px)').matches) { panel.classList.add('zh-open'); }
      fp.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      fp.classList.add('ch-flash'); setTimeout(function () { fp.classList.remove('ch-flash'); }, 700);
    });
    Z.drawer('#zh-panel', '#drawer-btn');
  }

  /* -------------------------------------------------------------- init */
  function init() {
    clock = new Z.Clock({ dt: 0.5, speed: 10, speeds: [1, 5, 10], step: step, render: function () { render(false); } });
    clock.bindUI({ clock: $('clock'), speed: $('speed'), pause: $('pause') });
    recorder = new Z.Recorder({ clock: clock, every: 2 });
    defineAlarms();
    trend = new Z.Trend('#trend', { window: 600, legend: '#trend-legend',
      series: [
        { key: 'B', label: 'TT-101B T réacteur (sécurité)', color: '#1d2329', width: 2 },
        { key: 'A', label: 'TT-101A (régulation)', color: '#7a8189', dash: [5, 3], width: 1.5 },
        { key: 'J', label: 'TT-102 T enveloppe', color: '#00a3a1', width: 1.5 },
        { key: 'P', label: 'PT-101 pression (axe droit)', color: '#2f6fdf', width: 1.5, axis: 'y2' } ],
      y: { min: 20, max: 170, unit: '°C' }, y2: { min: 0, max: 6, unit: 'bar g' },
      limits: [{ value: 90, color: '#c27c0e', label: 'H' }, { value: 100, color: '#d0021b', label: 'HH' }, { value: 110, color: '#d0021b', label: 'AU' }] });
    trainer = new Z.Trainer({ clock: clock, recorder: recorder, faults: [] });
    bindUI();
    G.model = new Model(); render(true);
    // mobile : centrer le synoptique sur le réacteur
    var syn = document.querySelector('.zh-synoptic');
    if (syn && syn.scrollWidth > syn.clientWidth) syn.scrollLeft = (syn.scrollWidth - syn.clientWidth) * 0.45;
    brief();
    // hook de recette (tests scriptés)
    window.ZHChimie = { start: start, act: act, finish: finish, get G() { return G; }, clock: clock, alarms: alarms, recorder: recorder };
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
