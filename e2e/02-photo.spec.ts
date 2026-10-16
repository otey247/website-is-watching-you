import { expect, test } from '@playwright/test';
import { boot, clickObject, enter, events, expectNoErrors, hook, look, settle, shot, state, waitRig, world } from './helpers';

test.describe.configure({ mode: 'serial' });

test('2-4. inspecting the photograph, a valid offscreen mutation, and discovering it', async ({ page }) => {
  await boot(page);
  await enter(page);

  // 2. Inspect the photograph closely.
  await clickObject(page, 'photograph');
  await waitRig(page, 'inspect');
  let s = await state(page);
  expect(s.inspecting).toBe('photograph');
  expect(s.rigMode).toBe('inspect');
  expect((await world(page, 'photograph')).state).toBe('original');
  await shot(page, '02-photo-inspect');
  await page.waitForTimeout(500);
  await page.keyboard.press('Escape');
  await waitRig(page, 'look');
  const inspected = await events(page, 'object_inspected');
  expect(inspected.at(-1)?.target).toBe('photograph');
  expect(inspected.at(-1)?.durationMs).toBeGreaterThan(1000);

  // 3. The first change is gated by phase, behavior, and visibility.
  const early = await hook<{ ok: boolean; reason: string }>(page, 'forceGated', 'photo_first_change');
  expect(early.ok).toBe(false); // still in normalcy
  await hook(page, 'forcePhase', 'inconsistency');

  // While the photograph is being looked at, the event waits and nothing changes.
  await look(page, 'photograph');
  expect(await hook(page, 'visibility', 'photograph')).toBe('attended');
  const r = await hook<{ ok: boolean; reason: string }>(page, 'forceGated', 'photo_first_change');
  await hook(page, 'simulate', 4000);
  expect((await world(page, 'photograph')).state).toBe('original');

  // Look away (toward the desk) and let the visibility contract be satisfied.
  await look(page, 'computer');
  expect(await hook(page, 'visibility', 'photograph')).toBe('offscreen');
  // A run scheduled while it was watched either waited for its contract or expired; give it time, then retry once.
  await hook(page, 'simulate', 12_000);
  if ((await world(page, 'photograph')).state === 'original') {
    const again = await hook<{ ok: boolean; reason: string }>(page, 'forceGated', 'photo_first_change');
    expect(again.ok, again.reason).toBe(true);
    await hook(page, 'simulate', 8000);
  }
  void r;
  const photo = await world(page, 'photograph');
  expect(['removed', 'shifted']).toContain(photo.state);
  const hist = await hook<{ source: string; cause: string }[]>(page, 'history', 'photograph');
  expect(hist.at(-1)).toMatchObject({ source: 'director', cause: 'photo_first_change' });
  await shot(page, '03-looked-away');

  // 4. Turning back reveals the changed photograph. No sound announced it.
  s = await state(page);
  expect(s.decisions.some((d) => d.anomalyId === 'photo_first_change' && d.result === 'done')).toBe(true);
  await clickObject(page, 'photograph');
  await waitRig(page, 'inspect');
  await settle(page, 1200); // let the frame's crossfade (if any) finish
  await shot(page, '04-photo-changed');
  await page.keyboard.press('Escape');
  await waitRig(page, 'look');
  // Seeing it is recorded as witnessing the anomaly.
  expect((await events(page, 'anomaly_witnessed')).some((e) => e.target === 'photograph')).toBe(true);
  await expectNoErrors(page);
});
