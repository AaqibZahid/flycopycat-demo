/* Fly Copycat — procedural pixel grass background.
 *
 * No assets: blades are drawn once into offscreen sprites (3 heights x
 * 2 shades), scattered along the grass band, and swayed with sin() wind
 * at two depth layers. Crisp pixels via imageSmoothingEnabled=false.
 */
'use strict';

(function () {
  var cv, ctx;
  var blades = [];
  var sprites = [];
  var W = 0, H = 0, grassTop = 0;

  var GREENS = ['#5da85a', '#6fbf67', '#4c9448'];
  var SIZES = [10, 16, 24]; // small, medium, tall blades

  function makeBlade(h, color) {
    var c = document.createElement('canvas');
    c.width = 8; c.height = h;
    var g = c.getContext('2d');
    g.fillStyle = color;
    // chunky pixel blade: 2px stem + 1px tip, slight lean
    g.fillRect(3, h - 6, 2, 6);
    g.fillRect(2, h - 10, 4, 4);
    if (h > 12) g.fillRect(3, 2, 2, h - 12);
    g.fillRect(3, 0, 2, 2);
    return c;
  }

  function layout() {
    W = cv.width = window.innerWidth;
    H = cv.height = window.innerHeight;
    grassTop = Math.floor(H * 0.55);
    blades = [];
    var n = Math.floor(W / 9);
    for (var i = 0; i < n; i++) {
      blades.push({
        x: Math.floor(Math.random() * W),
        y: grassTop + Math.floor(Math.random() * (H - grassTop)),
        s: Math.floor(Math.random() * 3),          // size class
        v: Math.random() * 3 | 0,                   // shade variant
        ph: Math.random() * 6.28,                   // sway phase
        sp: 0.8 + Math.random() * 0.9,              // sway speed
        back: Math.random() < 0.4                   // back layer = smaller/dimmer
      });
    }
  }

  function frame(t) {
    ctx.imageSmoothingEnabled = false;
    // sky + grass base bands (match theme vars)
    var sky = ctx.createLinearGradient(0, 0, 0, grassTop);
    sky.addColorStop(0, '#bfe9ff');
    sky.addColorStop(1, '#a5dcf5');
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, W, grassTop);
    ctx.fillStyle = '#8ed081';
    ctx.fillRect(0, grassTop, W, H - grassTop);
    // darker soil strip at the very bottom
    ctx.fillStyle = '#7cbf70';
    ctx.fillRect(0, H - 26, W, 26);

    for (var i = 0; i < blades.length; i++) {
      var b = blades[i];
      var sway = Math.round(Math.sin(t * 0.001 * b.sp + b.ph) * (b.back ? 1 : 3));
      var spr = sprites[b.s][b.v];
      var sc = b.back ? 1 : 2; // front blades 2x
      ctx.globalAlpha = b.back ? 0.7 : 1;
      ctx.drawImage(spr, b.x + sway, b.y - spr.height * sc, spr.width * sc, spr.height * sc);
    }
    ctx.globalAlpha = 1;
    requestAnimationFrame(frame);
  }

  function start() {
    cv = document.getElementById('grassBg');
    if (!cv) return;
    ctx = cv.getContext('2d');
    for (var s = 0; s < 3; s++) {
      sprites.push([makeBlade(SIZES[s], GREENS[0]), makeBlade(SIZES[s], GREENS[1]),
                    makeBlade(SIZES[s], GREENS[2])]);
    }
    layout();
    window.addEventListener('resize', layout);
    requestAnimationFrame(frame);
  }

  document.addEventListener('DOMContentLoaded', start);
})();
