# Event and state schema

Every type below is defined in TypeScript in `src/`; this document mirrors those definitions. If they ever disagree, the source wins.

## Behavioral events

Defined in `src/telemetry/types.ts`. The telemetry log is bounded (600 retained events) while per-type and per-target counters persist for the whole session.

```ts
interface BehavioralEvent {
  id: number;                 // monotonic, unique within a session
  type: ActionType;
  target?: ObjectId;
  area?: AreaId;
  timestampMs: number;        // session-relative *active* time (pauses with the tab/menu)
  durationMs?: number;
  camera: { position: [number, number, number]; yaw: number; pitch: number };
  context: RoomContext;       // room state at the moment of the event
  meta: Record<string, string | number | boolean>;
  usedBy: string[];           // e.g. "narrative:photo_repeat", "director:drawer_ajar"
  used: boolean;
  snapshotId?: number;        // room snapshot stored alongside the event
}

interface RoomContext {
  lampOn: boolean; doorOpen: boolean; drawerOpen: boolean; curtainsOpen: boolean;
  chairState: string; photoVariant: string; phase: string;
}
```

An example of the shape (values illustrative):

```json
{
  "id": 14,
  "type": "object_inspected",
  "target": "photograph",
  "area": "photo_wall",
  "timestampMs": 184230,
  "durationMs": 6200,
  "camera": { "position": [-1.82, 1.55, 0.25], "yaw": 1.571, "pitch": 0 },
  "context": { "lampOn": true, "doorOpen": false, "drawerOpen": false, "curtainsOpen": true,
               "chairState": "original", "photoVariant": "original", "phase": "normalcy" },
  "meta": {},
  "usedBy": [],
  "used": false
}
```

### Action types

There is no event type for anything outside the rendered room. The list is closed:

`session_started`, `object_inspected`, `object_picked_up`, `object_placed`, `drawer_opened`, `drawer_closed`, `lamp_toggled`, `curtains_toggled`, `chair_moved`, `door_opened`, `door_closed`, `door_handle_tried`, `computer_note_opened`, `computer_answered`, `object_hesitated`, `area_glanced`, `area_avoided`, `anomaly_witnessed`, `anomaly_investigated`, `sound_reacted`, `prediction_resolved`, `message_read`, `player_idle`, `look_away_test`, `ending_started`

| Group | Types | Produced by |
|---|---|---|
| Deliberate actions | `object_inspected`, `object_picked_up`, `object_placed`, `drawer_opened`, `drawer_closed`, `lamp_toggled`, `curtains_toggled`, `chair_moved`, `door_opened`, `door_closed`, `door_handle_tried`, `computer_note_opened`, `computer_answered` | Interaction system |
| Derived signals | `object_hesitated` (pointer dwell ≥300 ms then click, or ≥900 ms then leave), `area_glanced`, `area_avoided` (avoidance ≥0.6), `sound_reacted`, `anomaly_witnessed` (changed object attended for 600 ms), `anomaly_investigated` (interaction within 30 s of witnessing), `message_read`, `player_idle` (12 s), `look_away_test` (two watch/away/return cycles within 45 s) | `GameCore` from attention samples |
| System | `session_started`, `prediction_resolved` (hit/miss/expired), `ending_started` | Core |

## Mutable objects and valid states

Defined in `src/world/objects.ts`. `WorldState.apply` rejects any state not in the list, any numeric value outside its range, chair positions that collide with furniture, and a slot that another object occupies.

| Object | Valid states | Initial | Ranges |
|---|---|---|---|
| `photograph` | `original`, `shifted`, `removed`, `gazing`, `room_now`, `room_past`, `room_figure`, `empty` | `{"state":"original","tilt":0}` | tilt [-0.12,0.12] |
| `chair` | `original`, `rotated_slight`, `crept`, `closer_desk`, `facing_wall`, `facing_player_prev`, `facing_player_now`, `player_moved` | `{"state":"original","x":-0.95,"z":-1.05,"yaw":3.141592653589793}` |  |
| `clock` | `normal`, `lost_seconds`, `stalled` | `{"state":"normal","offsetMs":0}` | offsetMs [-120000,0] |
| `lamp` | `on`, `off` | `{"state":"off","on":false}` |  |
| `drawer_top` | `closed`, `open`, `ajar` | `{"state":"closed","open":0,"contents":["photo_old","pen","keys"]}` | open [0,1] |
| `drawer_bottom` | `closed`, `open`, `ajar` | `{"state":"closed","open":0,"contents":["letters"]}` | open [0,1] |
| `door` | `closed`, `ajar`, `open`, `wide` | `{"state":"ajar","open":0.12,"handle":0}` | open [0,1]; handle [0,1] |
| `curtains` | `open`, `closed` | `{"state":"open","open":1}` | open [0,1] |
| `mirror` | `normal`, `lag`, `past_chair`, `distort`, `presence` | `{"state":"normal"}` |  |
| `figurine` | `shelved`, `moved`, `held`, `facing_camera` | `{"state":"shelved","slot":"s4_a","yaw":2.1707963267948966}` |  |
| `cup` | `shelved`, `moved`, `held` | `{"state":"shelved","slot":"table_a","yaw":0.4}` |  |
| `computer` | `desktop`, `message`, `surveillance`, `question`, `dark` | `{"state":"desktop"}` |  |
| `book_0` | `shelved`, `moved`, `held`, `in_drawer`, `ajar`, `returned_facing` | `{"state":"shelved","slot":"s3_a","tilt":0,"yaw":0}` | tilt [0,0.6] |
| `book_1` | `shelved`, `moved`, `held`, `in_drawer`, `ajar`, `returned_facing` | `{"state":"shelved","slot":"s3_b","tilt":0,"yaw":0}` | tilt [0,0.6] |
| `book_2` | `shelved`, `moved`, `held`, `in_drawer`, `ajar`, `returned_facing` | `{"state":"shelved","slot":"s3_c","tilt":0,"yaw":0}` | tilt [0,0.6] |
| `book_3` | `shelved`, `moved`, `held`, `in_drawer`, `ajar`, `returned_facing` | `{"state":"shelved","slot":"s2_a","tilt":0,"yaw":0}` | tilt [0,0.6] |
| `book_4` | `shelved`, `moved`, `held`, `in_drawer`, `ajar`, `returned_facing` | `{"state":"shelved","slot":"s2_b","tilt":0,"yaw":0}` | tilt [0,0.6] |
| `book_5` | `shelved`, `moved`, `held`, `in_drawer`, `ajar`, `returned_facing` | `{"state":"shelved","slot":"s1_a","tilt":0,"yaw":0}` | tilt [0,0.6] |

```ts
interface ObjectState {
  state: string;
  x?: number; z?: number; yaw?: number;      // chair (floor plane, metres / radians)
  open?: number;                              // drawers, door, curtains: 0..1
  on?: boolean;                               // lamp
  slot?: string;                              // books, figurine, cup (see SLOTS in src/core/layout.ts)
  offsetMs?: number;                          // clock
  tilt?: number; handle?: number;
  mode?: string;                              // photograph variant key
  contents?: string[];                        // drawers
  captureId?: number;                         // photograph backed by a render-target capture
}
```

### Mutation records

Every committed change is stored so it can be reversed, intensified or referenced later (`src/world/WorldState.ts`).

```ts
interface MutationRecord {
  id: number;
  objectId: ObjectId;
  from: ObjectState;
  to: ObjectState;
  source: 'player' | 'director' | 'ending' | 'restore';
  cause: string;          // anomaly id or interaction name; ":partial" suffix when an animation was frozen mid-way
  timestampMs: number;
  evidence: number[];     // telemetry event ids that justified it
}
```

Continuous changes (a chair being dragged, an anomaly animating) apply many intermediate states with `continuous: true` and then commit one record spanning the whole change.

### Claims

An anomaly must claim every object it will touch before it starts (`WorldState.claim`). A second anomaly cannot claim an object that is already claimed. The player always wins: grabbing a claimed object preempts the anomaly (`claimPreempted`), whose executor then freezes or reverts according to its contract.

## Anomaly definitions

Defined in `src/director/types.ts`; the catalogue is `src/director/anomalies.ts`.

```ts
interface AnomalyDef {
  id: string;
  description: string;
  group: string;                         // spacing between related events (minSinceGroups)
  phases: Phase[];
  significance: 'ambient' | 'subtle' | 'notable' | 'major';
  baseWeight: number;
  tension: number;                       // contribution to the Observer's tension
  cooldownMs: number;
  minSinceGroups?: Partial<Record<string, number>>;
  maxRepeats: number;
  visibility: VisibilityContract;
  sudden?: boolean;                      // skipped when sudden events are disabled
  anticipation?: boolean;                // evaluated on prediction updates
  requires?: (ctx) => number[] | null;   // behavioral evidence ids, or null when unmet
  prerequisite?: (ctx) => boolean;       // room-state prerequisite
  affinity?: (ctx) => number;            // Observer-driven weight multiplier
  plan: (ctx, evidence) => AnomalyPlan | null;
  followUps?: { id: string; delayMs: [number, number]; chance: number }[];
}

interface VisibilityContract {
  mode: 'unseen' | 'peripheral' | 'direct';   // the most visible the target may be while changing
  minUnseenMs: number;                         // how long it must have been out of sight first
  interruption: 'freeze' | 'revert' | 'continue';
  waitMs: number;                              // how long a scheduled event waits for its contract
}

type Step =
  | { op: 'set'; object; patch }
  | { op: 'animate'; object; to; durationMs; ease? }
  | { op: 'sound'; sound; at; gain?; rate? }
  | { op: 'effect'; name; params? }
  | { op: 'message'; templateId; intent; text; refs; facts; callback? }
  | { op: 'wait'; ms }
  | { op: 'until'; cond; timeoutMs }
  | { op: 'call'; fn };
```

## Narrative messages

```ts
interface ObserverMessage {
  templateId: string;
  intent: 'observation' | 'count' | 'testing' | 'direct' | 'prediction' | 'callback' | 'ending';
  text: string;
  refs: number[];                  // event ids the statement is based on (validated)
  facts: Record<string, string | number>;
  source: 'template' | 'llm';
  createdAt: number;
}
```

## Saved session (`localStorage['wiwy.session.v1']`)

Written only when the player chooses **Save and leave**. `GameCore.snapshot()`:

```ts
{
  v: 1,
  seed: number,
  rngState: number,
  clock: number,                 // active session ms
  telemetry: { events, counters, nextId },
  world: { objects: [ObjectId, ObjectState][], t },
  observer: { state, interest, areaAttentionMs, predictor weights and transitions, ... },
  narrative: { shown, callbacks },
  director: { phase, enteredAt, history, followerStage, confrontationEvents, ... },
  settings: { suddenEvents, reducedMotion }
}
```

Settings are stored separately in `localStorage['wiwy.settings.v1']`: `volume`, `muted`, `reducedMotion`, `suddenEvents`, `quality`, `localModel`, `localModelEndpoint`, `localModelName`. **Reset session data** removes both keys.
