/* Fly Copycat — app logic: stroke recorder, live chase, trail, results.
 *
 * Data flow: humanCanvas pointer events -> timestamped strokes ->
 * pen tip replays as moving food target -> FlyBrain LIF steps ->
 * motor readout moves the fly -> trail on flyCanvas is the copy.
 */
'use strict';

window.Copycat = (function () {
  // Swap-in point for real sprites later: {fly: 'assets/sprites/fly.png', ...}
  // Frames auto-sliced as uniform grid; no other code changes needed.
  var SPRITES = {
    fly: null,   // e.g. {src: 'assets/sprites/bee.png', fw: 32, fh: 32, n: 4}
    hand: null
  };

  var W = 480, H = 480;
  var human, fly;
  var hx, fx; // 2d contexts

  var COLORS = ['#2b2b2b', '#e63b3b', '#2b7de6', '#2fae4e', '#ff9f1c', '#9b59b6'];
  var penColor = COLORS[0];
  var penWidth = 4;
  var erasing = false;

  var strokes = [];        // {pts: [{x,y,t}], color, width}
  var cur = null;
  var drawStartT = 0, drawEndT = 0;
  var drawing = false;
  var lastPen = null;      // {x, y, t, speed}

  var flyState = null;
  var brainReady = false;
  var brainTick = 0;
  var resultsShown = false;
  var lockN = 0, lockHit = 0;   // pursuit-lock samples
  var flyStartT = 0, flyEndT = 0;
  var lastOut = null;             // last brain readout (drives commentary)
  var lastSayT = 0, saidHello = false, saidLost = false;

  function $(id) { return document.getElementById(id); }

  function canvasPos(e, cv) {
    var r = cv.getBoundingClientRect();
    var sx = cv.width / r.width, sy = cv.height / r.height;
    return { x: (e.clientX - r.left) * sx, y: (e.clientY - r.top) * sy };
  }

  function setupToolbar() {
    var bar = $('penToolbar');
    COLORS.forEach(function (c) {
      var b = document.createElement('button');
      b.className = 'swatch' + (c === penColor ? ' sel' : '');
      b.style.background = c;
      b.title = c;
      b.onclick = function () {
        penColor = c; erasing = false;
        refreshToolbar();
      };
      bar.appendChild(b);
    });
    var er = document.createElement('button');
    er.className = 'toolbtn';
    er.textContent = 'Eraser';
    er.onclick = function () { erasing = !erasing; refreshToolbar(); };
    bar.appendChild(er);
    var clr = document.createElement('button');
    clr.className = 'toolbtn';
    clr.textContent = 'Clear';
    clr.onclick = function () { reset(); };
    bar.appendChild(clr);
  }

  function refreshToolbar() {
    var bar = $('penToolbar').children;
    for (var i = 0; i < bar.length; i++) {
      var el = bar[i];
      if (el.className.indexOf('swatch') === 0)
        el.classList.toggle('sel', el.style.background !== '' && rgb2hex(el.style.background) === penColor);
      if (el.textContent === 'Eraser') el.classList.toggle('sel', erasing);
    }
  }

  function rgb2hex(rgb) {
    var m = rgb.match(/\d+/g);
    if (!m) return rgb;
    return '#' + m.slice(0, 3).map(function (v) {
      var h = parseInt(v, 10).toString(16);
      return h.length === 1 ? '0' + h : h;
    }).join('');
  }

  function setupRecorder() {
    human.addEventListener('pointerdown', function (e) {
      e.preventDefault();
      human.setPointerCapture(e.pointerId);
      var p = canvasPos(e, human);
      var now = performance.now();
      if (erasing) { eraseAt(p); return; }
      if (!drawing) { drawing = true; drawStartT = now; }
      cur = { pts: [], color: penColor, width: penWidth };
      strokes.push(cur);
      pushPoint(p, now);
    });
    human.addEventListener('pointermove', function (e) {
      var p = canvasPos(e, human);
      var now = performance.now();
      if (erasing && e.buttons) { eraseAt(p); return; }
      if (!cur) return;
      e.preventDefault();
      pushPoint(p, now);
    });
    function endStroke() {
      if (cur) { drawEndT = performance.now(); cur = null; }
    }
    human.addEventListener('pointerup', endStroke);
    human.addEventListener('pointercancel', endStroke);
  }

  function pushPoint(p, now) {
    var prev = lastPen;
    var speed = 0;
    if (prev && now > prev.t) {
      speed = Math.hypot(p.x - prev.x, p.y - prev.y) / (now - prev.t) * 1000; // px/sec
    }
    lastPen = { x: p.x, y: p.y, t: now, speed: speed };
    cur.pts.push({ x: p.x, y: p.y, t: now });
    drawHumanStroke();
  }

  function eraseAt(p) {
    for (var i = strokes.length - 1; i >= 0; i--) {
      var pts = strokes[i].pts;
      for (var j = 0; j < pts.length; j++) {
        if (Math.hypot(pts[j].x - p.x, pts[j].y - p.y) < 14) {
          strokes.splice(i, 1);
          drawHumanStroke();
          return;
        }
      }
    }
  }

  function drawHumanStroke() {
    hx.clearRect(0, 0, W, H);
    strokes.forEach(function (s) {
      if (s.pts.length < 2) return;
      hx.strokeStyle = s.color;
      hx.lineWidth = s.width;
      hx.lineCap = 'round';
      hx.lineJoin = 'round';
      hx.beginPath();
      hx.moveTo(s.pts[0].x, s.pts[0].y);
      for (var i = 1; i < s.pts.length - 1; i++) {
        var mx = (s.pts[i].x + s.pts[i + 1].x) / 2;
        var my = (s.pts[i].y + s.pts[i + 1].y) / 2;
        hx.quadraticCurveTo(s.pts[i].x, s.pts[i].y, mx, my);
      }
      var last = s.pts[s.pts.length - 1];
      hx.lineTo(last.x, last.y);
      hx.stroke();
    });
  }

  function resetFly() {
    flyState = { x: W - 60, y: H - 60, heading: -Math.PI * 0.75, speed: 0,
                 trail: [], wing: 0, idle: true, dwellN: 0 };
  }

  // ---- live chase loop ----
  function loop() {
    if (!brainReady) { requestAnimationFrame(loop); return; }
    brainTick++;

    var target = lastPen; // pen tip replays as the moving food target
    if (target && flyState.idle) { flyState.idle = false; flyStartT = performance.now(); }

    if (!flyState.idle && target) {
      // brain steps at ~20Hz (every 3rd frame)
      if (brainTick % 3 === 0) {
        var dx = target.x - flyState.x, dy = target.y - flyState.y;
        var dist = Math.hypot(dx, dy);
        var angTo = Math.atan2(dy, dx);
        var rel = normAng(angTo - flyState.heading);
        lockN++;
        if (Math.abs(rel) < 0.26) lockHit++; // within ~15 deg
        var loom = Math.min(1, (target.speed || 0) / 900);
        if (dist < 40) loom *= 0.3; // close up: gentle
        // scent fades: frozen pen speed decays once the pen stops moving
        var age = performance.now() - (target.t || 0);
        if (age > 300) loom *= Math.exp(-(age - 300) / 500);
        var out = window.FlyBrain.step({ loom: loom, bearing: rel / Math.PI });

        // motor readout -> movement (geometric assist, documented in README)
        // base speed scales with drive: no stimulus smell, no motion
        var close = dist < 40;
        flyState.heading += out.steer * (close ? 0.05 : 0.12); // gentle near target
        var want = 0.6 + loom * 2.2 + out.forward * 0.9;
        if (out.escape > 0) want += 3.0; // Giant Fiber burst
        if (dist < 20) want *= 0.2;      // arrived: settle
        if (dist < 30) flyState.dwellN++; else flyState.dwellN = 0;
        flyState.speed += (want - flyState.speed) * 0.35;
        flyState.x += Math.cos(flyState.heading) * flyState.speed;
        flyState.y += Math.sin(flyState.heading) * flyState.speed;
        flyState.x = Math.max(8, Math.min(W - 8, flyState.x));
        flyState.y = Math.max(8, Math.min(H - 8, flyState.y));
        flyState.trail.push({ x: flyState.x, y: flyState.y });
        if (flyState.trail.length > 4000) flyState.trail.shift();
        lastOut = out;
        commentate(out, dist);
      }
    }
    flyState.wing += 0.6;
    drawFlyScene();
    checkFinished();
    requestAnimationFrame(loop);
  }

  function normAng(a) {
    while (a > Math.PI) a -= 2 * Math.PI;
    while (a < -Math.PI) a += 2 * Math.PI;
    return a;
  }

  function drawFlyScene() {
    fx.clearRect(0, 0, W, H);
    // fly trail = its copy of your drawing
    if (flyState.trail.length > 1) {
      fx.strokeStyle = '#e63b3b';
      fx.lineWidth = 3;
      fx.lineCap = 'round';
      fx.lineJoin = 'round';
      fx.beginPath();
      fx.moveTo(flyState.trail[0].x, flyState.trail[0].y);
      for (var i = 1; i < flyState.trail.length; i++)
        fx.lineTo(flyState.trail[i].x, flyState.trail[i].y);
      fx.stroke();
    }
    drawFlySprite(fx, flyState.x, flyState.y, flyState.heading, flyState.wing);
  }

  // Placeholder fly: yellow body + fluttering wings. Real sprite via SPRITES.fly later.
  function drawFlySprite(c, x, y, heading, wing) {
    c.save();
    c.translate(x, y);
    c.rotate(heading);
    var flap = Math.abs(Math.sin(wing)) * 0.9 + 0.2;
    c.fillStyle = 'rgba(255,255,255,0.85)';
    c.strokeStyle = '#5b3a1e';
    c.lineWidth = 2;
    c.beginPath(); c.ellipse(-2, -8 * flap, 7, 4, -0.5, 0, 7); c.fill(); c.stroke();
    c.beginPath(); c.ellipse(-2, 8 * flap, 7, 4, 0.5, 0, 7); c.fill(); c.stroke();
    c.fillStyle = '#ffcf3f';
    c.beginPath(); c.ellipse(0, 0, 10, 6, 0, 0, 7); c.fill(); c.stroke();
    c.fillStyle = '#5b3a1e';
    c.beginPath(); c.arc(9, 0, 4, 0, 7); c.fill();
    c.restore();
  }

  // Speech bubble driven by actual brain readout (transitions only, no spam)
  function say(text, mood) {
    var now = performance.now();
    if (now - lastSayT < 2500) return;
    lastSayT = now;
    var b = $('speech');
    b.textContent = text;
    b.classList.remove('hidden');
    if (mood) $('flyMood').textContent = mood;
    clearTimeout(say._t);
    say._t = setTimeout(function () { b.classList.add('hidden'); }, 2600);
  }

  function commentate(out, dist) {
    if (resultsShown) return;
    if (!saidHello) { saidHello = true; say('Smells food! Following your pen…', 'sniffing'); return; }
    if (out.escape > 0) { say('WOAH! My Giant Fiber just fired!', 'startled'); return; }
    if (dist > 200 && !saidLost) { saidLost = true; say('Lost the scent… where did it go?', 'confused'); return; }
    if (dist < 12 && saidLost) { saidLost = false; say('Found it! Tasty trail…', 'munching'); }
  }
  function checkFinished() {
    if (resultsShown || !drawing) return;
    var now = performance.now();
    var userDone = !cur && (now - drawEndT > 1500);
    if (!userDone) return;
    var t = lastPen;
    var d = t ? Math.hypot(t.x - flyState.x, t.y - flyState.y) : 999;
    var settled = (d < 20 && flyState.speed < 0.6) || flyState.dwellN > 45;
    var timedOut = now - drawEndT > 20000;
    if (settled || timedOut) {
      resultsShown = true;
      flyEndT = now;
      showResults();
    }
  }
  function downsample(pts, max) {
    if (pts.length <= max) return pts;
    var out = [], step = pts.length / max;
    for (var i = 0; i < max; i++) out.push(pts[Math.floor(i * step)]);
    return out;
  }

  // Dynamic Time Warping distance between two point sequences
  function dtw(a, b) {
    var n = a.length, m = b.length;
    var prev = new Array(m + 1).fill(Infinity);
    var curr = new Array(m + 1).fill(Infinity);
    prev[0] = 0;
    for (var i = 1; i <= n; i++) {
      curr[0] = Infinity;
      for (var j = 1; j <= m; j++) {
        var cost = Math.hypot(a[i - 1].x - b[j - 1].x, a[i - 1].y - b[j - 1].y);
        curr[j] = cost + Math.min(prev[j], curr[j - 1], prev[j - 1]);
      }
      var tmp = prev; prev = curr; curr = tmp;
    }
    return prev[m] / (n + m);
  }

  function showResults() {
    var humanPts = [];
    strokes.forEach(function (s) { humanPts = humanPts.concat(s.pts); });
    var trail = flyState.trail;
    var fidelity = 0;
    if (humanPts.length > 1 && trail.length > 1) {
      var a = downsample(humanPts, 200), b = downsample(trail, 200);
      var diag = Math.hypot(W, H);
      fidelity = Math.max(0, Math.round(100 * (1 - dtw(a, b) / (diag * 0.5))));
    }
    var stats = window.FlyBrain.stats();
    $('mFidelity').textContent = fidelity + '%';
    $('mHumanTime').textContent = ((drawEndT - drawStartT) / 1000).toFixed(1) + 's';
    $('mFlyTime').textContent = ((flyEndT - (flyStartT || drawStartT)) / 1000).toFixed(1) + 's';
    $('mSpikes').textContent = stats.spikesPerSec;
    $('mActive').textContent = stats.active + '/' + stats.neurons;
    $('mLock').textContent = lockN ? Math.round(100 * lockHit / lockN) + '%' : '—';
    $('flyMood').textContent = 'done!';
    lastSayT = 0; // let the finale line through
    say('Done! ' + fidelity + '% — not bad for 332 neurons!', 'proud');
    var again = $('btnAgain');
    again.classList.remove('hidden');
    again.onclick = function () { reset(); };
    if (window.CopycatOnResults) window.CopycatOnResults({ fidelity: fidelity });
  }

  function setMetricsDefault() {
    $('mFidelity').textContent = '—';
    $('mHumanTime').textContent = '—';
    $('mFlyTime').textContent = '—';
    $('mSpikes').textContent = '—';
    $('mActive').textContent = '—';
    $('mLock').textContent = '—';
    $('flyMood').textContent = 'waiting…';
  }

  function reset() {
    strokes = [];
    cur = null;
    drawing = false;
    resultsShown = false;
    lastPen = null;
    lockN = 0; lockHit = 0; flyStartT = 0; flyEndT = 0;
    lastOut = null; saidHello = false; saidLost = false; lastSayT = 0;
    drawHumanStroke();
    resetFly();
    drawFlyScene();
    $('btnAgain').classList.add('hidden');
    setMetricsDefault();
  }

  function start() {
    human = $('humanCanvas');
    fly = $('flyCanvas');
    hx = human.getContext('2d');
    fx = fly.getContext('2d');
    setupToolbar();
    setupRecorder();
    resetFly();
    drawFlyScene();
    fetch('data/circuit.json').then(function (r) { return r.json(); }).then(function (c) {
      var info = window.FlyBrain.init(c);
      brainReady = true;
      $('flyMood').textContent = 'ready — draw something!';
      if (window.CopycatOnBrain) window.CopycatOnBrain(info);
    });
    requestAnimationFrame(loop);
  }

  return { start: start, reset: reset, SPRITES: SPRITES,
           _state: function () { return { strokes: strokes, fly: flyState,
             drawing: drawing, drawStartT: drawStartT, drawEndT: drawEndT }; } };
})();

document.addEventListener('DOMContentLoaded', function () { window.Copycat.start(); });
