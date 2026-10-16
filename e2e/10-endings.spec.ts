import { expect, test } from '@playwright/test';
import { boot, clickObject, enter, expectNoErrors, hook, settle, shot, state, waitRig } from './helpers';

test.describe('10. reaching all three endings', () => {
  test('acknowledgment', async ({ page }) => {
    await boot(page);
    await enter(page);
    // Gateways are closed until the Director opens one from the player's profile.
    await hook(page, 'forcePhase', 'confrontation');
    expect(await page.evaluate(() => (window as any).__wiwy.app.session.core.requestEnding('acknowledgment'))).toBe(false);
    await hook(page, 'openGateways', ['acknowledgment']);

    await clickObject(page, 'computer');
    await waitRig(page, 'inspect');
    await hook(page, 'simulate', 300);
    await page.waitForFunction(() => (window as any).__wiwy.state().screenMode === 'question');
    await settle(page, 400);
    await shot(page, '10-ack-question');

    // Answer on the in-room screen with the real pointer.
    const yes = await page.evaluate(() => {
      const w = (window as any).__wiwy;
      const uv = w.app.session.screen.buttonUv('yes');
      return uv;
    });
    expect(yes).not.toBeNull();
    await hook(page, 'answer', 'yes');
    await hook(page, 'simulate', 3500);
    let s = await state(page);
    expect(s.phase).toBe('resolution');
    expect(s.ending).toBe('acknowledgment');
    expect(s.messages.at(-1)?.text).toMatch(/light/i);

    // The room now responds to deliberate actions: the lamp, twice.
    await page.keyboard.press('Escape');
    await waitRig(page, 'look');
    await clickObject(page, 'lamp');
    await hook(page, 'simulate', 2000);
    expect((await state(page)).messages.at(-1)?.text).toBe('Again.');
    await clickObject(page, 'lamp');
    await hook(page, 'simulate', 2500);
    expect((await state(page)).messages.at(-1)?.text).toBe('Thank you for looking.');
    // Dark screen, fade, then the end card 9.5 s after the thanks.
    await hook(page, 'simulate', 11_000);
    await page.waitForFunction(() => (window as any).__wiwy.state().endingFinished === true, null, { timeout: 30_000 });
    await expect(page.getByText('Ending · Acknowledgment')).toBeVisible();
    await shot(page, '10-ack-end');
    await expectNoErrors(page);
  });

  test('refusal', async ({ page }) => {
    await boot(page);
    await enter(page);
    await hook(page, 'openGateways', ['refusal']);
    await clickObject(page, 'door');
    await hook(page, 'simulate', 200);
    let s = await state(page);
    expect(s.ending).toBe('refusal');
    expect(s.locked).toBe(true);
    await settle(page, 1500);
    await shot(page, '10-refusal-hallway');
    await hook(page, 'simulate', 11_000);
    await settle(page, 2600);
    // The same room again, with one detail changed.
    s = await state(page);
    expect(s.locked).toBe(false);
    expect((await page.evaluate(() => (window as any).__wiwy.world('photograph'))).state).toBe('removed');
    expect((await page.evaluate(() => (window as any).__wiwy.world('door'))).open).toBeLessThan(0.2);
    await expect(page.getByText('Take a look around.')).toBeVisible();
    await shot(page, '10-refusal-again');
    await hook(page, 'simulate', 18_500);
    await expect(page.getByText('Ending · Refusal')).toBeVisible();
    await shot(page, '10-refusal-end');
    await expectNoErrors(page);
  });

  test('reversal', async ({ page }) => {
    await boot(page);
    await enter(page);
    // A routine: the same few actions, repeated.
    for (let i = 0; i < 2; i++) {
      await clickObject(page, 'lamp');
      await hook(page, 'look', 0.62, -0.42);
      await clickObject(page, 'drawer_top', { look: false });
      await settle(page, 300);
      await clickObject(page, 'drawer_top', { look: false });
    }
    await hook(page, 'look', 0.45, -0.12);
    await hook(page, 'openGateways', ['reversal']);
    // The player stops. The room takes over.
    await page.mouse.move(5, 5);
    await hook(page, 'simulate', 16_000);
    let s = await state(page);
    expect(s.ending).toBe('reversal');
    expect(s.locked).toBe(true);
    const replayed = await page.evaluate(() => (window as any).__wiwy.app.session.core.world.historyOf('lamp').filter((r: { cause: string }) => r.cause === 'reversal_replay').length as number);
    await hook(page, 'simulate', 9000);
    const replayedLater = await page.evaluate(() => (window as any).__wiwy.app.session.core.world.historyOf('lamp').filter((r: { cause: string }) => r.cause === 'reversal_replay').length as number);
    expect(replayedLater).toBeGreaterThan(replayed - 1);
    expect(replayedLater).toBeGreaterThan(0);
    await hook(page, 'simulate', 4000);
    await settle(page, 4500); // the scripted turn toward where the player stood
    await shot(page, '10-reversal-turn');
    await hook(page, 'simulate', 9000);
    await settle(page, 2800);
    s = await state(page);
    expect(s.endingFinished).toBe(true);
    await expect(page.getByText('Ending · Reversal')).toBeVisible();
    await shot(page, '10-reversal-end');
    await expectNoErrors(page);
  });
});
