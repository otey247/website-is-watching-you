import { expect, test } from '@playwright/test';
import { boot, clickObject, enter, expectNoErrors, hook, settle, shot, state } from './helpers';

test('9. progressing through narrative phases', async ({ page }) => {
  await boot(page);
  await enter(page);

  // Time alone never advances the story.
  await hook(page, 'simulate', 120_000);
  expect((await state(page)).phase).toBe('normalcy');

  // Real interactions with enough distinct objects move it to Inconsistency.
  await hook(page, 'look', 0.62, -0.42);
  await clickObject(page, 'drawer_top', { look: false });
  await clickObject(page, 'drawer_top', { look: false });
  await clickObject(page, 'lamp');
  await clickObject(page, 'lamp');
  await clickObject(page, 'curtains');
  await settle(page, 300);
  await clickObject(page, 'curtains');
  await clickObject(page, 'door');
  await hook(page, 'simulate', 1500);
  expect((await state(page)).phase).toBe('inconsistency');
  await hook(page, 'look', 0.45, -0.12);
  await settle(page, 2500);
  await shot(page, '09-phase-inconsistency');

  // Later phases are forced in test mode; each changes the grade and audio mix.
  const grade = () => page.evaluate(() => (window as any).__wiwy.app.postfx.uniform('uSat').value as number);
  const sat0 = await grade();
  for (const p of ['recognition', 'anticipation', 'confrontation'] as const) {
    await hook(page, 'forcePhase', p);
    await hook(page, 'simulate', 500);
    expect((await state(page)).phase).toBe(p);
    await settle(page, 6000); // the grade eases in over several seconds
    await shot(page, `09-phase-${p}`);
  }
  expect(await grade()).toBeLessThan(sat0);

  // Confrontation only resolves through a gateway and its own guard.
  const s = await state(page);
  expect(s.gateways).toEqual([]);
  expect(await page.evaluate(() => (window as any).__wiwy.app.session.core.requestEnding('refusal'))).toBe(false);
  await expectNoErrors(page);
});
