import { describe, expect, it } from 'vitest';
import { buildPatternPlan, createCommandQueue, planToyCommand, sdkCommandBody } from '../public/js/lovense-command.js';

describe('planToyCommand', () => {
  it('vibrates on a new strength', () => {
    expect(planToyCommand(null, 5)).toEqual({ action: 'vibrate', level: 5, toyId: null });
    expect(planToyCommand(5, 8.4)).toEqual({ action: 'vibrate', level: 8, toyId: null });
  });

  it('skips an unchanged strength', () => {
    expect(planToyCommand(5, 5)).toEqual({ action: 'skip', level: 5, toyId: null });
    expect(planToyCommand(0, 0)).toEqual({ action: 'skip', level: 0, toyId: null });
  });

  it('stops at zero', () => {
    expect(planToyCommand(4, 0)).toEqual({ action: 'stop', level: 0, toyId: null });
    expect(planToyCommand(null, 0)).toEqual({ action: 'stop', level: 0, toyId: null });
  });

  it('clamps to 0-20 and keeps a toy id', () => {
    expect(planToyCommand(null, 99, 'edge')).toEqual({ action: 'vibrate', level: 20, toyId: 'edge' });
    expect(planToyCommand(null, -3)).toEqual({ action: 'stop', level: 0, toyId: null });
  });
});

describe('buildPatternPlan', () => {
  it('joins strengths and refuses intervals of 100ms or less', () => {
    expect(buildPatternPlan([1, 20.4, 3], 50, 'toy')).toEqual({
      action: 'pattern',
      level: 3,
      strength: '1;20;3',
      interval: 101,
      time: 0,
      toyId: 'toy',
      points: [1, 20, 3],
    });
  });
});

describe('createCommandQueue', () => {
  it('sends only the latest level while a command is in flight', async () => {
    const sent = [];
    let release = () => {};
    const queue = createCommandQueue((plan) => {
      sent.push(plan.level);
      return new Promise((resolve) => {
        release = resolve;
      });
    }, { minIntervalMs: 0 });

    const done = queue.push(5);
    queue.push(8);
    queue.push(3);
    expect(sent).toEqual([5]);

    release();
    await Promise.resolve();
    expect(sent).toEqual([5, 3]);
    release();
    await done;
    expect(queue.lastSent).toBe(3);
  });

  it('does not send a skipped repeat', async () => {
    const sent = [];
    const queue = createCommandQueue(async (plan) => {
      sent.push(plan.level);
    }, { minIntervalMs: 0 });
    await queue.push(4);
    await queue.push(4);
    expect(sent).toEqual([4]);
  });

  it('waits out the minimum gap before the next command', async () => {
    let t = 0;
    const waits = [];
    const sent = [];
    const queue = createCommandQueue(async (plan) => {
      sent.push(plan.level);
    }, {
      minIntervalMs: 100,
      now: () => t,
      delay: async (ms) => {
        waits.push(ms);
        t += ms;
      },
    });

    await queue.push(1);
    t = 40;
    await queue.push(2);
    expect(sent).toEqual([1, 2]);
    expect(waits).toEqual([60]);
  });

  it('keeps each axis while a command is in flight', async () => {
    const sent = [];
    let release = () => {};
    const queue = createCommandQueue((plan) => {
      sent.push(plan.signature);
      return new Promise((resolve) => {
        release = resolve;
      });
    }, { minIntervalMs: 0 });

    const done = queue.pushPlan({
      action: 'function',
      level: 1,
      axisKey: 'vibrate1',
      signature: 'vibrate1:1',
      features: { vibrate1: 1 },
    });
    queue.pushPlan({
      action: 'function',
      level: 4,
      axisKey: 'vibrate1',
      signature: 'vibrate1:4',
      features: { vibrate1: 4 },
    });
    queue.pushPlan({
      action: 'function',
      level: 3,
      axisKey: 'vibrate2',
      signature: 'vibrate2:3',
      features: { vibrate2: 3 },
    });
    expect(sent).toEqual(['vibrate1:1']);

    release();
    await Promise.resolve();
    expect(sent).toEqual(['vibrate1:1', 'vibrate1:4']);
    release();
    await Promise.resolve();
    expect(sent).toEqual(['vibrate1:1', 'vibrate1:4', 'vibrate2:3']);
    release();
    await done;
  });

  it('drops queued axes when stop arrives', async () => {
    const sent = [];
    let release = () => {};
    const queue = createCommandQueue((plan) => {
      sent.push(plan.action === 'stop' ? 'stop' : plan.signature);
      return new Promise((resolve) => {
        release = resolve;
      });
    }, { minIntervalMs: 0 });

    const done = queue.pushPlan({
      action: 'function',
      level: 8,
      axisKey: 'vibrate1',
      signature: 'vibrate1:8',
    });
    queue.pushPlan({
      action: 'function',
      level: 3,
      axisKey: 'vibrate2',
      signature: 'vibrate2:3',
    });
    queue.pushPlan({ action: 'stop', level: 0, signature: 'stop' });
    release();
    await Promise.resolve();
    expect(sent).toEqual(['vibrate1:8', 'stop']);
    release();
    await done;
  });

  it('passes a pattern plan through with its toy id', async () => {
    const sent = [];
    const queue = createCommandQueue(async (plan) => {
      sent.push(plan);
    }, { minIntervalMs: 0 });
    await queue.pushPlan({
      action: 'pattern',
      level: 4,
      strength: '4;8',
      interval: 150,
      time: 0,
      toyId: 'abc',
    });
    expect(sent[0].toyId).toBe('abc');
    expect(sent[0].strength).toBe('4;8');
    expect(queue.lastSent).toBeNull();
  });
});

describe('sdkCommandBody', () => {
  it('keeps a plain vibrate on sendToyCommand', () => {
    expect(sdkCommandBody({
      action: 'vibrate',
      level: 4,
      toyId: 'ferri',
      features: { vibrate: 4 },
    })).toEqual({
      method: 'sendToyCommand',
      body: { vibrate: 4, toyId: 'ferri' },
    });
  });

  it('sends one Gemini motor and leaves the previous command running', () => {
    expect(sdkCommandBody({
      action: 'function',
      toyId: 'gem',
      features: { vibrate1: 8 },
    })).toEqual({
      method: 'sendRawCommand',
      body: {
        command: 'Function',
        apiVer: 1,
        action: 'Vibrate1:8',
        timeSec: 0,
        stopPrevious: 0,
        toy: 'gem',
      },
    });
  });
});
