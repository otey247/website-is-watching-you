import { expect, test } from '@playwright/test';
import { boot, clickObject, enter, events, expectNoErrors, hook, settle, shot, state, world } from './helpers';

test('1. starting and exploring the room', async ({ page }) => {
  await boot(page);
  await expect(page.getByRole('heading', { name: /The Website/ })).toBeVisible();
  await shot(page, '01-gate');

  // Privacy is reachable before entering, outside the fiction.
  await page.getByRole('button', { name: 'Privacy' }).click();
  await expect(page.getByText('What it never touches')).toBeVisible();
  await shot(page, '01-privacy');
  await page.getByRole('button', { name: 'Close' }).click();

  await enter(page);
  await settle(page, 1800);
  let s = await state(page);
  expect(s.phase).toBe('normalcy');
  expect(s.hintVisible).toBe(true);
  expect(s.audio).toBe('running'); // audio started from the Enter gesture
  await expect(page.getByText('Take a look around.')).toBeVisible();
  await shot(page, '01-room');

  // Click-drag on empty wall rotates the camera.
  const box = (await page.locator('#app canvas').boundingBox())!;
  const yaw0 = (await page.evaluate(() => (window as any).__wiwy.app.rig.yaw)) as number;
  await page.mouse.move(box.x + box.width * 0.5, box.y + 120);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.5 + 260, box.y + 130, { steps: 12 });
  await page.mouse.up();
  await settle(page, 500);
  const yaw1 = (await page.evaluate(() => (window as any).__wiwy.app.rig.yaw)) as number;
  expect(Math.abs(yaw1 - yaw0)).toBeGreaterThan(0.3);

  // First interaction: the lamp. The instruction fades.
  expect((await world(page, 'lamp')).on).toBe(false);
  await clickObject(page, 'lamp');
  await settle(page, 900);
  expect((await world(page, 'lamp')).on).toBe(true);
  s = await state(page);
  expect(s.hintVisible).toBe(false);
  const lampEvents = await events(page, 'lamp_toggled');
  expect(lampEvents).toHaveLength(1);
  expect(lampEvents[0].meta.on).toBe(true);
  await hook(page, 'look', 0.6, -0.15);
  await settle(page, 2500);
  await shot(page, '01-lamp-on');

  // Book: pick up, hold, place back on a free slot.
  await clickObject(page, 'book_2');
  await settle(page, 800);
  expect((await state(page)).held).toBe('book_2');
  await shot(page, '01-holding-book');
  await hook(page, 'placeHeld', 's1_b');
  await settle(page, 600);
  expect((await state(page)).held).toBe(null);
  expect((await world(page, 'book_2')).slot).toBe('s1_b');
  expect((await events(page, 'object_placed')).length).toBe(1);
  await expectNoErrors(page);
});
