/* Fly Copycat — LIF brain engine over the real FlyWire escape circuit.
 *
 * Network: 332 neurons (LC4/LPLC2 looming detectors -> DNp01/Giant Fiber,
 * DNp09, DNa01/02, DNg11, MDN descending) with 569 signed synapse-count
 * weights from FlyWire FAFB v783 (see data/circuit.json, tools/extract_circuit.py).
 *
 * Model: leaky integrate-and-fire. Sensory cells are driven by the live
 * stimulus (loom + bearing of the pen-target); spikes propagate through
 * real edges; descending-neuron firing is read out as motor commands.
 */
'use strict';

window.FlyBrain = (function () {
  var N = 0;
  var V = null;          // membrane voltage
  var thr = null;        // per-neuron fire threshold
  var refr = null;       // refractory countdown
  var outEdges = [];     // outEdges[i] = [[post, w], ...]
  var isSensory = null;  // LC4 / LPLC2
  var isMotor = null;    // DN* / MDN
  var motorType = [];    // per-neuron readout role
  var sensoryIdx = [];
  var motorIdx = [];

  var LEAK = 0.90;
  var THRESH = 1.0;
  var REFRACT = 3;
  var W_SCALE = 0.06;    // synapse counts (~5-500) -> single-spike PSPs
  var SENS_DRIVE = 0.3;  // fixed drive to recruited sensory cells; loom sets
                         // recruitment probability (more loom = more cells)

  function roleOf(type) {
    if (type === 'LC4' || type === 'LPLC2') return 'sensory';
    if (type.indexOf('DN') === 0 || type === 'MDN') return 'motor';
    return 'relay';
  }

  function init(circuit) {
    N = circuit.neurons.length;
    V = new Float32Array(N);
    thr = new Float32Array(N);
    refr = new Uint8Array(N);
    outEdges = new Array(N);
    isSensory = new Uint8Array(N);
    isMotor = new Uint8Array(N);
    motorType = new Array(N);
    sensoryIdx = [];
    motorIdx = [];
    for (var i = 0; i < N; i++) {
      outEdges[i] = [];
      var t = circuit.neurons[i].type;
      var r = roleOf(t);
      motorType[i] = t;
      if (r === 'sensory') { isSensory[i] = 1; sensoryIdx.push(i); }
      if (r === 'motor') { isMotor[i] = 1; motorIdx.push(i); }
      thr[i] = THRESH;
    }
    circuit.edges.forEach(function (e) {
      var w = e[2] * W_SCALE;
      if (w > 0.6) w = 0.6;   // cap: one synapse can't solo-fire a cell
      if (w < -0.6) w = -0.6;
      outEdges[e[0]].push([e[1], w]);
    });
    // motor thresholds scale with input convergence: cells with few strong
    // inputs fire on few inputs; the Giant Fiber needs a real volley.
    // (DNg11/MDN have 0 inputs in this subset and stay silent — documented.)
    var indeg = new Uint16Array(N);
    circuit.edges.forEach(function (e) { indeg[e[1]]++; });
    for (var m = 0; m < motorIdx.length; m++) {
      var mi = motorIdx[m];
      var t = 0.12 * Math.sqrt(indeg[mi]);
      thr[mi] = Math.min(3.0, Math.max(0.5, t));
    }
    tick = 0;
    spikeLog = [];
    gfFiredTick = -1e9;
    return { neurons: N, edges: circuit.edges.length,
             sensory: sensoryIdx.length, motor: motorIdx.length };
  }

  var tick = 0;
  var spikeLog = [];     // ring buffer of tick ids for spikes/sec
  var gfFiredTick = -1e9;

  // stim: {loom: 0..1 (pen approach speed), bearing: -1..1 (target left/right)}
  function step(stim) {
    tick++;
    var loom = stim.loom || 0;
    var bearing = stim.bearing || 0;

    // 1. sensory drive: looming recruits a fraction of LC4/LPLC2 cells
    for (var s = 0; s < sensoryIdx.length; s++) {
      if (Math.random() < loom) V[sensoryIdx[s]] += SENS_DRIVE;
    }

    // 2. integrate + fire
    var fired = [];
    for (var j = 0; j < N; j++) {
      if (refr[j] > 0) { refr[j]--; continue; }
      V[j] *= LEAK;
      if (V[j] >= thr[j]) {
        V[j] = 0;
        refr[j] = REFRACT;
        fired.push(j);
      }
    }

    // 3. propagate through real edges
    for (var f = 0; f < fired.length; f++) {
      var outs = outEdges[fired[f]];
      for (var k = 0; k < outs.length; k++) {
        V[outs[k][0]] += outs[k][1];
      }
    }

    // 4. motor readout from descending neurons
    var steer = 0, forward = 0, escape = 0;
    for (var m = 0; m < motorIdx.length; m++) {
      var mi = motorIdx[m];
      if (fired.indexOf(mi) === -1) continue;
      var t = motorType[mi];
      if (t === 'DNa01') steer -= 1;
      else if (t === 'DNa02') steer += 1;
      else if (t === 'DNp09' || t === 'DNg11') forward += 1;
      else if (t === 'DNp01') { escape += 1; gfFiredTick = tick; } // Giant Fiber
      else if (t === 'MDN') forward -= 1; // moonwalker: backward
    }
    // bearing nudges steering so the fly tracks the target side
    steer += bearing * (0.5 + loom);

    for (var s2 = 0; s2 < fired.length; s2++) spikeLog.push(tick);
    while (spikeLog.length && spikeLog[0] < tick - 60) spikeLog.shift();

    return { steer: steer, forward: forward, escape: escape,
             spikes: fired.length, gfRecentlyFired: (tick - gfFiredTick) < 12 };
  }

  function stats() {
    var active = 0;
    for (var i = 0; i < N; i++) if (V[i] > 0.05) active++;
    return { neurons: N, active: active, spikesPerSec: spikeLog.length,
             tick: tick };
  }

  return { init: init, step: step, stats: stats };
})();
