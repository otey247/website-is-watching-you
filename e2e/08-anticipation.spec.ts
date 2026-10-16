import { expect, test } from '@playwright/test';
import { boot, clickObject, enter, expectNoErrors, hook, pixelOf, settle, shot, state, world } from './helpers';

test('8. triggering an anticipated interaction', async ({ page }) => {
  await boot(page);
  await enter(page);

  // Establish a habit: the player keeps going for the door.
  for (let i = 0; i < 3; i++) {
    await clickObject(page, 'door');
    await settle(page, 400);
  }
  await hook(page, 'forcePhase', 'anticipation');
  await hook(page, 'lookAt', 'door');
  await hook(page, 'simulate', 300);

  // Move the pointer toward the door, slowly, without clicking.
  let anticipated = false;
  let maxHandle = 0;
  for (let attempt = 0; attempt < 8 && !anticipated; attempt++) {
    const door = await pixelOf(page, 'door');
    const box = (await page.locator('#app canvas').boundingBox())!;
    await page.mouse.move(box.x + 80, box.y + box.height - 80);
    await hook(page, 'simulate', 400);
    for (let k = 1; k <= 10; k++) {
      const t = k / 12;
      await page.mouse.move(box.x + 80 + (door.x - box.x - 80) * t, box.y + box.height - 80 + (door.y - (box.y + box.height - 80)) * t);
      await hook(page, 'simulate', 120);
      const h = ((await world(page, 'door')).handle as number | undefined) ?? 0;
      maxHandle = Math.max(maxHandle, h);
    }
    await hook(page, 'simulate', 900);
    maxHandle = Math.max(maxHandle, ((await world(page, 'door')).handle as number | undefined) ?? 0);
    const s = await state(page);
    anticipated = s.decisions.some((d) => d.anomalyId.startsWith('anticipate_') && (d.result === 'scheduled' || d.result === 'done'));
    if (!anticipated) await hook(page, 'simulate', 26_000); // anticipation group spacing
  }
  const s = await state(page);
  const pred = await hook<{ target: string; confidence: number } | null>(page, 'prediction');
  expect(anticipated, JSON.stringify({ pred, decisions: s.decisions.slice(-6) })).toBe(true);
  const ant = s.decisions.find((d) => d.anomalyId.startsWith('anticipate_'))!;
  if (ant.anomalyId === 'anticipate_door_handle') {
    // The handle turned before any click, and the player never clicked during the approach.
    expect(maxHandle).toBeGreaterThan(0.05);
  }
  await shot(page, '08-anticipation');

  // The prediction is resolved against what the player actually does next.
  await clickObject(page, 'lamp');
  await hook(page, 'simulate', 6000);
  const resolved = await page.evaluate(() => (window as any).__wiwy.events('prediction_resolved') as { meta: { outcome: string } }[]);
  expect(resolved.length).toBeGreaterThan(0);
  expect(resolved.map((r) => r.meta.outcome).every((o) => ['hit', 'miss', 'expired'].includes(o))).toBe(true);
  await expectNoErrors(page);
});
