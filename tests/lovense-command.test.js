import { describe, expect, it } from 'vitest';
import { createCommandQueue, planToyCommand } from '../public/js/lovense-command.js';

describe('planToyCommand', () => {
  it('vibrates on a new strength', () => {
    expect(planToyCommand(null, 5)).toEqual({ action: 'vibrate', level: 5 });
    expect(planToyCommand(5, 8.4)).toEqual({ action: 'vibrate', level: 8 });
  });

  it('skips an unchanged strength', () => {
    expect(planToyCommand(5, 5)).toEqual({ action: 'skip', level: 5 });
    expect(planToyCommand(0, 0)).toEqual({ action: 'skip', level: 0 });
  });

  it('stops at zero', () => {
    expect(planToyCommand(4, 0)).toEqual({ action: 'stop', level: 0 });
    expect(planToyCommand(null, 0)).toEqual({ action: 'stop', level: 0 });
  });

  it('clamps to 0-20', () => {
    expect(planToyCommand(null, 99)).toEqual({ action: 'vibrate', level: 20 });
    expect(planToyCommand(null, -3)).toEqual({ action: 'stop', level: 0 });
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
    });

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
    });
    await queue.push(4);
    await queue.push(4);
    expect(sent).toEqual([4]);
  });
});
