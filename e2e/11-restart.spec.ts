import { expect, test } from '@playwright/test';
import { boot, clickObject, enter, events, expectNoErrors, hook, settle, shot, state } from './helpers';

test('11. pausing, saving, restarting and resetting the session', async ({ page }) => {
  await boot(page);
  await enter(page);
  await clickObject(page, 'lamp');
  await hook(page, 'look', 0.62, -0.42);
  await clickObject(page, 'drawer_top', { look: false });
  await settle(page, 400);

  // The pause menu stops session time.
  await page.getByRole('button', { name: 'Pause menu' }).click();
  await expect(page.getByRole('heading', { name: 'Paused' })).toBeVisible();
  const t0 = (await state(page)).now;
  await settle(page, 1200);
  expect((await state(page)).paused).toBe(true);
  expect((await state(page)).now).toBe(t0);
  await shot(page, '11-pause-menu');

  // Settings: reduced motion and sudden events are honored and remembered locally.
  await page.getByRole('button', { name: 'Settings' }).click();
  await shot(page, '11-settings');
  await page.locator('.panel input[type=checkbox]').first().evaluate((el: HTMLInputElement) => el.click());
  const stored = await page.evaluate(() => localStorage.getItem('wiwy.settings.v1'));
  expect(stored).not.toBeNull();
  await page.getByRole('button', { name: 'Back' }).click();

  // A hidden tab pauses too.
  await page.getByRole('button', { name: 'Resume' }).click();
  await hook(page, 'setHidden', true);
  const t1 = (await state(page)).now;
  await settle(page, 800);
  expect((await state(page)).now).toBe(t1);
  await hook(page, 'setHidden', false);
  await settle(page, 600);
  expect((await state(page)).now).toBeGreaterThan(t1);

  // Save and leave, then resume from the gate after a reload.
  const before = (await state(page)).interactions;
  await page.getByRole('button', { name: 'Pause menu' }).click();
  await page.getByRole('button', { name: 'Save and leave' }).click();
  await expect(page.getByRole('heading', { name: 'You left the room.' })).toBeVisible();
  await shot(page, '11-left');
  expect(await page.evaluate(() => !!localStorage.getItem('wiwy.session.v1'))).toBe(true);
  await page.reload();
  await page.waitForFunction(() => (window as any).__wiwy?.ready());
  // (Test mode hides the resume button to keep runs independent; resume through the same path.)
  await page.evaluate(() => (window as any).__wiwy.app.enter(JSON.parse(localStorage.getItem('wiwy.session.v1')!).data));
  await page.waitForFunction(() => (window as any).__wiwy.entered());
  expect((await state(page)).interactions).toBe(before);
  expect((await page.evaluate(() => (window as any).__wiwy.world('drawer_top'))).open).toBe(1);

  // Restart begins a fresh session.
  await page.getByRole('button', { name: 'Pause menu' }).click();
  await page.getByRole('button', { name: 'Restart' }).click();
  await settle(page, 1200);
  let s = await state(page);
  expect(s.interactions).toBe(0);
  expect(s.hintVisible).toBe(true);
  // The new log holds only what happened since the restart: no earlier actions carry over.
  expect((await events(page)).filter((e) => e.type !== 'session_started' && e.type !== 'area_glanced')).toHaveLength(0);
  expect((await page.evaluate(() => (window as any).__wiwy.world('drawer_top'))).open).toBe(0);

  // Reset removes everything stored locally.
  await page.getByRole('button', { name: 'Pause menu' }).click();
  await page.getByRole('button', { name: 'Reset session data' }).click();
  await settle(page, 1200);
  expect(await page.evaluate(() => [localStorage.getItem('wiwy.session.v1'), localStorage.getItem('wiwy.settings.v1')])).toEqual([null, null]);
  s = await state(page);
  expect(s.interactions).toBe(0);

  // Exit is always available.
  await page.getByRole('button', { name: 'Pause menu' }).click();
  await page.getByRole('button', { name: 'Exit' }).click();
  await expect(page.getByRole('heading', { name: 'You left the room.' })).toBeVisible();
  expect((await state(page)).paused).toBe(true);
  await expectNoErrors(page);
});
