# Architecture

The project splits into a **pure simulation core**, which has no rendering, DOM or audio, and a **browser shell** that renders the room and feeds the core what the player sees and does. The unit and integration tests drive the same `GameCore` class the browser uses, with a scripted visibility oracle in place of the renderer.

```
                 ┌──────────────────────────── browser shell (src/app, src/scene, src/interaction, src/audio, src/ui) ───────────────────────────┐
 pointer/touch → │ Interaction ──report()/grab()──┐        CameraRig        ScenePresenter ◄── world 'changed'         AudioDirector ◄── 'sound' │
 keyboard      → │                                │            │                  ▲                                         ▲                   │
                 │ AttentionEstimator (10 Hz) ────┼── VisibilityOracle port ───────┼──────────────┐                          │                   │
                 │ CaptureService ◄───────────────┼── capture() port               │              │                          │                   │
                 └────────────────────────────────┼────────────────────────────────┼──────────────┼──────────────────────────┼───────────────────┘
                                                  ▼                                │              ▼                          │
                 ┌──────────────────────────── GameCore (src/game) ─────────────────────────────────────────────────────────────────────────────────┐
                 │  SessionClock ─ Rng(seed)                                                                                                         │
                 │  Telemetry ──recorded──► Observer (interest, scores, Predictor) ──► Director ──► Executor ──claims/apply──► WorldState            │
                 │      ▲                       │                                       │  ▲            │                                             │
                 │      └── derived signals ◄── sampleAttention()                       │  └ phaseMachine (XState)  └── EffectSink: sound / effect / capture│
                 │  Narrative (templates, validator, callbacks, optional local LLM) ◄────┘                                                          │
                 │  FollowerSim + PointerHistory      Entity (nav graph)                                                                             │
                 └──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

## Contracts between systems

| From → to | Contract | Where |
|---|---|---|
| Interaction → core | `report(type, target, {durationMs, meta})`, `grab/release(id)`, `hover(id)`, `pointerMoved()`, `trail(point)` | `GameCore` |
| Shell → core | `VisibilityOracle` (`visibility`, `isUnseen`, `unseenForMs`, `score`, `isPointVisible`, `focus`), `camera()`, `capture(kind)` | `CorePorts` in `src/game/GameCore.ts` |
| Core → shell | typed emitter events: `sound`, `effect`, `followerMarks`, `phase`, `gateways`, `instructionDismissed`; Narrative `message`; WorldState `changed` | `CoreEvents` |
| Observer → Director | read-only: the Director reads Observer state through `DirectorCtx`. The Observer has no reference to the world or the scene. | `src/director/types.ts` |
| Director → world | only through the Executor, which claims targets, enforces the visibility contract each frame and commits `MutationRecord`s | `src/director/Executor.ts` |
| Narrative → screen | `ObserverMessage` objects, each carrying its supporting event ids; text is validated before it is emitted | `src/narrative/Narrative.ts` |
| Local LLM → narrative | `DialogueModel.propose()` returns wording plus cited event ids only; there is no API surface for state changes | `src/narrative/llm.ts` |

The rule from the brief, that the Observer can't modify scene objects directly, holds structurally. `Observer` only receives `Telemetry`, and `WorldState.apply` is called by exactly three kinds of caller: the interaction layer (`source: 'player'`), the Executor (`'director'`) and endings (`'ending'`).

## Cadence

Nothing narrative runs every frame.

| What | Rate | Clock |
|---|---|---|
| Render, camera, springs, effects | every animation frame | real time |
| `GameCore.tick`: Director executor (visibility contract checks), follower | every frame | session time |
| Director phase evaluation and scheduling | every 500 ms; attempts every 5–11 s | session time |
| Attention sampling, derived signals, entity movement | 10 Hz | session time |
| Prediction | 10 Hz | session time |
| Observer decay and derived scores | 2 Hz (inside the 500 ms evaluation) | session time |
| Hover raycast and trail projection | ≈30 Hz, on pointer move | real time |

**Session time** is active play only. `SessionClock` stops while the gate, the pause menu or a hidden tab holds it. Each pause reason is tracked separately, so closing the menu does not resume a hidden tab. Frames longer than 100 ms are clamped. Test mode uses `simulate(ms)`, which advances the same pipeline in fixed 100 ms steps without waiting in real time.

## Determinism

One seeded generator (mulberry32, `src/core/rng.ts`) drives every random choice in the core: scheduling, restraint, plans, callbacks and follower shortcuts. Its state is part of the save file. `?seed=<n>` fixes the seed in the browser, and `?test` defaults it to 1. The same seed and the same inputs replay the same session; `tests/unit/gamecore.test.ts` asserts this.

## Rendering

* **Room:** built procedurally in `src/scene/RoomBuilder.ts`. Furniture is made from primitives with real-world proportions. Materials are `MeshStandardMaterial` and `MeshPhysicalMaterial` (clearcoat on the desk and mirror frame, a transparent clearcoated glass layer over the photograph). Wood grain, plaster, fabric, book spines, the clock face, the note and the garden photographs are painted into canvases at startup (`textures.ts`, `photoPainter.ts`). Ambient occlusion is baked into the wall map and soft contact shadows are baked into floor decals. There are no external assets, so nothing loads during play.
* **Light:** one shadow-casting directional sun (2048² map) through the window, a `RectAreaLight` for the window's soft fill, a hemisphere light, the floor lamp's point light (no shadows), and a faint hallway light. Curtains scale the sun and window light.
* **Mirror:** a real planar `Reflector`. Its render hook is wrapped so the reflection can lag (re-rendered only every N ms), can show the chair at a previous position for a moment, and can include the figure. The figure lives on render layer 2, which only the mirror's reflection camera and the photo capture camera enable.
* **Captures:** `CaptureService` preallocates six 640×480 half-float render targets (LRU with pinning for the photo currently shown) plus a 512×320 surveillance feed target. Room photographs are rendered from a fixed corner camera with the photo frame hidden. No render target is created during play.
* **Trail:** one `InstancedMesh` of 720 small quads oriented to the surface normal, faded in the shader by age (player marks 5 s, follower marks 7.5 s).
* **Post:** `EffectComposer` running RenderPass → BokehPass (high quality only, enabled only while inspecting) → UnrealBloom (low strength) → a grade shader (white balance, saturation, contrast, deep-shadow crush, vignette, grain, rare event distortion) → OutputPass (ACES tone mapping and sRGB). Each phase eases the grade toward its own values over several seconds.
* **Adaptive resolution:** the shell keeps a 90-frame average. If frames exceed the budget (16.9 ms desktop, 33.4 ms on coarse-pointer devices) by 15 %, the pixel ratio drops by 0.15, down to 0.6. With headroom it rises again, up to 1.75 (1.25 on mobile).

## Audio

`src/audio/synth.ts` synthesizes every sound procedurally at startup (25 one-shots and 4 seamless ambient loops) as plain float arrays. `AudioDirector` turns them into `AudioBuffer`s on the first user gesture. Routing: listener → dry + convolver (procedural room impulse) → master gain. One-shots use a pool of 14 `PositionalAudio` voices placed at the sound's world position. The fan and traffic layers are positional; room tone and hum are not. Each phase has its own ambient mix. `silence(ms, level)` drops the layers quickly and lets them return slowly. Clock ticks are driven by the visible second hand, so a stalled clock goes silent and a skip drops ticks.

## Shell lifecycle (`src/app/App.ts`)

1. `boot()` builds the room, paints textures, synthesizes audio and creates a session behind the entry gate, with the clock paused.
2. **Enter** starts audio (a user gesture), lifts the gate and resumes the clock.
3. **Pause menu** pauses the clock. **Save and leave** writes `GameCore.snapshot()` to localStorage and shows a "you left" screen. **Restart** replaces the `Session` (core, attention, presenter, interaction, endings, screen). **Reset** also clears stored data. **Exit** pauses everything and shows the "you left" screen.
4. Tab hidden: the clock pauses and the audio context suspends.

## Developer inspector

`src/debug/Inspector.ts` is loaded with a dynamic `import()` only when `import.meta.env.DEV` is true, so the production bundle does not contain it. Toggle it with the backquote key, or open it at startup with `?inspector`. Tabs:

* **Observer:** scores, ending affinity, current prediction, profile, and messages with their evidence ids.
* **Director:** progress toward the next phase against its requirements, running events, every anomaly in the phase with its eligibility reason or weight, recent decisions, and force controls.
* **Events:** the telemetry log with meta and which systems consumed each event.
* **Attention:** per-object visibility class and score, and area scores.

Gate evaluation can draw from the RNG while building a plan, so the inspector saves and restores the RNG state around it. Inspecting a session does not change the session.

## Directory map

```
src/
  app/          App shell, session lifecycle, effects, test hooks
  attention/    AttentionEstimator
  audio/        procedural synthesis, AudioDirector
  core/         rng, session clock, emitter, math, room layout constants
  debug/        dev-only inspector
  director/     phase machine, anomaly catalogue, Director, Executor
  endings/      the three endings
  entity/       hidden presence on a nav graph
  game/         GameCore (composition root of the simulation)
  interaction/  camera rig, pointer/touch/keyboard interaction
  narrative/    templates, validator, callbacks, local LLM adapter
  observer/     Observer model, Predictor
  persistence/  local-only save and settings
  scene/        room builder, textures, photo painter, presenter, captures, screen, trail, post
  telemetry/    event types and bounded log
  trail/        pointer history and follower simulation
  ui/           DOM overlay and styles
tests/unit/     Vitest unit and integration tests (headless, no WebGL)
e2e/            Playwright scenarios (real browser, WebGL via SwiftShader in CI)
docs/           this document, BEHAVIOR.md, SCHEMA.md, CASE_STUDY.md
```
