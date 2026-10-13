/* =====================================================================
   Groupe ZH Sim — noyau commun  (assets/zh-sim-core.js)
   ---------------------------------------------------------------------
   Aucune dépendance, aucun build, aucun accès réseau, aucun localStorage.
   Expose un seul objet global : window.ZHSim.  À charger AVANT assets/<sim>.js.

   API (résumé — détails au-dessus de chaque bloc)
   -----------------------------------------------
   ZHSim.util          clamp, lerp, fmt(v,dec), fmtTime(s), gauss(), Lag, DeadTime
   ZHSim.contact       src(), subject(), mailto(body?), bind(root?)
                       -> tout <a data-zh-mailto="corps facultatif"> reçoit le mailto
                          « Diagnostic offert [réf xxx] » (xxx = ?src= de l'URL)
                       -> tout <a data-zh-keep-src href="demo.html"> garde ?src= dans le lien
   new ZHSim.Clock({dt, speed, speeds, step(dt,t), render(t)})
                       start(), pause(), resume(), toggle(), setSpeed(n), freeze(bool),
                       stop(), reset(), .t (s simulées), .speed, .paused, .frozen, .running
                       bindUI({clock:el, speed:el, pause:el})  (crée les boutons ×1/×5/×10)
   new ZHSim.PID({kp, ti, td, bias, outMin, outMax, reverse, sp, mode})
                       update(pv, dt) -> sortie % ; setMode('AUTO'|'MAN') sans à-coup ;
                       .out (écrire .out en MAN) ; .sp
   new ZHSim.Alarms({container, clock, recorder, sound, onChange})
                       define(id, {tag, label, priority:1|2|3, targets:[el|sélecteur]})
                       set(id, actif, texteValeur)            (état ISA-18.2 géré ici)
                       limit(id, valeur, seuil, 'H'|'L', bandeMorte, texteValeur)
                       ack(id), ackAll(), isActive(id), activeIds(), unackCount(),
                       firstAlarmTime (t de la 1re alarme, null sinon), setSound(bool), reset()
   new ZHSim.Recorder({clock, every})
                       tick(t, valeurs, snapshotFn) échantillonne toutes les `every` s ;
                       event(type, label, extra) type ∈ incident|alarm|alarm2|action|note|info|outcome ;
                       .samples [{t, ...valeurs}], .snaps [{t, state}], .events [{t,type,label}]
   new ZHSim.Trend(canvas, {window, series:[{key,label,color,dash,width,axis}],
                       y:{min,max,unit}, y2:{min,max,unit}, limits:[{value,color,label,axis}], legend:el})
                       push(t, valeurs), draw(), clear(), mark(t,label,type)
   ZHSim.chart(canvas, {series, y, y2, limits, samples, events, tMax})   graphique statique (débriefing)
   ZHSim.briefing({kicker, title, role, objective, rules:[], scenarios:[{id,title,level,desc,mystery}],
                   onStart(id)})
   ZHSim.debrief({kicker, title, outcome:{label,bad}, scores:{securite,production,reactivite} (0..1),
                  details:{securite,production,reactivite}, stats:[{label,value}],
                  chart:{series,y,y2,limits}, recorder, keyPoints:[3], sequence:[],
                  onReplay(), onRetry(), onOther(), mailBody})
                  -> score /100 = 50 % sécurité + 30 % production/qualité + 20 % réactivité
   ZHSim.score(scores) -> {total, securite, production, reactivite} (points)
   new ZHSim.Trainer({clock, recorder, faults:[{id,label,inject()}], extra(el)?})
                       touche F ou tout élément [data-zh-trainer] : panneau formateur
                       (injecter une panne, geler, annoter). .open(), .close(), .toggle()
   ZHSim.replay({recorder, speed:20, render(state,t), onEnd()})   rejeu des instantanés
   ZHSim.toast(texte, 'info'|'alarm'|'note', ms)
   ZHSim.drawer(panelEl, buttonEl)        tiroir de commandes sur mobile
   ZHSim.bindDemoBanner()                 garantit la présence du bandeau « Démo pédagogique »

   Convention de temps : toutes les durées sont en SECONDES SIMULÉES (temps procédé).
   La vitesse ×N fait avancer N secondes simulées par seconde réelle, à pas fixe `dt`.
   ===================================================================== */
(function (global) {
  'use strict';

  var ZHSim = {};
  var EMAIL = 'z.hamami.formations@gmail.com';

  /* ------------------------------------------------------------------ util */
  var util = {
    clamp: function (v, a, b) { return v < a ? a : v > b ? b : v; },
    lerp: function (a, b, x) { return a + (b - a) * x; },
    fmt: function (v, d) {
      if (v === null || v === undefined || isNaN(v)) return '---';
      var r = Number(v).toFixed(d === undefined ? 1 : d);
      if (/^-0(\.0+)?$/.test(r)) r = r.slice(1);
      return r.replace('.', ','); // affichage à la française : virgule décimale
    },
    fmtTime: function (s) {
      s = Math.max(0, Math.floor(s));
      var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
      var mm = (m < 10 ? '0' : '') + m, ss = (x < 10 ? '0' : '') + x;
      return h ? h + ':' + mm + ':' + ss : mm + ':' + ss;
    },
    /** Bruit gaussien centré réduit (Box-Muller). */
    gauss: function () {
      var u = 1 - Math.random(), v = Math.random();
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    },
    $: function (sel, root) { return typeof sel === 'string' ? (root || document).querySelector(sel) : sel; },
    el: function (tag, attrs, html) {
      var e = document.createElement(tag);
      if (attrs) for (var k in attrs) { if (k === 'class') e.className = attrs[k]; else e.setAttribute(k, attrs[k]); }
      if (html !== undefined) e.innerHTML = html;
      return e;
    },
    esc: function (s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  };
  /** Retard du premier ordre : y' = (u - y)/tau. */
  util.Lag = function (tau, y0) { this.tau = tau; this.y = y0 || 0; };
  util.Lag.prototype.update = function (u, dt) { this.y += (u - this.y) * Math.min(1, dt / this.tau); return this.y; };
  /** Retard pur (temps mort) de `delay` secondes. */
  util.DeadTime = function (delay, y0) { this.delay = delay; this.buf = []; this.y = y0 || 0; this.t = 0; };
  util.DeadTime.prototype.update = function (u, dt) {
    this.t += dt; this.buf.push([this.t, u]);
    while (this.buf.length && this.buf[0][0] <= this.t - this.delay) this.y = this.buf.shift()[1];
    return this.y;
  };
  ZHSim.util = util;

  /* --------------------------------------------------------------- contact */
  var contact = {
    src: function () {
      try {
        var v = new URLSearchParams(global.location.search).get('src');
        return v ? v.replace(/[^\w\-.]/g, '').slice(0, 40) : '';
      } catch (e) { return ''; }
    },
    subject: function () { var s = contact.src(); return 'Diagnostic offert' + (s ? ' [réf ' + s + ']' : ''); },
    mailto: function (body) {
      var href = 'mailto:' + EMAIL + '?subject=' + encodeURIComponent(contact.subject());
      if (body) href += '&body=' + encodeURIComponent(body);
      return href;
    },
    /** Lie les liens [data-zh-mailto] et propage ?src= aux liens [data-zh-keep-src]. */
    bind: function (root) {
      root = root || document;
      Array.prototype.forEach.call(root.querySelectorAll('[data-zh-mailto]'), function (a) {
        a.setAttribute('href', contact.mailto(a.getAttribute('data-zh-mailto') || ''));
      });
      var s = contact.src();
      if (s) Array.prototype.forEach.call(root.querySelectorAll('[data-zh-keep-src]'), function (a) {
        var h = a.getAttribute('href') || ''; if (h.indexOf('src=') >= 0) return;
        var hash = ''; var i = h.indexOf('#'); if (i >= 0) { hash = h.slice(i); h = h.slice(0, i); }
        a.setAttribute('href', h + (h.indexOf('?') >= 0 ? '&' : '?') + 'src=' + encodeURIComponent(s) + hash);
      });
    },
    email: EMAIL
  };
  ZHSim.contact = contact;

  /* ----------------------------------------------------------------- Clock */
  /**
   * Horloge à pas fixe. step(dt, t) est appelé N fois par image selon la vitesse ;
   * render(t) une fois par image. Le temps réel écoulé par image est plafonné à 0,25 s
   * (onglet en arrière-plan : pas de saut brutal).
   */
  function Clock(o) {
    o = o || {};
    this.dt = o.dt || 0.5;
    this.speeds = o.speeds || [1, 5, 10];
    this.speed = o.speed || 10;
    this.stepFn = o.step || function () {};
    this.renderFn = o.render || function () {};
    this.t = 0; this.paused = false; this.frozen = false; this.running = false;
    this._acc = 0; this._last = 0; this._raf = 0; this._ui = null; this._listeners = [];
    var self = this; this._loop = function (ts) { self._frame(ts); };
  }
  Clock.prototype.onChange = function (fn) { this._listeners.push(fn); };
  Clock.prototype._emit = function () { var s = this; this._listeners.forEach(function (f) { f(s); }); this._paintUI(); };
  Clock.prototype.start = function () {
    if (this.running) return; this.running = true; this.paused = false; this._last = 0;
    this._raf = requestAnimationFrame(this._loop); this._emit();
  };
  Clock.prototype.stop = function () { this.running = false; cancelAnimationFrame(this._raf); this._emit(); };
  Clock.prototype.reset = function () { this.stop(); this.t = 0; this._acc = 0; this.paused = false; this.frozen = false; this._emit(); };
  Clock.prototype.pause = function () { this.paused = true; this._emit(); };
  Clock.prototype.resume = function () { this.paused = false; this._last = 0; this._emit(); };
  Clock.prototype.toggle = function () { this.paused ? this.resume() : this.pause(); };
  Clock.prototype.freeze = function (b) { this.frozen = !!b; this._last = 0; this._emit(); };
  Clock.prototype.setSpeed = function (n) { this.speed = n; this._emit(); };
  Clock.prototype.isHalted = function () { return this.paused || this.frozen || !this.running; };
  Clock.prototype._frame = function (ts) {
    if (!this.running) return;
    var realDt = this._last ? Math.min(0.25, (ts - this._last) / 1000) : 0;
    this._last = ts;
    if (!this.paused && !this.frozen) {
      this._acc += realDt * this.speed;
      var n = 0;
      while (this._acc >= this.dt && n < 400) {
        this.stepFn(this.dt, this.t); this.t += this.dt; this._acc -= this.dt; n++;
        if (!this.running) break;
      }
    }
    this.renderFn(this.t);
    this._paintUI();
    if (this.running) this._raf = requestAnimationFrame(this._loop);
  };
  /** Crée l'horloge et les boutons de vitesse dans l'en-tête. */
  Clock.prototype.bindUI = function (o) {
    var self = this; this._ui = o;
    if (o.speed) {
      o.speed.innerHTML = ''; o.speed.classList.add('zh-speed'); o.speed.setAttribute('role', 'group'); o.speed.setAttribute('aria-label', 'Vitesse de simulation');
      this.speeds.forEach(function (s) {
        var b = util.el('button', { type: 'button', 'data-speed': s, title: 'Vitesse ×' + s }, '×' + s);
        b.addEventListener('click', function () { self.setSpeed(s); });
        o.speed.appendChild(b);
      });
    }
    if (o.pause) o.pause.addEventListener('click', function () { self.toggle(); });
    this._emit();
  };
  Clock.prototype._paintUI = function () {
    var o = this._ui; if (!o) return;
    if (o.clock) {
      var txt = util.fmtTime(this.t);
      if (o.clock._txt !== txt) { o.clock._txt = txt; o.clock.innerHTML = '<small>Temps procédé</small>' + txt; }
    }
    if (o.speed) Array.prototype.forEach.call(o.speed.children, function (b) {
      b.setAttribute('aria-pressed', String(+b.getAttribute('data-speed') === this.speed));
    }, this);
    if (o.pause) {
      var lbl = this.paused ? '▶ Reprendre' : 'Ⅱ Pause';
      if (o.pause.textContent !== lbl) o.pause.textContent = lbl;
      o.pause.setAttribute('aria-pressed', String(this.paused));
    }
  };
  ZHSim.Clock = Clock;

  /* ------------------------------------------------------------------- PID */
  /**
   * PID forme standard (ISA) en vitesse, sortie 0..100 %.
   * reverse:true -> la sortie augmente quand PV > SP (ex. vanne de refroidissement).
   * Passage MAN -> AUTO sans à-coup (l'intégrale reprend la sortie courante).
   */
  function PID(o) {
    o = o || {};
    this.kp = o.kp || 1; this.ti = o.ti || 60; this.td = o.td || 0;
    this.outMin = o.outMin === undefined ? 0 : o.outMin; this.outMax = o.outMax === undefined ? 100 : o.outMax;
    this.reverse = !!o.reverse; this.sp = o.sp || 0; this.mode = o.mode || 'AUTO';
    this.out = o.bias === undefined ? 50 : o.bias; this._e1 = null; this._pv1 = null;
  }
  PID.prototype.update = function (pv, dt) {
    if (this.mode !== 'AUTO') { this._e1 = null; this._pv1 = pv; return this.out; }
    var e = (this.reverse ? pv - this.sp : this.sp - pv);
    if (this._e1 === null) { this._e1 = e; this._pv1 = pv; }
    // forme vitesse : Δu = Kp·[Δe + dt/Ti·e] + Kp·Td·Δ²PV/dt (dérivée sur la mesure, simplifiée au 1er ordre)
    var dpv = (this.reverse ? 1 : -1) * (pv - this._pv1);
    var d = this.kp * ((e - this._e1) + dt / this.ti * e);
    if (this.td) d += this.kp * this.td * (dpv - (this._dpv1 || 0)) / dt;
    this._dpv1 = dpv;
    this.out = util.clamp(this.out + d, this.outMin, this.outMax);
    this._e1 = e; this._pv1 = pv;
    return this.out;
  };
  PID.prototype.setMode = function (m) { this.mode = m; this._e1 = null; this._dpv1 = 0; };
  ZHSim.PID = PID;

  /* ----------------------------------------------------------------- Audio */
  var audio = {
    ctx: null, enabled: true,
    unlock: function () {
      try {
        if (!audio.ctx) { var C = global.AudioContext || global.webkitAudioContext; if (C) audio.ctx = new C(); }
        if (audio.ctx && audio.ctx.state === 'suspended') audio.ctx.resume();
      } catch (e) { audio.ctx = null; }
    },
    beep: function (prio) {
      if (!audio.enabled || !audio.ctx) return;
      try {
        var c = audio.ctx, t0 = c.currentTime, n = prio === 1 ? 2 : 1;
        for (var i = 0; i < n; i++) {
          var o = c.createOscillator(), g = c.createGain();
          o.type = 'sine'; o.frequency.value = prio === 1 ? 880 : 660;
          g.gain.setValueAtTime(0.0001, t0 + i * 0.22);
          g.gain.exponentialRampToValueAtTime(0.06, t0 + i * 0.22 + 0.02);
          g.gain.exponentialRampToValueAtTime(0.0001, t0 + i * 0.22 + 0.16);
          o.connect(g); g.connect(c.destination); o.start(t0 + i * 0.22); o.stop(t0 + i * 0.22 + 0.18);
        }
      } catch (e) { /* audio facultatif */ }
    }
  };
  ZHSim.audio = audio;
  document.addEventListener('pointerdown', audio.unlock, { once: false, passive: true });

  /* ---------------------------------------------------------------- Alarms */
  /**
   * Gestionnaire d'alarmes (états ISA-18.2 simplifiés) :
   *   NORM  -> UNACK (active, non acquittée, clignote) -> ACKED (active, fixe)
   *   UNACK -> RTNUN (revenue à la normale sans acquittement) -> NORM après acquittement
   * Priorités : 1 = haute (rouge, carré), 2 = moyenne (ambre, triangle), 3 = info (bleu, rond).
   * Les éléments `targets` reçoivent les classes zh-alm-<prio> et zh-unack.
   */
  function Alarms(o) {
    o = o || {};
    this.defs = {}; this.order = []; this.state = {};
    this.clock = o.clock || null; this.recorder = o.recorder || null;
    this.onChange = o.onChange || function () {};
    this.container = util.$(o.container);
    this.firstAlarmTime = null; this._dirty = true; this._lastBeep = -1e9; this.muted = false;
    audio.enabled = o.sound !== false;
    this._buildUI();
    var self = this; this._beepTimer = setInterval(function () { self._beepTick(); }, 1000);
  }
  Alarms.prototype._now = function () { return this.clock ? this.clock.t : 0; };
  Alarms.prototype.define = function (id, d) {
    d = d || {}; d.priority = d.priority || 2; d.tag = d.tag || id; d.label = d.label || id;
    d.targets = (d.targets || []).map(function (t) { return typeof t === 'string' ? document.querySelectorAll(t) : [t]; })
      .reduce(function (a, l) { return a.concat(Array.prototype.slice.call(l)); }, []);
    this.defs[id] = d; this.order.push(id);
    this.state[id] = { st: 'NORM', t: null, value: '' };
    return this;
  };
  Alarms.prototype.set = function (id, active, valueText) {
    var s = this.state[id], d = this.defs[id]; if (!s) return;
    if (valueText !== undefined) s.value = valueText;
    var prev = s.st;
    if (active) {
      if (s.st === 'NORM' || s.st === 'RTNUN') {
        if (s.st === 'NORM') {
          s.t = this._now(); s.st = 'UNACK';
          if (this.firstAlarmTime === null) this.firstAlarmTime = s.t;
          if (this.recorder) this.recorder.event(d.priority === 1 ? 'alarm' : 'alarm2', d.tag + ' ' + d.label, { id: id });
          if (!this.muted) audio.beep(d.priority);
          this._lastBeep = Date.now();
        } else s.st = 'UNACK';
      }
    } else {
      if (s.st === 'UNACK') s.st = 'RTNUN';
      else if (s.st === 'ACKED') s.st = 'NORM';
    }
    if (prev !== s.st) this._dirty = true;
  };
  /** Seuil avec bande morte. dir 'H' : actif si v > seuil ; retour si v < seuil - bm. */
  Alarms.prototype.limit = function (id, v, lim, dir, db, valueText) {
    var s = this.state[id]; if (!s) return; db = db || 0;
    var on = s.st === 'UNACK' || s.st === 'ACKED';
    var act = dir === 'L' ? (on ? v < lim + db : v < lim) : (on ? v > lim - db : v > lim);
    this.set(id, act, valueText);
  };
  Alarms.prototype.ack = function (id) {
    var s = this.state[id]; if (!s) return;
    if (s.st === 'UNACK') s.st = 'ACKED'; else if (s.st === 'RTNUN') s.st = 'NORM'; else return;
    if (this.recorder) this.recorder.event('action', 'Acquittement ' + this.defs[id].tag, { ack: true });
    this._dirty = true;
  };
  Alarms.prototype.ackAll = function () { var self = this; this.order.forEach(function (id) { self.ack(id); }); };
  Alarms.prototype.isActive = function (id) { var s = this.state[id]; return !!s && (s.st === 'UNACK' || s.st === 'ACKED'); };
  Alarms.prototype.activeIds = function () { var self = this; return this.order.filter(function (id) { return self.isActive(id); }); };
  Alarms.prototype.unackCount = function () { var self = this; return this.order.filter(function (id) { var s = self.state[id].st; return s === 'UNACK' || s === 'RTNUN'; }).length; };
  Alarms.prototype.setSound = function (b) { audio.enabled = !!b; this._dirty = true; };
  Alarms.prototype.reset = function () {
    var self = this; this.order.forEach(function (id) { self.state[id] = { st: 'NORM', t: null, value: '' }; });
    this.firstAlarmTime = null; this._dirty = true; this.render();
  };
  Alarms.prototype._beepTick = function () {
    if (this.muted || !audio.enabled || (this.clock && this.clock.isHalted())) return;
    var best = 9, self = this;
    this.order.forEach(function (id) { if (self.state[id].st === 'UNACK') best = Math.min(best, self.defs[id].priority); });
    if (best <= 2 && Date.now() - this._lastBeep > 2500) { audio.beep(best); this._lastBeep = Date.now(); }
  };
  Alarms.prototype._buildUI = function () {
    var c = this.container; if (!c) return; var self = this;
    c.innerHTML = '<div class="zh-alarmbar-h"><span>Alarmes</span><span class="zh-count" data-r="count">0 active</span>' +
      '<span class="zh-spacer"></span>' +
      '<button type="button" class="zh-btn" data-r="snd" aria-pressed="true" title="Son des alarmes">🔔 Son</button>' +
      '<button type="button" class="zh-btn" data-r="ackall">Acquitter tout</button></div>' +
      '<ul class="zh-alarm-list" data-r="list" aria-live="polite"></ul>';
    this._list = c.querySelector('[data-r=list]'); this._count = c.querySelector('[data-r=count]');
    this._snd = c.querySelector('[data-r=snd]');
    c.querySelector('[data-r=ackall]').addEventListener('click', function () { self.ackAll(); self.render(); });
    this._snd.addEventListener('click', function () { self.setSound(!audio.enabled); self.render(); });
    this._list.addEventListener('click', function (e) {
      var li = e.target.closest('li[data-id]'); if (li) { self.ack(li.getAttribute('data-id')); self.render(); }
    });
  };
  /** À appeler à chaque image (peu coûteux : ne redessine que si nécessaire). */
  Alarms.prototype.render = function () {
    var self = this;
    // classes sur le synoptique
    this.order.forEach(function (id) {
      var s = self.state[id], d = self.defs[id];
      var on = s.st !== 'NORM', un = s.st === 'UNACK' || s.st === 'RTNUN';
      d.targets.forEach(function (el) {
        el.classList.toggle('zh-alm-' + d.priority, s.st === 'UNACK' || s.st === 'ACKED' || s.st === 'RTNUN');
        el.classList.toggle('zh-unack', on && un);
      });
    });
    if (!this._dirty || !this._list) return;
    this._dirty = false;
    var rows = this.order.filter(function (id) { return self.state[id].st !== 'NORM'; })
      .sort(function (a, b) { return self.defs[a].priority - self.defs[b].priority || self.state[b].t - self.state[a].t; });
    var act = this.activeIds().length;
    this._count.textContent = act + (act > 1 ? ' actives' : ' active') + (this.unackCount() ? ' · ' + this.unackCount() + ' à acquitter' : '');
    this._snd.setAttribute('aria-pressed', String(audio.enabled));
    this._snd.textContent = audio.enabled ? '🔔 Son' : '🔕 Muet';
    if (!rows.length) { this._list.innerHTML = '<li class="zh-alarm-empty" style="display:block;border:0;background:none;cursor:default">Aucune alarme. Installation en marche normale.</li>'; }
    else this._list.innerHTML = rows.map(function (id) {
      var s = self.state[id], d = self.defs[id], un = s.st === 'UNACK' || s.st === 'RTNUN';
      return '<li data-id="' + id + '" class="' + (un ? 'zh-unack ' : '') + (s.st === 'RTNUN' ? 'zh-rtn' : '') + '" title="Cliquer pour acquitter">' +
        '<span class="zh-prio zh-prio--' + d.priority + '">' + d.priority + '</span>' +
        '<span class="zh-t">' + util.fmtTime(s.t) + '</span>' +
        '<span class="zh-tagc">' + util.esc(d.tag) + '</span>' +
        '<span>' + util.esc(d.label) + (s.value ? ' <b class="zh-mono">' + util.esc(s.value) + '</b>' : '') + '</span>' +
        '<span class="zh-ack">' + (s.st === 'RTNUN' ? 'retour normal' : un ? 'à acquitter' : 'acquittée') + '</span></li>';
    }).join('');
    this.onChange(this);
  };
  ZHSim.Alarms = Alarms;

  /* -------------------------------------------------------------- Recorder */
  function Recorder(o) {
    o = o || {}; this.clock = o.clock || null; this.every = o.every || 2; this.reset();
  }
  Recorder.prototype.reset = function () { this.samples = []; this.snaps = []; this.events = []; this._next = 0; };
  Recorder.prototype.tick = function (t, values, snapFn) {
    if (t + 1e-9 < this._next) return;
    this._next = t + this.every;
    var s = { t: t }; for (var k in values) s[k] = values[k];
    this.samples.push(s);
    if (snapFn) this.snaps.push({ t: t, state: snapFn() });
  };
  Recorder.prototype.event = function (type, label, extra) {
    var e = { t: this.clock ? this.clock.t : 0, type: type, label: label };
    if (extra) for (var k in extra) e[k] = extra[k];
    this.events.push(e); return e;
  };
  Recorder.prototype.first = function (type, pred) {
    for (var i = 0; i < this.events.length; i++) { var e = this.events[i]; if (e.type === type && (!pred || pred(e))) return e; }
    return null;
  };
  ZHSim.Recorder = Recorder;

  /* ------------------------------------------------------------ Trend/chart */
  var EV_COLORS = { incident: '#1d2329', alarm: '#d0021b', alarm2: '#c27c0e', action: '#2f6fdf', note: '#00a3a1', outcome: '#1d2329', info: '#5f666d' };

  function setupCanvas(cv) {
    var dpr = Math.min(global.devicePixelRatio || 1, 2);
    var w = cv.clientWidth || 600, h = cv.clientHeight || 170;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
    var ctx = cv.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx: ctx, w: w, h: h };
  }

  /**
   * Dessin commun aux tendances temps réel et au graphique du débriefing.
   * o.series : [{key,label,color,dash,width,axis:'y'|'y2'}]
   */
  /** Graduation d'axe : entier si possible, sinon une décimale, virgule à la française. */
  function numAxis(v) { var r = Math.abs(v) >= 20 || Math.abs(v - Math.round(v)) < 0.05 ? String(Math.round(v)) : v.toFixed(1).replace('.', ','); return r === '-0' ? '0' : r; }

  function drawChart(cv, o, data, t0, t1, events) {
    var c = setupCanvas(cv), ctx = c.ctx, W = c.w, H = c.h;
    var narrow = W < 420;
    var hasUnit = !!(o.y.unit || (o.y2 && o.y2.unit));
    var L = narrow ? 34 : 44, R = o.y2 ? (narrow ? 34 : 44) : 10, T = hasUnit ? 20 : 10, B = 20;
    var pw = W - L - R, ph = H - T - B;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#f4f5f5'; if (o.white) ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);
    if (t1 <= t0) t1 = t0 + 1;
    var X = function (t) { return L + (t - t0) / (t1 - t0) * pw; };
    var Y = function (v, ax) { var a = ax === 'y2' ? o.y2 : o.y; return T + ph - (v - a.min) / (a.max - a.min) * ph; };
    // grille
    ctx.strokeStyle = '#dde0e2'; ctx.lineWidth = 1; ctx.font = '10px ui-monospace, Menlo, monospace'; ctx.fillStyle = '#5f666d';
    var nY = 5;
    for (var i = 0; i <= nY; i++) {
      var yy = T + ph * i / nY; ctx.beginPath(); ctx.moveTo(L, yy + .5); ctx.lineTo(L + pw, yy + .5); ctx.stroke();
      var v = o.y.max - (o.y.max - o.y.min) * i / nY; ctx.textAlign = 'right'; ctx.fillText(numAxis(v), L - 4, yy + 3);
      if (o.y2) { var v2 = o.y2.max - (o.y2.max - o.y2.min) * i / nY; ctx.textAlign = 'left'; ctx.fillText(numAxis(v2), L + pw + 4, yy + 3); }
    }
    // axe temps
    var span = t1 - t0, stepT = [30, 60, 120, 300, 600, 900, 1800, 3600].filter(function (s) { return span / s <= (narrow ? 5 : 8); })[0] || 3600;
    ctx.textAlign = 'center';
    for (var tt = Math.ceil(t0 / stepT) * stepT; tt <= t1; tt += stepT) {
      var xx = X(tt); ctx.beginPath(); ctx.moveTo(xx + .5, T); ctx.lineTo(xx + .5, T + ph); ctx.stroke();
      ctx.fillText(util.fmtTime(tt), xx, H - 6);
    }
    ctx.textAlign = 'left';
    if (o.y.unit) ctx.fillText(o.y.unit, 2, 10);
    if (o.y2 && o.y2.unit) { ctx.textAlign = 'right'; ctx.fillText(o.y2.unit, W - 2, 10); ctx.textAlign = 'left'; }
    // seuils
    var placed = [];
    (o.limits || []).forEach(function (l) {
      var yy = Y(l.value, l.axis); if (yy < T || yy > T + ph) return;
      ctx.save(); ctx.strokeStyle = l.color || '#d0021b'; ctx.setLineDash([5, 4]); ctx.globalAlpha = .8;
      ctx.beginPath(); ctx.moveTo(L, yy + .5); ctx.lineTo(L + pw, yy + .5); ctx.stroke(); ctx.restore();
      if (l.label) {
        var lx = L + 4, lw = ctx.measureText(l.label).width;
        placed.forEach(function (q) { if (Math.abs(q.y - yy) < 11 && lx < q.x2 + 6) lx = q.x2 + 6; });
        placed.push({ y: yy, x2: lx + lw });
        ctx.fillStyle = l.color || '#d0021b'; ctx.fillText(l.label, lx, yy - 3);
      }
    });
    // courbes
    ctx.save(); ctx.beginPath(); ctx.rect(L, T, pw, ph); ctx.clip();
    o.series.forEach(function (s) {
      ctx.strokeStyle = s.color; ctx.lineWidth = s.width || 2; ctx.setLineDash(s.dash || []); ctx.beginPath();
      var started = false;
      for (var j = 0; j < data.length; j++) {
        var d = data[j]; if (d.t < t0 - 5) continue; var v = d[s.key]; if (v === undefined || v === null || isNaN(v)) { started = false; continue; }
        var px = X(d.t), py = Y(v, s.axis);
        if (!started) { ctx.moveTo(px, py); started = true; } else ctx.lineTo(px, py);
      }
      ctx.stroke();
    });
    ctx.setLineDash([]);
    // événements (marqueurs verticaux numérotés)
    var nEv = 0;
    (events || []).forEach(function (e) {
      if (e.t < t0 || e.t > t1 || e.ack) return;
      var xx = X(e.t), col = EV_COLORS[e.type] || '#5f666d';
      ctx.strokeStyle = col; ctx.globalAlpha = .55; ctx.lineWidth = 1; ctx.setLineDash([2, 2]);
      ctx.beginPath(); ctx.moveTo(xx + .5, T); ctx.lineTo(xx + .5, T + ph); ctx.stroke(); ctx.globalAlpha = 1; ctx.setLineDash([]);
      if (o.numbered) {
        nEv++; e._n = nEv;
        var yb = T + 4 + ((nEv - 1) % 3) * 15;
        ctx.fillStyle = col; ctx.beginPath(); ctx.arc(xx, yb + 5, 7, 0, 7); ctx.fill();
        ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.font = 'bold 9px ui-monospace, Menlo, monospace'; ctx.fillText(nEv, xx, yb + 8);
        ctx.textAlign = 'left'; ctx.font = '10px ui-monospace, Menlo, monospace';
      }
    });
    ctx.restore();
    ctx.strokeStyle = '#b6bcc1'; ctx.strokeRect(L + .5, T + .5, pw, ph);
  }

  function Trend(cv, o) {
    this.cv = util.$(cv); this.o = o; this.window = o.window || 600; this.data = []; this.marks = [];
    if (o.legend) {
      var lg = util.$(o.legend); lg.classList.add('zh-legend');
      lg.innerHTML = o.series.map(function (s) {
        return '<span><i class="' + (s.dash ? 'zh-dash' : '') + '" style="border-color:' + s.color + '"></i>' + util.esc(s.label) + '</span>';
      }).join('') + (o.limits || []).filter(function (l) { return l.legend; }).map(function (l) {
        return '<span><i class="zh-dash" style="border-color:' + l.color + '"></i>' + util.esc(l.legend) + '</span>';
      }).join('');
    }
    this._lastDraw = 0;
  }
  Trend.prototype.push = function (t, v) {
    var s = { t: t }; for (var k in v) s[k] = v[k]; this.data.push(s);
    if (this.data.length > 4000) this.data.splice(0, 1000);
  };
  Trend.prototype.mark = function (t, label, type) { this.marks.push({ t: t, label: label, type: type || 'info' }); };
  Trend.prototype.clear = function () { this.data = []; this.marks = []; };
  Trend.prototype.draw = function (force) {
    var now = performance.now(); if (!force && now - this._lastDraw < 66) return; this._lastDraw = now;
    if (!this.cv || !this.cv.offsetParent) return;
    var tEnd = this.data.length ? this.data[this.data.length - 1].t : 0;
    var t1 = Math.max(this.window, tEnd), t0 = t1 - this.window;
    drawChart(this.cv, this.o, this.data, t0, t1, this.marks);
  };
  ZHSim.Trend = Trend;
  ZHSim.chart = function (cv, o) {
    var tMax = o.tMax || (o.samples.length ? o.samples[o.samples.length - 1].t : 60);
    drawChart(util.$(cv), Object.assign({ white: true, numbered: true }, o), o.samples, 0, tMax, o.events);
  };

  /* --------------------------------------------------------------- Overlay */
  function overlay(id) {
    var ov = document.getElementById(id);
    if (!ov) { ov = util.el('div', { id: id, class: 'zh-overlay', role: 'dialog', 'aria-modal': 'true' }); document.body.appendChild(ov); }
    ov.hidden = false; return ov;
  }
  ZHSim.closeOverlays = function () { Array.prototype.forEach.call(document.querySelectorAll('.zh-overlay'), function (o) { o.hidden = true; }); };

  var LEGAL = ' <span class="zh-legal-links"><a href="simulateurs.html" data-zh-keep-src>Tous les simulateurs</a> · <a href="mentions-legales.html">Mentions légales</a></span>';
  function levelHTML(n) { var s = ''; for (var i = 1; i <= 3; i++) s += '<i class="' + (i <= n ? 'on' : '') + '"></i>'; return s; }

  /* -------------------------------------------------------------- Briefing */
  ZHSim.briefing = function (o) {
    var ov = overlay('zh-briefing');
    ov.innerHTML = '<div class="zh-modal">' +
      '<div class="zh-modal-h"><div class="zh-kicker">' + util.esc(o.kicker || 'Briefing de prise de poste') + '</div><h1>' + util.esc(o.title) + '</h1></div>' +
      '<div class="zh-modal-b">' +
      '<div class="zh-brief-grid"><div><h3 style="margin-top:0">Votre rôle</h3><p>' + o.role + '</p></div>' +
      '<div><h3 style="margin-top:0">Objectif</h3><p>' + o.objective + '</p></div></div>' +
      (o.rules && o.rules.length ? '<h3>Consignes du poste</h3><ul class="zh-seq">' + o.rules.map(function (r) { return '<li>' + r + '</li>'; }).join('') + '</ul>' : '') +
      '<h3>Choisissez votre scénario</h3><div class="zh-scn-list">' +
      o.scenarios.map(function (s) {
        return '<button type="button" class="zh-scn-card' + (s.mystery ? ' zh-mystery' : '') + '" data-id="' + s.id + '">' +
          '<span class="zh-level">' + levelHTML(s.level || 1) + ' ' + (['', 'Découverte', 'Confirmé', 'Expert'][s.level || 1]) + '</span>' +
          '<b>' + util.esc(s.title) + '</b><span class="zh-tagline">' + s.desc + '</span></button>';
      }).join('') + '</div>' +
      '<p class="zh-note">' + (o.footer || 'Démo pédagogique : modèle simplifié, paramètres plausibles mais génériques. Elle ne remplace pas les consignes de votre site.') + LEGAL + '</p>' +
      '</div></div>';
    Array.prototype.forEach.call(ov.querySelectorAll('.zh-scn-card'), function (b) {
      b.addEventListener('click', function () { audio.unlock(); ov.hidden = true; o.onStart(b.getAttribute('data-id')); });
    });
    var first = ov.querySelector('.zh-scn-card'); if (first) setTimeout(function () { first.focus({ preventScroll: true }); }, 50);
    ov.scrollTop = 0;
    contact.bind(ov);
  };

  /* --------------------------------------------------------------- Score */
  ZHSim.score = function (s) {
    var r = {
      securite: Math.round(50 * util.clamp(s.securite || 0, 0, 1)),
      production: Math.round(30 * util.clamp(s.production || 0, 0, 1)),
      reactivite: Math.round(20 * util.clamp(s.reactivite || 0, 0, 1))
    };
    r.total = r.securite + r.production + r.reactivite; return r;
  };

  /* -------------------------------------------------------------- Debrief */
  ZHSim.debrief = function (o) {
    var sc = ZHSim.score(o.scores), ov = overlay('zh-debrief'), det = o.details || {};
    var evs = (o.recorder ? o.recorder.events : []).filter(function (e) { return !e.ack; });
    function bar(v, max) { return '<div class="zh-bar"><i style="width:' + (100 * v / max) + '%"></i></div>'; }
    ov.innerHTML = '<div class="zh-modal">' +
      '<div class="zh-modal-h"><div class="zh-kicker">' + util.esc(o.kicker || 'Débriefing') + '</div><h2>' + util.esc(o.title || '') + '</h2></div>' +
      '<div class="zh-modal-b">' +
      '<div class="zh-score-head"><div class="zh-score-big">' + sc.total + '<small>/100</small></div>' +
      '<div><div class="zh-outcome' + (o.outcome && o.outcome.bad ? ' zh-bad' : '') + '">' + util.esc(o.outcome ? o.outcome.label : '') + '</div>' +
      (o.outcome && o.outcome.text ? '<div style="font-size:13.5px;margin-top:4px;max-width:560px">' + o.outcome.text + '</div>' : '') + '</div></div>' +
      '<div class="zh-scale">' +
      '<div>Sécurité <span class="zh-mono">(50 %)</span><b>' + sc.securite + ' / 50</b>' + bar(sc.securite, 50) + (det.securite ? '<div style="margin-top:4px">' + det.securite + '</div>' : '') + '</div>' +
      '<div>' + util.esc(o.productionLabel || 'Production / qualité') + ' <span class="zh-mono">(30 %)</span><b>' + sc.production + ' / 30</b>' + bar(sc.production, 30) + (det.production ? '<div style="margin-top:4px">' + det.production + '</div>' : '') + '</div>' +
      '<div>Réactivité <span class="zh-mono">(20 %)</span><b>' + sc.reactivite + ' / 20</b>' + bar(sc.reactivite, 20) + (det.reactivite ? '<div style="margin-top:4px">' + det.reactivite + '</div>' : '') + '</div>' +
      '</div>' +
      '<h3>Indicateurs</h3><div class="zh-stats">' + (o.stats || []).map(function (s) { return '<div>' + util.esc(s.label) + '<b>' + s.value + '</b></div>'; }).join('') + '</div>' +
      '<h3>Tendance et chronologie annotée</h3><canvas class="zh-debrief-canvas" data-r="chart"></canvas><div data-r="legend"></div>' +
      '<ul class="zh-timeline" data-r="tl" style="margin-top:8px"></ul>' +
      '<div class="zh-cols"><div><h3>3 points clés</h3><ol class="zh-keypoints">' + (o.keyPoints || []).map(function (k) { return '<li>' + k + '</li>'; }).join('') + '</ol></div>' +
      '<div><h3>La bonne séquence de réaction</h3><ol class="zh-seq">' + (o.sequence || []).map(function (k) { return '<li>' + k + '</li>'; }).join('') + '</ol></div></div>' +
      (o.extraHTML || '') +
      '<div class="zh-actions-row">' +
      (o.onReplay ? '<button type="button" class="zh-btn zh-btn--primary" data-r="replay">▶ Revoir ma partie (×20)</button>' : '') +
      '<button type="button" class="zh-btn" data-r="retry">↻ Rejouer</button>' +
      '<button type="button" class="zh-btn" data-r="other">Essayer un autre scénario</button></div>' +
      '<div class="zh-cta-box"><p><b>Vos opérateurs, vos procédés, vos incidents.</b> Nous construisons ces scénarios à partir de vos installations, et un formateur anime la séance. Diagnostic de 30 minutes offert.</p>' +
      '<a class="zh-btn zh-btn--accent" data-r="mail" href="#">Former mes équipes →</a></div>' +
      '<p class="zh-note">Démo pédagogique — ne remplace pas les consignes de votre site. Modèle simplifié à visée de formation.' + LEGAL + '</p>' +
      '</div></div>';
    ov.scrollTop = 0; contact.bind(ov);
    var mail = ov.querySelector('[data-r=mail]');
    mail.setAttribute('href', contact.mailto(o.mailBody ? o.mailBody.replace('{score}', sc.total) : ('Bonjour,\n\nJ’ai essayé la démo « ' + (o.title || '') + ' » (score ' + sc.total + '/100). J’aimerais échanger sur la formation de nos opérateurs.\n\n')));
    var bind = function (r, fn) { var b = ov.querySelector('[data-r=' + r + ']'); if (b && fn) b.addEventListener('click', function () { ov.hidden = true; fn(); }); };
    bind('replay', o.onReplay); bind('retry', o.onRetry); bind('other', o.onOther);
    // graphique
    if (o.chart && o.recorder) {
      var cv = ov.querySelector('[data-r=chart]');
      var draw = function () {
        ZHSim.chart(cv, { series: o.chart.series, y: o.chart.y, y2: o.chart.y2, limits: o.chart.limits, samples: o.recorder.samples, events: evs });
      };
      requestAnimationFrame(draw);
      var lg = ov.querySelector('[data-r=legend]'); lg.className = 'zh-legend';
      lg.innerHTML = o.chart.series.map(function (s) { return '<span><i class="' + (s.dash ? 'zh-dash' : '') + '" style="border-color:' + s.color + '"></i>' + util.esc(s.label) + '</span>'; }).join('') +
        '<span><i class="zh-dash" style="border-color:#1d2329"></i>événements numérotés ci-dessous</span>';
      if (global.ResizeObserver) new ResizeObserver(function () { draw(); }).observe(cv);
    }
    var tl = ov.querySelector('[data-r=tl]'); var n = 0;
    tl.innerHTML = evs.map(function (e) {
      n++;
      var cls = { incident: 'zh-ev-incident', alarm: 'zh-ev-alarm', alarm2: 'zh-ev-alarm2', action: 'zh-ev-action', note: 'zh-ev-note' }[e.type] || '';
      return '<li><span class="zh-t">' + util.fmtTime(e.t) + '</span><span class="zh-ev-i ' + cls + '" title="' + e.type + '"></span><span><b class="zh-mono">' + n + '.</b> ' + util.esc(e.label) + '</span></li>';
    }).join('') || '<li><span></span><span></span><span>Aucun événement.</span></li>';
    return sc;
  };

  /* --------------------------------------------------------------- Toast */
  var toastEl = null, toastTimer = 0;
  /* Le message ne doit jamais masquer une mesure du synoptique :
     - ordinateur : à droite du titre « Tendances » (zone sans information procédé) ;
     - mobile : sur la ligne du scénario, dans l'en-tête. */
  function placeToast(el) {
    var st = el.style; st.left = st.right = st.top = st.bottom = st.maxWidth = st.transform = '';
    el.classList.remove('zh-toast--dock');
    var vw = document.documentElement.clientWidth, vh = global.innerHeight;
    var sum = document.querySelector('.zh-trends > summary');
    if (global.matchMedia('(min-width: 901px)').matches && sum) {
      var tr = sum.parentNode.getBoundingClientRect(), sr = sum.getBoundingClientRect();
      var rg = document.createRange(); rg.selectNodeContents(sum); var textRight = rg.getBoundingClientRect().right;
      var avail = tr.right - textRight - 28;
      if (sr.top > 40 && sr.bottom < vh && avail > 260) {
        el.classList.add('zh-toast--dock');
        st.transform = 'none'; st.left = 'auto'; st.right = Math.max(8, vw - tr.right + 10) + 'px'; st.maxWidth = avail + 'px';
        st.top = Math.max(4, sr.top + (sr.height - el.offsetHeight) / 2) + 'px';
        return;
      }
    }
    var scn = document.querySelector('.zh-header .zh-scn'), hdr = document.querySelector('.zh-header');
    if (scn && hdr) {
      var r = scn.getBoundingClientRect(), hr = hdr.getBoundingClientRect();
      if (r.width > 0 && hr.bottom > 0) {
        st.transform = 'none'; st.left = '8px'; st.right = '8px'; st.maxWidth = 'none';
        st.top = Math.max(4, Math.min(r.bottom, hr.bottom) - el.offsetHeight) + 'px';
      }
    }
  }
  ZHSim.toast = function (txt, kind, ms) {
    if (!toastEl) { toastEl = util.el('div', { class: 'zh-toast', role: 'status' }); document.body.appendChild(toastEl); }
    toastEl.className = 'zh-toast' + (kind ? ' zh-toast--' + kind : '');
    toastEl.innerHTML = txt; toastEl.style.opacity = 1; toastEl.hidden = false;
    placeToast(toastEl);
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { toastEl.style.opacity = 0; setTimeout(function () { toastEl.hidden = true; }, 320); }, ms || 3200);
  };

  /* -------------------------------------------------------------- Trainer */
  /**
   * Mode formateur : touche F (hors champ de saisie) ou clic sur [data-zh-trainer].
   * faults : [{id, label, inject()}] -> bouton ; une panne injectée est journalisée
   * (type 'incident', libellé « Formateur : … ») puis le bouton est désactivé.
   */
  function Trainer(o) {
    this.o = o; var self = this;
    var p = this.el = util.el('div', { class: 'zh-trainer', role: 'dialog', 'aria-label': 'Mode formateur' });
    p.hidden = true;
    p.innerHTML = '<div class="zh-trainer-h"><span>Mode formateur</span><button type="button" aria-label="Fermer">×</button></div>' +
      '<div class="zh-trainer-b"><h4>Injecter une panne</h4><div data-r="faults" style="display:flex;flex-direction:column;gap:5px"></div>' +
      '<h4>Séance</h4><button type="button" class="zh-btn" data-r="freeze">❄ Geler la simulation</button>' +
      '<div data-r="extra"></div>' +
      '<h4>Annoter (visible au débriefing)</h4><textarea data-r="note" placeholder="Ex. : l’opérateur hésite, il cherche la cause avant d’agir"></textarea>' +
      '<button type="button" class="zh-btn zh-btn--primary" data-r="add">Ajouter l’annotation</button>' +
      '<p class="zh-hint">C’est le rôle du formateur : provoquer, faire verbaliser, puis débriefer sur la courbe. Touche F pour ouvrir ou fermer ; le panneau se déplace par son titre.</p></div>';
    document.body.appendChild(p);
    p.querySelector('.zh-trainer-h button').addEventListener('click', function () { self.close(); });
    // panneau déplaçable par son titre : le formateur le pose là où il ne gêne pas la lecture
    var hd = p.querySelector('.zh-trainer-h'), drag = null;
    hd.title = 'Glisser pour déplacer le panneau';
    hd.addEventListener('pointerdown', function (e) {
      if (e.target.closest('button')) return;
      var r = p.getBoundingClientRect(); drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
      hd.setPointerCapture(e.pointerId); e.preventDefault();
    });
    hd.addEventListener('pointermove', function (e) {
      if (!drag) return;
      var vw = document.documentElement.clientWidth, vh = global.innerHeight, w = p.offsetWidth;
      p.style.left = util.clamp(e.clientX - drag.dx, 0, vw - w) + 'px'; p.style.top = util.clamp(e.clientY - drag.dy, 0, vh - 40) + 'px';
      p.style.right = 'auto'; p.style.bottom = 'auto';
    });
    hd.addEventListener('pointerup', function () { drag = null; });
    var fz = p.querySelector('[data-r=freeze]');
    fz.addEventListener('click', function () {
      var c = o.clock; c.freeze(!c.frozen);
      if (o.recorder) o.recorder.event('note', c.frozen ? 'Formateur : simulation gelée' : 'Formateur : reprise');
      self.sync();
    });
    p.querySelector('[data-r=add]').addEventListener('click', function () {
      var ta = p.querySelector('[data-r=note]'), v = ta.value.trim(); if (!v) return;
      if (o.recorder) o.recorder.event('note', 'Note : ' + v);
      if (o.onNote) o.onNote(v);
      ta.value = ''; ZHSim.toast('Annotation ajoutée à ' + util.fmtTime(o.clock.t), 'note', 1800);
    });
    if (o.extra) o.extra(p.querySelector('[data-r=extra]'));
    this.setFaults(o.faults || []);
    document.addEventListener('keydown', function (e) {
      if ((e.key === 'f' || e.key === 'F') && !e.ctrlKey && !e.metaKey && !e.altKey && !/INPUT|TEXTAREA|SELECT/.test((e.target.tagName || ''))) self.toggle();
    });
    document.addEventListener('click', function (e) { var t = e.target.closest && e.target.closest('[data-zh-trainer]'); if (t) { e.preventDefault(); self.toggle(); } });
    this._flag = null;
  }
  Trainer.prototype.setFaults = function (faults) {
    var self = this, box = this.el.querySelector('[data-r=faults]'); box.innerHTML = '';
    faults.forEach(function (f) {
      var b = util.el('button', { type: 'button', class: 'zh-btn zh-fault-btn' }, util.esc(f.label));
      b.addEventListener('click', function () {
        if (b.disabled) return; f.inject();
        if (self.o.recorder) self.o.recorder.event('incident', 'Formateur : ' + f.label);
        b.disabled = true; ZHSim.toast('Panne injectée : ' + util.esc(f.label), 'note', 1800);
      });
      box.appendChild(b);
    });
  };
  Trainer.prototype.sync = function () {
    var fz = this.el.querySelector('[data-r=freeze]'), c = this.o.clock;
    fz.textContent = c.frozen ? '▶ Dégeler la simulation' : '❄ Geler la simulation';
    fz.setAttribute('aria-pressed', String(c.frozen));
    if (!this._flag) {
      var syn = document.querySelector('.zh-synoptic');
      if (syn) { this._flag = util.el('div', { class: 'zh-frozen-flag' }, 'SIMULATION GELÉE PAR LE FORMATEUR'); syn.appendChild(this._flag); }
    }
    if (this._flag) this._flag.hidden = !c.frozen;
  };
  Trainer.prototype.open = function () { this.el.hidden = false; this.sync(); };
  Trainer.prototype.close = function () { this.el.hidden = true; };
  Trainer.prototype.toggle = function () { this.el.hidden ? this.open() : this.close(); };
  ZHSim.Trainer = Trainer;

  /* --------------------------------------------------------------- Replay */
  /**
   * Rejoue les instantanés du Recorder (snaps) à `speed` × le temps procédé.
   * render(state, t) doit redessiner le synoptique ; les événements défilent en bandeau.
   */
  ZHSim.replay = function (o) {
    var rec = o.recorder, snaps = rec.snaps, speed = o.speed || 20;
    if (!snaps.length) { if (o.onEnd) o.onEnd(); return; }
    var bar = document.getElementById('zh-replay-bar');
    if (!bar) {
      bar = util.el('div', { id: 'zh-replay-bar', class: 'zh-replay-bar' });
      bar.innerHTML = '<b>Rejeu ×' + speed + '</b><span class="zh-mono" data-r="t"></span><progress max="1" value="0"></progress><button type="button" class="zh-btn">Terminer</button>';
      document.body.appendChild(bar);
    }
    bar.hidden = false;
    var tEl = bar.querySelector('[data-r=t]'), pr = bar.querySelector('progress'), btn = bar.querySelector('button');
    var tEnd = snaps[snaps.length - 1].t, t = 0, last = 0, idx = 0, evIdx = 0, stopped = false;
    var evs = rec.events.filter(function (e) { return !e.ack; });
    function end() { if (stopped) return; stopped = true; bar.hidden = true; if (o.onEnd) o.onEnd(); }
    btn.onclick = end;
    function frame(ts) {
      if (stopped) return;
      var rdt = last ? Math.min(0.1, (ts - last) / 1000) : 0; last = ts; t += rdt * speed;
      while (idx < snaps.length - 1 && snaps[idx + 1].t <= t) idx++;
      o.render(snaps[idx].state, snaps[idx].t);
      while (evIdx < evs.length && evs[evIdx].t <= t) {
        var e = evs[evIdx++];
        ZHSim.toast('<b class="zh-mono">' + util.fmtTime(e.t) + '</b> ' + util.esc(e.label), e.type === 'alarm' ? 'alarm' : e.type === 'note' ? 'note' : 'info', 1600);
      }
      tEl.textContent = util.fmtTime(t); pr.value = Math.min(1, t / tEnd);
      if (t >= tEnd + 1) { setTimeout(end, 900); stopped = false; o.render(snaps[snaps.length - 1].state, tEnd); return; }
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
    return { stop: end };
  };

  /* --------------------------------------------------------------- Drawer */
  ZHSim.drawer = function (panel, btn) {
    panel = util.$(panel); btn = util.$(btn); if (!panel || !btn) return;
    btn.addEventListener('click', function () {
      var open = panel.classList.toggle('zh-open'); btn.setAttribute('aria-expanded', String(open));
      btn.querySelector('[data-r=lbl]') && (btn.querySelector('[data-r=lbl]').textContent = open ? 'Fermer' : 'Commandes');
    });
  };

  /* Si le panneau contient une carte « toujours visible » (.zh-fp--sticky), les autres
     cartes sont placées dans une zone qui défile au-dessus d'elle : aucune carte n'en
     recouvre une autre, quelle que soit la hauteur de l'écran. */
  ZHSim.splitPanel = function () {
    var panel = document.getElementById('zh-panel'); if (!panel || panel.classList.contains('zh-split')) return;
    var sticky = panel.querySelector(':scope > .zh-fp--sticky'); if (!sticky) return;
    var sc = util.el('div', { class: 'zh-panel-scroll' });
    Array.prototype.slice.call(panel.childNodes).forEach(function (n) { if (n !== sticky) sc.appendChild(n); });
    panel.insertBefore(sc, sticky); panel.classList.add('zh-split');
  };
  global.addEventListener('load', function () { ZHSim.splitPanel(); });

  ZHSim.bindDemoBanner = function () {
    if (document.querySelector('.zh-demo-banner')) return;
    var b = util.el('div', { class: 'zh-demo-banner', role: 'note' }, '<b>Démo pédagogique</b> — ne remplace pas les consignes de votre site');
    document.body.insertBefore(b, document.body.firstChild);
  };

  document.addEventListener('DOMContentLoaded', function () { contact.bind(); });
  ZHSim.version = '1.0.0';
  global.ZHSim = ZHSim;
})(window);
