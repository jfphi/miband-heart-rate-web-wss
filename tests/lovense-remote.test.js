import { describe, expect, it } from 'vitest';
import {
  createRemoteModel,
  formatSessionClock,
  knobTop,
  levelFromTrackY,
  loopLevelAt,
  resampleStroke,
} from '../public/js/lovense-remote.js';

const edge = { id: 'a', name: 'Edge', connected: true };
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
      { action: 'vibrate', level: 10, toyId: null },
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
    expect(model.end('a', 40)).toEqual([{ action: 'stop', level: 0, toyId: null }]);
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
    expect(started[0].toyId).toBeNull();
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
    model.begin('b', 6, 50);
    const view = model.view(50);
    expect(view.controls.map((toy) => toy.level)).toEqual([6, 6]);
    expect(view.series).toHaveLength(2);
    expect(view.series[0].color).not.toBe(view.series[1].color);
  });

  it('sends a toy id when Local Sync is off', () => {
    const model = createRemoteModel();
    model.setToys([edge, hush], 0);
    model.toggleLocalSync(10);
    const plans = model.begin('b', 4, 20);
    expect(plans).toEqual([{ action: 'vibrate', level: 4, toyId: 'b' }]);
    const view = model.view(20);
    expect(view.controls.map((toy) => toy.level)).toEqual([0, 4]);
    expect(view.localSync).toBe(false);
  });

  it('ignores Local Sync with a single toy', () => {
    const model = createRemoteModel();
    model.setToys([edge], 0);
    expect(model.toggleLocalSync(0)).toEqual([]);
    expect(model.view(0).localSync).toBe(true);
    expect(model.view(0).canSync).toBe(false);
  });

  it('switches the control style without leaving Float', () => {
    const model = createRemoteModel();
    model.setToys([edge], 0);
    expect(model.toggleTraditional()).toEqual([]);
    expect(model.view(0).traditional).toBe(true);
    expect(model.view(0).mode).toBe('float');
  });
});
