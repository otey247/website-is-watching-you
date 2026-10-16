import { expect, test } from '@playwright/test';
import { boot, enter, expectNoErrors, hook, settle, shot, state } from './helpers';

test('7. producing and following pointer trails', async ({ page }) => {
  await boot(page);
  await enter(page);
  await hook(page, 'look', 0.62, -0.5);
  await settle(page, 500);
  const box = (await page.locator('#app canvas').boundingBox())!;

  // Before the follower stage, pointer movement leaves nothing.
  await page.mouse.move(box.x + 300, box.y + 500);
  await page.mouse.move(box.x + 900, box.y + 520, { steps: 30 });
  expect((await state(page)).trailMarks).toBe(0);

  // At the follower stage, the pointer leaves faint marks on room surfaces...
  await hook(page, 'forcePhase', 'anticipation');
  await hook(page, 'setFollowerStage', 2);
  for (let k = 0; k < 3; k++) {
    await page.mouse.move(box.x + 260, box.y + 470 + k * 30, { steps: 4 });
    await page.mouse.move(box.x + 980, box.y + 560 + k * 20, { steps: 40 });
  }
  const afterPlayer = (await state(page)).trailMarks;
  expect(afterPlayer).toBeGreaterThan(20);
  await shot(page, '07-player-trail');

  // ...and, after a delay, a second sequence retraces the same path.
  await hook(page, 'simulate', 9000);
  await settle(page, 400);
  const after = (await state(page)).trailMarks;
  expect(after).toBeGreaterThan(afterPlayer);
  await shot(page, '07-follower-trail');

  // The follower stops when the player stops (stage 3+).
  await hook(page, 'setFollowerStage', 3);
  await hook(page, 'simulate', 3000);
  const t1 = (await state(page)).trailMarks;
  await hook(page, 'simulate', 4000);
  expect((await state(page)).trailMarks).toBe(t1);
  await expectNoErrors(page);
});
