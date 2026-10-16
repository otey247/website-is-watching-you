import { expect, test } from '@playwright/test';
import { boot, expectNoErrors, hook, pixelOf, settle, shot, state, waitRig, world } from './helpers';

test('12. navigating on a mobile viewport', async ({ page }) => {
  await boot(page);
  await shot(page, '12-mobile-gate');
  // No horizontal overflow at phone width.
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('button', { name: 'Enter' }).tap();
  await page.waitForFunction(() => (window as any).__wiwy.entered());
  await settle(page, 1500);
  await shot(page, '12-mobile-room');

  // Swipe on empty space to look around.
  const box = (await page.locator('#app canvas').boundingBox())!;
  const yaw0 = (await page.evaluate(() => (window as any).__wiwy.app.rig.yaw)) as number;
  const cdp = await page.context().newCDPSession(page);
  const touch = async (type: 'touchStart' | 'touchMove' | 'touchEnd', x: number, y: number) =>
    cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1 }] });
  await touch('touchStart', box.x + box.width * 0.5, box.y + 90);
  for (let i = 1; i <= 10; i++) await touch('touchMove', box.x + box.width * 0.5 - i * 18, box.y + 92);
  await touch('touchEnd', 0, 0);
  await settle(page, 600);
  const yaw1 = (await page.evaluate(() => (window as any).__wiwy.app.rig.yaw)) as number;
  expect(Math.abs(yaw1 - yaw0)).toBeGreaterThan(0.2);

  // Tap the lamp.
  await hook(page, 'lookAt', 'lamp');
  await settle(page, 300);
  const lamp = await pixelOf(page, 'lamp');
  await page.touchscreen.tap(lamp.x, lamp.y);
  await settle(page, 800);
  expect((await world(page, 'lamp')).on).toBe(true);
  expect((await state(page)).hintVisible).toBe(false);

  // Tap to inspect the photograph; tap elsewhere to return.
  await hook(page, 'lookAt', 'photograph');
  await settle(page, 300);
  const ph = await pixelOf(page, 'photograph');
  await page.touchscreen.tap(ph.x, ph.y);
  await waitRig(page, 'inspect');
  await shot(page, '12-mobile-inspect');
  await page.touchscreen.tap(box.x + 20, box.y + box.height - 40);
  await waitRig(page, 'look');

  // The pause menu fits and works on a phone.
  await page.getByRole('button', { name: 'Pause menu' }).tap();
  await expect(page.getByRole('heading', { name: 'Paused' })).toBeVisible();
  await shot(page, '12-mobile-menu');
  await expectNoErrors(page);
});
