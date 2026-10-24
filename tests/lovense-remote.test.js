import { describe, expect, it } from 'vitest';
import {
  createRemoteModel,
  formatSessionClock,
  knobTop,
  levelFromTrackY,
  loopLevelAt,
  resampleStroke,
} from '../public/js/lovense-remote.js';

const edge = { id: 'a', name: 'Lush', connected: true };
const hush = { id: 'b', name: 'Hush', connected: true };

describe('track geometry', () => {
  it('maps the top of the track to 20 and the bottom to 0', () => {
    expect(levelFromTrackY(0, 100)).toBe(20);
    expect(levelFromTrackY(100, 100)).toBe(0);
    expect(levelFromTrackY(50, 100)).toBe(10);
  });

  it('keeps the knob center inside the lane', () => {
    expect(knobTop(20, 200)).toBeLessThan(knobTop(0, 200));
    expect(knobTop(20, 200)).toBeGreaterThan(0);
    expect(knobTop(0, 200)).toBeLessThan(200);
  });
});

describe('formatSessionClock', () => {
  it('renders minutes and seconds', () => {
    expect(formatSessionClock(80_000)).toBe('01:20');
    expect(formatSessionClock(0)).toBe('00:00');
  });
});

describe('resampleStroke', () => {
  it('holds a short gesture as one step', () => {
    const pattern = resampleStroke([
      { t: 0, level: 3.2 },
      { t: 80, level: 9 },
    ]);
    expect(pattern).toEqual({ points: [9], interval: 1000 });
  });

  it('keeps at most 50 steps and an interval above 100ms', () => {
    const samples = [];
    for (let i = 0; i <= 80; i += 1) {
      samples.push({ t: i * 100, level: (i % 21) });
    }
    const pattern = resampleStroke(samples);
    expect(pattern.points.length).toBeLessThanOrEqual(50);
    expect(pattern.points.length).toBeGreaterThan(1);
    expect(pattern.interval).toBeGreaterThan(100);
    expect(pattern.points.every((n) => n >= 0 && n <= 20)).toBe(true);
  });
});

describe('loopLevelAt', () => {
  it('interpolates between pattern steps', () => {
    expect(loopLevelAt([0, 20], 100, 50)).toBe(10);
    expect(loopLevelAt([0, 20], 100, 250)).toBe(10);
  });
});

describe('createRemoteModel', () => {
  it('holds the level on release in Float', () => {
    const model = createRemoteModel();
    model.setToys([edge], 0);
    expect(model.begin('a', 10, 100)).toEqual([
      {
        action: 'vibrate',
        level: 10,
        toyId: 'a',
        features: { vibrate: 10 },
        signature: 'vibrate:10',
      },
    ]);
    expect(model.end('a', 200)).toEqual([]);
    expect(model.view(200).controls[0].level).toBe(10);
    expect(model.view(200).countLabel).toBe('1 Toys Connected');
    expect(model.view(80_000).clock).toBe('01:20');
  });

  it('returns to zero on release when Float and Loop are off', () => {
    const model = createRemoteModel();
    model.setToys([edge], 0);
    model.toggleFloat(0);
    model.begin('a', 8, 10);
    expect(model.end('a', 40)).toEqual([{
      action: 'stop',
      level: 0,
      toyId: 'a',
      features: { vibrate: 0 },
      signature: 'vibrate:0',
    }]);
    expect(model.view(40).controls[0].level).toBe(0);
    expect(model.view(40).mode).toBe('off');
  });

  it('plays a pattern when a Loop stroke is released and returns to Float', () => {
    const model = createRemoteModel();
    model.setToys([edge], 0);
    model.toggleLoop(0);
    model.begin('a', 0, 0);
    model.move('a', 20, 1000);
    const started = model.end('a', 1000);
    expect(started[0].action).toBe('pattern');
    expect(started[0].time).toBe(0);
    expect(started[0].toyId).toBe('a');
    expect(started[0].strength.split(';').length).toBeLessThanOrEqual(50);
    expect(started[0].interval).toBeGreaterThan(100);

    const cycle = started[0].points.length * started[0].interval;
    expect(model.tick(1000 + cycle - 1)).toEqual([]);
    expect(model.tick(1000 + cycle)[0].action).toBe('pattern');

    const back = model.toggleLoop(1000 + cycle);
    expect(model.view(1000 + cycle).mode).toBe('float');
    expect(back[0].action).toBe('stop');
    expect(back.some((plan) => plan.action === 'vibrate' || plan.action === 'stop')).toBe(true);
    expect(model.view(1000 + cycle).looping).toBe(false);
  });

  it('moves every toy together while Local Sync is on', () => {
    const model = createRemoteModel();
    model.setToys([edge, hush], 0);
    model.toggleLocalSync(0);
    model.begin('b', 6, 50);
    const view = model.view(50);
    expect(view.localSync).toBe(true);
    expect(view.controls.map((toy) => toy.level)).toEqual([6, 6]);
    expect(view.series).toHaveLength(2);
    expect(view.series[0].color).not.toBe(view.series[1].color);
  });

  it('sends a toy id when Local Sync is off', () => {
    const model = createRemoteModel();
    model.setToys([edge, hush], 0);
    const plans = model.begin('b', 4, 20);
    expect(plans).toEqual([{
      action: 'vibrate',
      level: 4,
      toyId: 'b',
      features: { vibrate: 4 },
      signature: 'vibrate:4',
    }]);
    const view = model.view(20);
    expect(view.controls.map((toy) => toy.level)).toEqual([0, 4]);
    expect(view.localSync).toBe(false);
  });

  it('ignores Local Sync with a single toy', () => {
    const model = createRemoteModel();
    model.setToys([edge], 0);
    expect(model.toggleLocalSync(0)).toEqual([]);
    expect(model.view(0).localSync).toBe(false);
    expect(model.view(0).canSync).toBe(false);
  });

  it('switches the control style without leaving Float', () => {
    const model = createRemoteModel();
    model.setToys([edge], 0);
    expect(model.toggleTraditional()).toEqual([]);
    expect(model.view(0).traditional).toBe(true);
    expect(model.view(0).mode).toBe('float');
  });

  it('splits a Gemini into two axes and leaves the other toy alone', () => {
    const model = createRemoteModel();
    const ferri = { id: 'f', name: 'Ferri', toyType: 'ferri', connected: true };
    const gemini = { id: 'g', name: 'Gemini', toyType: 'gemini', connected: true };
    model.setToys([ferri, gemini], 0);
    const view = model.view(0);
    expect(view.countLabel).toBe('2 Toys Connected');
    expect(view.controls.map((toy) => toy.name)).toEqual(['Ferri', 'Gemini 1', 'Gemini 2']);
    expect(view.series).toHaveLength(3);

    const second = model.begin('g:vibrate2', 3, 10);
    expect(second).toEqual([{
      action: 'function',
      level: 3,
      toyId: 'g',
      axisKey: 'vibrate2',
      stopPrevious: 0,
      features: { vibrate2: 3 },
      signature: 'vibrate2:3',
    }]);
    model.end('g:vibrate2', 11);
    const plans = model.begin('g:vibrate1', 8, 20);
    expect(plans).toEqual([{
      action: 'function',
      level: 8,
      toyId: 'g',
      axisKey: 'vibrate1',
      stopPrevious: 0,
      features: { vibrate1: 8 },
      signature: 'vibrate1:8',
    }]);
    expect(model.view(20).controls.map((toy) => toy.level)).toEqual([0, 8, 3]);

    model.end('g:vibrate1', 21);
    const dropped = model.begin('g:vibrate1', 0, 30);
    expect(dropped[0].action).toBe('function');
    expect(dropped[0].features).toEqual({ vibrate1: 0 });
    expect(dropped[0].stopPrevious).toBe(0);

    model.end('g:vibrate1', 31);
    const stopped = model.begin('g:vibrate2', 0, 40);
    expect(stopped).toEqual([{
      action: 'stop',
      level: 0,
      toyId: 'g',
      features: { vibrate1: 0, vibrate2: 0 },
      signature: 'vibrate1:0,vibrate2:0',
    }]);
  });

  it('locks every lane when Local Sync is turned on', () => {
    const model = createRemoteModel();
    model.setToys([
      { id: 'f', name: 'Ferri', toyType: 'ferri', connected: true },
      { id: 'g', name: 'Gemini', toyType: 'gemini', connected: true },
    ], 0);
    model.begin('g:vibrate1', 4, 10);
    model.end('g:vibrate1', 11);
    model.toggleLocalSync(12);
    const plans = model.begin('f', 6, 20);
    expect(plans).toEqual([{ action: 'vibrate', level: 6, toyId: null }]);
    expect(model.view(20).controls.map((toy) => toy.level)).toEqual([6, 6, 6]);
    expect(model.view(20).countLabel).toBe('2 Toys Connected');
  });

  it('replays a multi-axis loop as combined levels', () => {
    const model = createRemoteModel();
    model.setToys([{ id: 'g', name: 'Gemini', toyType: 'gemini', connected: true }], 0);
    model.begin('g:vibrate2', 4, 0);
    model.end('g:vibrate2', 1);
    model.toggleLoop(2);
    model.begin('g:vibrate1', 0, 10);
    model.move('g:vibrate1', 20, 1010);
    const started = model.end('g:vibrate1', 1010);
    expect(started.some((plan) => plan.action === 'pattern')).toBe(false);
    expect(started.every((plan) => plan.features?.vibrate2 == null)).toBe(true);
    expect(model.view(1010).controls.find((toy) => toy.id === 'g:vibrate2').level).toBe(4);

    let sent = [];
    for (let t = 1060; t < 3000; t += 40) {
      sent = model.tick(t);
      if (sent.length) break;
    }
    expect(sent.length).toBeGreaterThan(0);
    expect(sent[0].action).toBe('function');
    expect(sent[0].features.vibrate2).toBeUndefined();
    expect(sent[0].features.vibrate1).not.toBe(started[0].features.vibrate1);
    expect(model.view(3000).controls.find((toy) => toy.id === 'g:vibrate2').level).toBe(4);
  });

  it('caps a pump axis at 3', () => {
    const model = createRemoteModel();
    model.setToys([{ id: 'm', name: 'Max', toyType: 'Max 2', connected: true }], 0);
    const plans = model.begin('m:pump', 20, 5);
    expect(plans[0].features.pump).toBe(3);
    expect(plans[0].features.vibrate).toBe(0);
    expect(model.view(5).controls.find((toy) => toy.id === 'm:pump').level).toBe(3);
  });
});
