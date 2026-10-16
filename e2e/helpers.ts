import { expect, type Page } from '@playwright/test';

// Outside Playwright's outputDir, which is emptied at the start of every run.
export const SHOTS = 'e2e-screenshots';

/** Load the experience in deterministic test mode and wait until the room is built. */
export async function boot(page: Page, query = 'test&seed=7'): Promise<void> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  (page as Page & { __errors?: string[] }).__errors = errors;
  await page.goto(`/?${query}`);
  await page.waitForFunction(() => (window as any).__wiwy?.ready(), null, { timeout: 90_000 });
}

export async function enter(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Enter' }).click();
  await page.waitForFunction(() => (window as any).__wiwy.entered());
}

export function pageErrors(page: Page): string[] {
  return (page as Page & { __errors?: string[] }).__errors ?? [];
}

/** Call a test hook in the page. */
export function hook<T = unknown>(page: Page, name: string, ...args: unknown[]): Promise<T> {
  return page.evaluate(([n, a]) => (window as any).__wiwy[n as string](...(a as unknown[])), [name, args] as const) as Promise<T>;
}

export type State = {
  phase: string;
  now: number;
  paused: boolean;
  gateways: string[];
  ending: string | null;
  endingActive: string | null;
  endingFinished: boolean;
  interactions: number;
  followerStage: number;
  hintVisible: boolean;
  messages: { text: string; templateId: string; refs: number[]; createdAt: number }[];
  screenMode: string;
  inspecting: string | null;
  rigMode: string;
  held: string | null;
  audio: string;
  trailMarks: number;
  locked: boolean;
  decisions: { anomalyId: string; result: string; detail: string }[];
};

export const state = (page: Page) => hook<State>(page, 'state');
export const world = (page: Page, id: string) => hook<Record<string, unknown>>(page, 'world', id);
export const events = (page: Page, type?: string) => hook<{ id: number; type: string; target?: string; timestampMs: number; durationMs?: number; meta: Record<string, unknown> }[]>(page, 'events', type);

/** Pixel coordinates of an object's centre on the canvas. */
export async function pixelOf(page: Page, id: string): Promise<{ x: number; y: number }> {
  const n = await hook<{ x: number; y: number }>(page, 'ndcOf', id);
  const box = (await page.locator('#app canvas').boundingBox())!;
  return { x: box.x + ((n.x + 1) / 2) * box.width, y: box.y + ((1 - n.y) / 2) * box.height };
}

/** Turn toward an object, then click it with the real mouse (the full pointer path). */
export async function clickObject(page: Page, id: string, opts: { look?: boolean } = {}): Promise<void> {
  if (opts.look !== false) {
    await hook(page, 'lookAt', id);
    await page.waitForTimeout(150);
  }
  const p = await pixelOf(page, id);
  await page.mouse.move(p.x - 30, p.y + 20, { steps: 4 });
  await page.mouse.move(p.x, p.y, { steps: 6 });
  await page.mouse.down();
  await page.mouse.up();
}

/** Wait for camera transitions to settle (rendering keeps running). */
export async function settle(page: Page, ms = 1600): Promise<void> {
  await page.waitForTimeout(ms);
}

export async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: `${SHOTS}/${name}.png` });
}

export async function expectNoErrors(page: Page): Promise<void> {
  expect(pageErrors(page)).toEqual([]);
}

/** Wait until the camera has finished moving into (or out of) inspection. */
export async function waitRig(page: Page, mode: 'inspect' | 'look'): Promise<void> {
  await page.waitForFunction((m) => (window as any).__wiwy.state().rigMode === m, mode, { timeout: 20_000 });
  await page.waitForTimeout(250);
}

/** Turn the view toward an object and take a few attention samples. */
export async function look(page: Page, id: string): Promise<void> {
  await hook(page, 'lookAt', id);
  await hook(page, 'simulate', 300);
}
