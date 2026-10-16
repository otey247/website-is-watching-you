# Behavioral systems

How the room watches, remembers, predicts and decides. Constants quoted here are the values in the source at the time of writing; each section names the file to check.

## 1. Attention (`src/attention/AttentionEstimator.ts`)

Sampled about 10 times per second of session time. For each tracked object:

1. **Frustum.** Five sample points over the object's bounding sphere (centre and four offsets along the camera's right and up vectors) are tested against the view frustum.
2. **Occlusion.** Each in-frustum sample is raycast from the camera against the room's occluders (walls, furniture). Hits on the object's own meshes and invisible meshes are ignored. `visibleFraction` = clear samples / 5. In frustum with zero clear samples means **occluded**.
3. **Mirror.** If the mirror itself is visible, the object's centre is reflected across the mirror plane and the line of sight through the glass rectangle is tested. Objects seen in the mirror count as seen (they cannot change unseen), but receive no direct attention score.
4. **Screen-space size.** `radius / (distance × tan(fov/2))`.
5. **Centrality.** Angle between the camera forward vector and the object.
6. **Pointer.** Distance in NDC between the pointer and the object's projected centre, minus half its screen size. The pointer is treated as a weak hint, never as eye tracking.

```ts
const centrality = 1 - smoothstep(0.05, halfFov * 1.25, e.centerAngle);
const size = smoothstep(0.02, 0.35, e.screenSize);
const pointerAtt = Number.isFinite(e.pointerDistance) ? 1 - smoothstep(0.02, 0.25, e.pointerDistance) : 0;
e.score = clamp01(e.visibleFraction * (0.6 * centrality + 0.2 * size + 0.35 * pointerAtt));
e.visibility = e.score >= ATTENDED_THRESHOLD /* 0.42 */ ? 'attended' : 'peripheral';
```

Classes: **attended**, **peripheral** (visible, score below 0.42), **occluded**, **offscreen**. `unseenForMs(id)` is the time since the object was last visible directly or in the mirror. Area scores are the best object score in each of the eight areas (desk, window, hallway, shelf, photo wall, mirror, table, lamp corner).

## 2. Telemetry (`src/telemetry/`)

Only in-room actions exist as event types (see [SCHEMA.md](SCHEMA.md)). The log keeps the most recent 600 events; counters persist. `GameCore` derives higher-level signals from the 10 Hz attention samples:

| Signal | Rule |
|---|---|
| `object_hesitated` | pointer rests on an interactable ≥300 ms before clicking (`outcome: clicked`) or ≥900 ms then leaves (`abandoned`) |
| `area_glanced` | an area becomes attended after ≥20 s unattended (rate-limited to once per 20 s) |
| `area_avoided` | Observer avoidance for the area ≥0.6, at most every 3 minutes |
| `sound_reacted` | a Director sound from an area is followed by attention to that area within 2.5 s (`reacted: true`), or not within 4 s (`reacted: false`) |
| `anomaly_witnessed` | an object changed by the Director is attended for 600 ms |
| `anomaly_investigated` | the player interacts with a witnessed object within 30 s |
| `message_read` | a new computer message is attended for more than 300 ms and then looked away from |
| `look_away_test` | two cycles of watching an object ≥700 ms, looking away 1.2–8 s, and looking back, within 45 s |
| `player_idle` | 12 s without input |

## 3. The Observer (`src/observer/Observer.ts`)

A set of continuous scores, never categories:

| Score | Rises with | Decay half-life |
|---|---|---|
| familiarity | `log1p(interactions) / log1p(60)` | none |
| suspicion | witnessing (+0.05), investigating (+0.12), reacting to sounds (+0.04), look-away tests (+0.08) | 240 s |
| curiosity | distinct objects inspected / 12; investigating (+0.08) | none |
| avoidance | max over areas of `avoidanceOf(area)` (below) | recomputed |
| predictability | `0.6 × predictor accuracy + 0.4 × repetition`, faded in over the first 4 to 20 predicted interactions | recomputed |
| tension | anomalies (`+def.tension`) | 90 s |
| exposure | anomalies (`+0.15 + 0.3 × tension`) | 60 s |
| fatigue | most-repeated anomaly exposure / 6 | recomputed |
| testing | look-away tests (+0.22), rapid lamp toggling (+0.1) | 120 s |

**Interest** per object accumulates with each action (inspection weight `1 + min(2, duration/4 s)`, other actions 0.6) and decays with a 5-minute half-life.

**Avoidance needs evidence.** It stays exactly 0 until the player has 150 s of active play *and* 90 s of attention samples. After that, an area's avoidance is driven by its share of attention time compared with an even split, plus declined opportunities (abandoned hesitations at objects in that area, Director sounds from it that the player did not turn toward). Time passing alone never raises any score; idle time only feeds `stillness`.

**Profile** (`profile()`): most inspected object, least visited area, light preference (share of time with the lamp on), average hesitation, exploration path (areas in first-visit order), investigation rate (investigated / witnessed), repetition, turn bias, stillness, historically likely next interaction.

**Ending affinity** (`endingAffinity()`), used only to decide which ending gateway opens:

```ts
acknowledgment: 0.5 * investigation + 0.3 * curiosity + 0.2 * testing
refusal:        0.55 * avoidance + 0.3 * (1 - investigation) + 0.15 * min(1, doorAttempts / 3)
reversal:       0.55 * predictability + 0.3 * min(1, repetition * 2) + 0.15 * stillness
```

## 4. Prediction (`src/observer/Predictor.ts`)

A softmax over the on-screen interactable objects plus a fixed "no interaction" logit of 1.2, run at 10 Hz. Features per candidate: pointer **direction** (cosine between pointer velocity and the direction to the object), **proximity** (pointer distance), **centrality**, recent **dwell**, Markov **transition** probability from the last target, and historical **frequency**.

* A **commit** is made when the top candidate's probability passes 0.5 plus a per-target bias. A commit lives 4.5 s and resolves as **hit**, **miss** or **expired** against the next real interaction (recorded as `prediction_resolved`).
* Misses raise that target's threshold by 0.06 (up to +0.3); hits lower it by 0.03 (down to −0.12). The Observer gets more cautious where it was wrong.
* Each real interaction takes one cross-entropy gradient step on the feature weights (clamped to 0..6), so the model is visibly imperfect early and improves with evidence.
* Predictions never touch input. They only reach the Director, which evaluates `anticipation` anomalies on each prediction update, subject to the same gates as everything else.

## 5. The Horror Director (`src/director/`)

### Phases (`phaseMachine.ts`, XState v5)

Transitions are evaluated every 500 ms with live metrics. Time in phase is one requirement among several; it is never sufficient on its own, and a player who does nothing stays in Normalcy indefinitely (covered by `tests/unit/gamecore.test.ts`).

| Transition | Requirements (all must hold) |
|---|---|
| Normalcy → Inconsistency | 75 s in phase, 6 interactions, 4 distinct objects |
| Inconsistency → Recognition | 120 s in phase, 3 anomalies applied, 14 interactions, and either 1 anomaly witnessed or 22 interactions |
| Recognition → Anticipation | 150 s in phase, 2 messages shown, 1 delayed callback delivered, 18 interactions seen by the predictor |
| Anticipation → Confrontation | 150 s in phase, 2 anticipation responses executed, follower stage ≥2, tension ≥0.2 |
| Confrontation → Resolution | 2 confrontation events, an open gateway, and the player taking that gateway |

### Pacing (`Director.ts`, `PACING`)

| Setting | Value |
|---|---|
| Phase evaluation | every 500 ms |
| Attempt interval | random 5–11 s |
| Quiet period after an event | ambient 8–15 s, subtle 20–40 s, notable 40–70 s, major 70–110 s |
| Restraint (chance to deliberately do nothing at an attempt) | normalcy 100 %, inconsistency 45 %, recognition 35 %, anticipation 30 %, confrontation 20 % |
| Tension cap | inconsistency 0.4, recognition 0.6, anticipation 0.8, confrontation 1.2 |
| Concurrent events | 2 (3 for anticipation responses) |
| All gateways open | after 6 minutes in confrontation |

### Gates

Every candidate passes the same gates, in order. The first failure is the reason the inspector shows:

1. phase
2. repetition limit (`maxRepeats`)
3. cooldown
4. related-group spacing (`minSinceGroups`)
5. sudden-event setting
6. not already running
7. behavioral requirement (`requires` returns supporting event ids, or null)
8. room-state prerequisite
9. tension budget
10. plan construction (a valid, collision-free target must exist)
11. targets not being tested by the player, not busy, not claimed

Eligible candidates are chosen by weighted random selection: `baseWeight × affinity × novelty × fatigue`, where `novelty = 1 / (1 + 0.8 × exposure)` and `fatigue = 1 − 0.5 × observer.fatigue`. `affinity` is per anomaly (for example, photo anomalies scale with interest in the photograph). All randomness flows from one seeded generator, so a seed reproduces a session.

### Execution and visibility contracts (`Executor.ts`)

A scheduled event claims all its targets atomically, then waits up to `waitMs` for its visibility contract (`unseen` for at least `minUnseenMs`, `peripheral`, or `direct`). The contract is re-checked every frame while the event runs. If the player looks:

* **freeze**: the animation stops exactly where it is and the partial change is committed (`cause: "<id>:partial"`). Nothing snaps.
* **revert**: undo if still unseen, otherwise freeze.
* **continue**: keep going in plain view (only confrontation events use this).

The player always preempts: grabbing an object an event has claimed cancels that event cleanly.

### Anomaly catalogue

49 anomalies. Visibility shows the contract mode, minimum unseen time and interruption policy.

| Id | Phases | Significance | Visibility | Cooldown | Max | Sudden | What happens |
|---|---|---|---|---|---|---|---|
| `photo_first_change` | inconsistency, recognition | notable | unseen ≥8s, freeze | 0s | 1 |  | The photograph changes while nobody is looking: one person moves, or is gone. |
| `chair_rotate_slight` | inconsistency, recognition, anticipation, confrontation | subtle | unseen ≥3s, freeze | 120s | 2 |  | The chair rotates by five degrees while off-screen. |
| `book_shift` | inconsistency, recognition, anticipation, confrontation | subtle | unseen ≥5s, freeze | 150s | 2 |  | A book moves to a different shelf. |
| `clock_lose_seconds` | inconsistency, recognition, anticipation, confrontation | subtle | unseen ≥4s, freeze | 200s | 2 |  | The clock loses seven seconds. |
| `clock_skip_tick` | inconsistency, recognition, anticipation, confrontation | ambient | direct, continue | 90s | 4 |  | A momentary interruption in the ticking. |
| `lamp_off_when_away` | inconsistency, recognition, anticipation, confrontation | subtle | unseen ≥6s, freeze | 160s | 2 |  | The lamp turns off after the player moves away. |
| `drawer_ajar` | inconsistency, recognition, anticipation, confrontation | subtle | unseen ≥4s, freeze | 140s | 2 |  | A drawer the player closed is slightly open when revisited. |
| `figurine_faces_camera` | inconsistency, recognition, anticipation, confrontation | subtle | unseen ≥5s, freeze | 180s | 2 |  | A small object examined earlier is now facing the camera. |
| `cursor_nudge` | inconsistency, recognition, anticipation, confrontation | ambient | peripheral, freeze | 100s | 3 |  | The cursor on the fictional screen moves one pixel by itself. |
| `mirror_lag` | inconsistency, recognition, anticipation, confrontation | subtle | direct, continue | 160s | 2 |  | The reflection briefly lags behind the ceiling fan. |
| `scrape_offscreen` | inconsistency, recognition, anticipation, confrontation | ambient | direct, continue | 70s | 6 |  | A quiet scrape from outside the current view. |
| `footstep_hallway` | inconsistency, recognition, anticipation, confrontation | ambient | direct, continue | 110s | 6 |  | A single footstep in the adjacent hallway. More frequent if the player avoids it. |
| `photo_gazing` | recognition, anticipation, confrontation | notable | unseen ≥8s, freeze | 0s | 1 |  | One person in the photograph now looks directly toward the viewer. |
| `photo_revert` | recognition, anticipation, confrontation | subtle | unseen ≥6s, freeze | 300s | 1 |  | After the player has checked a change, the photograph quietly returns to how it was. Harder to verify. |
| `chair_creep` | recognition, anticipation, confrontation | subtle | unseen ≥3s, freeze | 120s | 4 |  | The chair moves a few centimeters toward where the player stands. |
| `chair_return_desk` | recognition, anticipation, confrontation | notable | unseen ≥5s, freeze | 150s | 2 |  | The player moved the chair; it is back at the desk, a little closer than before. |
| `chair_face_wall` | recognition, anticipation | notable | unseen ≥6s, freeze | 240s | 1 |  | The chair has turned to face the wall. |
| `returning_object` | recognition, anticipation, confrontation | notable | unseen ≥6s, freeze | 160s | 2 |  | An item the player moved reappears in its original place, now facing the player. |
| `observer_message` | recognition, anticipation, confrontation | notable | unseen ≥1.5s, freeze | 70s | 30 |  | A short message on the computer referring to something the player actually did. |
| `callback_message` | recognition, anticipation, confrontation | notable | unseen ≥1.5s, freeze | 90s | 12 |  | A delayed reference, minutes later, to an ordinary action. |
| `unnatural_silence` | recognition, anticipation, confrontation | subtle | direct, continue | 150s | 4 |  | When the player stops moving, the ambient layers become unusually quiet. |
| `test_noticed` | recognition, anticipation, confrontation | major | unseen ≥1.5s, freeze | 180s | 2 |  | The player is testing whether things move when they look away. The tested object stays; something behind them changes instead. |
| `follower_marks` | recognition, anticipation | notable | direct, continue | 0s | 1 |  | Faint marks begin appearing along the pointer path. |
| `familiar_sound` | anticipation, confrontation | notable | direct, continue | 200s | 2 |  | The room replays a sequence of the player's own clicks and object sounds from their sources. |
| `anticipate_door_handle` | anticipation, confrontation | notable | direct, continue | 90s | 4 |  | As the pointer approaches the door, the handle turns slightly. It stops when the player pauses, and returns when they move away. |
| `anticipate_lamp` | anticipation, confrontation | notable | direct, continue | 120s | 2 |  | The player habitually turns on the lamp; the lamp turns on as the pointer approaches. |
| `anticipate_photo_turn` | anticipation, confrontation | notable | peripheral, continue | 150s | 2 |  | For a player obsessed with the photograph, it tilts slightly toward them as the camera turns to it. |
| `anticipate_book_open` | anticipation, confrontation | notable | direct, continue | 120s | 2 |  | A book opens slightly just before the player reaches for it. |
| `anticipate_drawer` | anticipation, confrontation | notable | direct, continue | 120s | 2 |  | The drawer slides open a centimeter as the pointer approaches it. |
| `anticipate_sound` | anticipation, confrontation | subtle | direct, continue | 60s | 5 |  | A subtle sound precedes the predicted interaction, from the object itself. |
| `prediction_message` | anticipation, confrontation | notable | unseen ≥1.5s, freeze | 90s | 4 |  | The computer mentions a prediction — only after an observed decision supports it. |
| `follower_appears` | anticipation, confrontation | major | direct, continue | 0s | 1 |  | A second trail of marks follows the original path with a delay. |
| `follower_closes_in` | anticipation, confrontation | major | direct, continue | 0s | 1 |  | The follower delay shortens; it stops when the player stops. |
| `mirror_past_chair` | anticipation, confrontation | notable | direct, continue | 150s | 2 |  | The mirror shows the chair in its previous position, then catches up. |
| `impossible_drawer` | anticipation, confrontation | major | unseen ≥5s, freeze | 300s | 1 |  | The player opens a drawer and finds a book they placed elsewhere. |
| `photo_room_now` | anticipation, confrontation | major | unseen ≥8s, freeze | 0s | 1 |  | The photograph depicts this room, with the chair exactly where it was earlier. |
| `photo_room_past` | confrontation | major | unseen ≥6s, freeze | 0s | 1 |  | The photograph shows an earlier arrangement the player created (drawer open, lamp off...). |
| `photo_figure` | confrontation | major | unseen ≥6s, freeze | 0s | 1 |  | The photograph shows the current room with one more, indistinct figure: standing where the player stands. |
| `chair_face_prev` | anticipation, confrontation | notable | unseen ≥4s, freeze | 120s | 2 |  | The chair faces the player's previous camera location. |
| `chair_face_now` | confrontation | major | direct, continue | 160s | 2 |  | The chair turns to face the player — slowly, even while watched. |
| `room_rearrange` | confrontation | major | unseen ≥4s, freeze | 300s | 1 |  | Several objects rearrange while the player looks away. |
| `lamp_flicker` | confrontation | notable | direct, continue | 160s | 2 | yes | The lamp flickers once. |
| `light_shift` | confrontation | notable | direct, continue | 240s | 1 |  | Daylight comes from a slightly wrong direction for a while. |
| `shadow_pass` | confrontation | major | direct, continue | 200s | 2 |  | A shadow crosses the sunlight on the floor. Nothing casts it. |
| `mirror_presence` | confrontation | major | peripheral, continue | 240s | 1 |  | For a moment the mirror shows something standing in the room. |
| `surveillance_feed` | confrontation | major | unseen ≥1.5s, freeze | 300s | 1 |  | The computer shows the room from the corner, looking at where the player stands. |
| `follower_shortcut` | confrontation | major | direct, continue | 0s | 1 |  | The follower stops replaying the exact path and heads for the object the player will inspect next. |
| `door_drift` | confrontation | major | unseen ≥4s, freeze | 200s | 1 |  | For a player who avoids the hallway, the door drifts further open on its own. |
| `confrontation_message` | confrontation | notable | unseen ≥1s, freeze | 60s | 10 |  | Direct lines in confrontation. |

## 6. Narrative (`src/narrative/`)

Messages come only from authored templates. Each template has an `evidence(ctx)` function that returns the event ids the statement depends on, or null when the statement would be false. Every message is checked by `validateStatement` before it is shown: referenced events must exist, and forbidden claims are rejected: webcam, camera, microphone, "your real computer/files/browser/tabs/history/location/name", IP address, tracking, malware or security warnings, download or permission requests, URLs, claims of knowing who the player is, and claims about the player's feelings or personality.

| Template | Intent | Phases |
|---|---|---|
| `photo_repeat` | observation | recognition, anticipation, confrontation |
| `drawer_second_time` | observation | recognition, anticipation, confrontation |
| `hallway_avoided` | observation | recognition, anticipation, confrontation |
| `preferred_darker` | observation | recognition, anticipation, confrontation |
| `chair_moved` | observation | recognition, anticipation, confrontation |
| `third_time` | count | recognition, anticipation, confrontation |
| `door_not_opened` | observation | recognition, anticipation, confrontation |
| `looked_away` | observation | recognition, anticipation, confrontation |
| `light_back_on` | observation | recognition, anticipation, confrontation |
| `attention` | direct | confrontation |
| `predicted_door` | prediction | anticipation, confrontation |
| `predicted_hit` | prediction | anticipation, confrontation |
| `testing_lookaway` | testing | recognition, anticipation, confrontation |
| `testing_checking` | testing | recognition, anticipation, confrontation |
| `testing_lamp` | testing | recognition, anticipation, confrontation |
| `noticed_photo` | direct | anticipation, confrontation |
| `book_returned` | direct | anticipation, confrontation |
| `stillness` | observation | anticipation, confrontation |
| `favorite` | observation | anticipation, confrontation |
| `callback` | callback | recognition, anticipation, confrontation |

**Delayed callbacks.** When an ordinary action happens (from a fixed list of callback types), the narrative system remembers it with probability 0.45, holding at most 6 pending and at most one per action type. The earliest delivery time is 140–320 s after the event. When the `callback_message` anomaly is chosen, the oldest due callback is phrased with `agoPhrase` ("a minute ago", "a few minutes ago", "earlier") and validated again. A callback whose fact is no longer true is dropped rather than shown.

**Optional local model.** Off by default. When enabled in Settings, the endpoint must resolve to `localhost`, `127.0.0.1` or `::1` (other hosts are refused in code). The request contains the phase, the intent, the authored line and a short list of allowed facts with event ids. The model may only propose wording; its output is parsed, must cite only the events it was given, and goes through strict validation (object words and numeric claims must match evidence). Any failure, timeout (2.5 s) or rejection falls back to the authored line. The model never controls state, timing or transitions.

## 7. The follower (`src/trail/Follower.ts`)

Pointer positions projected onto room surfaces are kept in a bounded history (900 points, at least 3.5 cm apart). Each point carries its surface id, and marks never bridge two surfaces.

| Stage | Behaviour |
|---|---|
| 1 | the player's own marks appear (fade over 5 s) |
| 2 | a second sequence replays the path 6.5 s behind (fade over 7.5 s) |
| 3 | delay 2.6 s, shrinking with each interaction (minimum 1.1 s); stops when the player stops |
| 4 | delay 1.4 s; may skip ahead on the same surface toward the predicted next target |

## 8. The presence (`src/entity/Entity.ts`)

An internal agent on an 8-node navigation graph (far hallway, hallway door, behind the curtain, under the desk, lamp corner, shelf corner, beside the mirror, table corner). It moves only between adjacent nodes that are both outside the player's view. Its objective (observe, approach, follow, withdraw) follows the Observer's awareness, suspicion and avoidance. Sounds can be placed at its position; it never has a visible model.

## 9. Endings (`src/endings/Endings.ts`)

In confrontation, once two confrontation events have happened, the Director opens the gateway whose ending affinity leads (with hysteresis so it does not flicker). After six minutes in confrontation all three open. Taking a gateway sends `BEGIN_ENDING` to the phase machine, which re-checks the guard.

* **Acknowledgment.** With its gateway open, sitting with the computer brings up "Can you see me?" with Yes and No on the in-room screen. After the answer, the room asks for the lamp to be switched, then "Again.", and responds to those deliberate actions ("Thank you for looking.") before the screen goes dark.
* **Refusal.** With its gateway open, clicking the door opens it fully and the view walks into the hallway. The fade returns the player to the starting room with the same instruction, except the photograph is now the version with one person gone. The end card follows after 18 s.
* **Reversal.** With its gateway open, the room takes over when the player stops for 15 s or when three predictions in a row are hits. Input locks, the room replays the player's own most recent actions (lamp, drawers, curtains, door handle, objects) with their sounds, and the view moves to the desk and turns toward where the player stood, where the figure now stands.

The end card summarises real session facts only: active minutes, number of interactions and the most inspected object.
