import './ui/styles.css';
import { App } from './app/App';
import { installTestHooks } from './app/testHooks';
import { seedFromString } from './core/rng';

const params = new URLSearchParams(location.search);
const test = params.has('test');
const seedParam = params.get('seed');

function webgl2Available(): boolean {
  try {
    return !!document.createElement('canvas').getContext('webgl2');
  } catch {
    return false;
  }
}

const root = document.getElementById('app')!;

if (!webgl2Available()) {
  root.innerHTML = `<div class="left-screen open"><div class="gate-inner"><h1 class="wordmark">This room needs WebGL2.</h1><p>Your browser or device does not support WebGL2, so the room cannot be drawn. A recent version of Chrome, Edge, Firefox or Safari will work.</p></div></div>`;
} else {
  const app = new App(root, {
    seed: seedParam !== null ? (/^\d+$/.test(seedParam) ? Number(seedParam) : seedFromString(seedParam)) : test ? 1 : null,
    test,
    timeScale: Math.max(0.1, Math.min(50, Number(params.get('speed') ?? 1) || 1)),
    inspector: params.has('inspector'),
  });
  if (test || import.meta.env.DEV) installTestHooks(app);
  void app.boot();
}
