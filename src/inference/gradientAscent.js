////////////////////////////////////////////////////////////////////
// Gradient Ascent

'use strict';

var _ = require('underscore');
var assert = require('assert');
var erp = require('../erp.js');

var ad = require('ad.js')({mode: 'r'})

module.exports = function(env) {

  function sigmoid(x) { return (1 / (1 + Math.exp(-x))) - 0.5; }

  function makeTraceEntry(s, k, a, erp, params, type, currScore, choiceScore, val) {
    return {store: s, k: k, addr: a, erp: erp, params: params, type: type,
            score: currScore, choiceScore: choiceScore, val: val};
  }

  function Grad(s, k, a, wpplFn, stepSize, steps) {
    this.steps = steps;
    this.stepSize = stepSize;
    this.hist = {};

    this.wpplFn = wpplFn;
    this.originalStore = s;
    this.k = k;
    this.a = a;

    // Move old coroutine out of the way and install this as current handler.
    this.oldCoroutine = env.coroutine;
    env.coroutine = this;
  }

  // Extract procedures that require AD-fication into prototypes
  // Should ideally be general coroutine methods instead of inference specific.
  Grad.prototype.liftedSampler = function(erp, params) {
    var val = erp.sample(ad.untapify(params));
    return (typeof val === 'number') ? ad.tapify(val) : val;
  }
  Grad.prototype.updateScore = function(score) {
    this.currScore = ad.add(this.currScore, score);
  }
  Grad.prototype.isScoreInf = function() {
    return ad.untapify(this.currScore) === -Infinity
  }

  Grad.prototype.run = function() {
    this.sites = {}
    this.currScore = 0;
    this.counterfactualUpdate = false;
    this.startRecompAddress = undefined;
    this.s = this.originalStore;
    return this.wpplFn(this.s, env.exit, this.a);
  };

  Grad.prototype.factor = function(s, k, a, score) {
    this.updateScore(score)
    return this.isScoreInf() ? this.exit(s) : k(s);
  };

  Grad.prototype.sample = function(s, k, a, erp, params) {
    var val;
    if (this.counterfactualUpdate) {
      var lk = this.sites[a];
      if (lk)                  // continuous erp with gradient
        val = ad.tapify(lk.val.primal + (this.stepSize * sigmoid(lk.val.sensitivity)))
      else                   // previously unseen sample
        val = this.liftedSampler(erp, params);
    } else
      val = this.liftedSampler(erp, params);

    var choiceScore = erp.score(params, val);
    var newEntry = makeTraceEntry(_.clone(s), k, a, erp, params, erp.isContinuousERP(),
                                  this.currScore, choiceScore, val)
    this.sites[a] = newEntry;
    this.updateScore(choiceScore)
    if (this.isScoreInf())
      return this.exit(s);
    if (erp.isContinuousERP() && !this.startRecompAddress)
      this.startRecompAddress = a;

    return k(s, val);
  };

  Grad.prototype.propose = function() {
    // compute the gradients along the whole tape
    // this automatically sets the derivative in the value tape.
    ad.yGradientR(this.currScore)
    this.counterfactualUpdate = true; // so we know to compute val from gradient
    // go to first continuous erp address and recompute things from there
    var regenFrom = this.sites[this.startRecompAddress];
    return this.sample(_.clone(regenFrom.store), regenFrom.k, regenFrom.addr,
                       regenFrom.erp, regenFrom.params);
  };

  Grad.prototype.updateHist = function(val) {
    var l = JSON.stringify(val.primal);
    if (this.hist[l] === undefined) this.hist[l] = {prob: 0, val: val.primal};
    this.hist[l].prob += 1;
  }

  Grad.prototype.exit = function(s, val) {
    if (this.steps === 0)
      return this.finish(val);
    this.steps -= 1;
    // don't add values to histogram -- only want the final one
    // make a new proposal
    return this.propose(val);
  };

  Grad.prototype.finish = function(val) {
    // add last value into hist and build erp
    this.updateHist(val);
    var dist = erp.makeMarginalERP(this.hist);

    var k = this.k;
    // Reinstate previous coroutine
    env.coroutine = this.oldCoroutine;
    // Return by calling original continuation
    return k(this.oldStore, dist);
  }

  function grad(s, cc, a, wpplFn, stepsize, steps) {
    return new Grad(s, cc, a, wpplFn, stepsize, steps).run();
  }

  return {
    GradientAscent: grad
  };

};
