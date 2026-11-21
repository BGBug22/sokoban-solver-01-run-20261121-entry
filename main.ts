// Room-split push-optimal Sokoban solver.
//
// How it works, in short: every level the generator draws is a hallway with
// one to four small rooms off it, and a box pushed out of a room can never come
// back, so each room is its own puzzle and the level optimum is the sum of the
// rooms' optima. This program finds the rooms, solves each one with the fewest
// pushes possible, and stitches the walks between rooms together.
//
// Per room the search runs over pushes, not steps: a state is the boxes'
// squares plus the region the player can reach on foot, and expanding states
// in first-found order makes the first solved state push-optimal. Two prunings
// keep the search small without ever cutting a solvable state: a square a box
// can never be pulled back from to any goal (a dead square), and a frozen
// 2x2 block of walls and boxes holding a box off its goal. The walk between
// two pushes is the shortest path on foot, found by breadth-first search.
//
// Everything is budgeted by work, never by the clock, so two runs on the same
// set write byte-identical answers: no time reads, no randomness anywhere.
//
// Local run: mkdir -p out && MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const IN_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** States one room search may keep before it gives up (work, not time). */
const ROOM_STATE_CAP = 400_000;
/** States a whole-level fallback search may keep. */
const LEVEL_STATE_CAP = 400_000;
/** States the move-space A* fallback may expand. */
const ASTAR_CAP = 200_000;

/** The four steps: dx, dy, walk letter, push letter. */
const STEPS = [
  [0, -1, 'u', 'U'],
  [0, 1, 'd', 'D'],
  [-1, 0, 'l', 'L'],
  [1, 0, 'r', 'R'],
] as const;

type Board = {
  w: number;
  h: number;
  wall: Uint8Array;
  goals: number[];
  boxes: number[];
  player: number;
};

/** A level in XSB text into its board. Short rows and the outer frame count as wall. */
function parseLevel(text: string): Board {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goals: number[] = [];
  const boxes: number[] = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x]!;
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) wall[y * w + x] = 1;
    }
  }
  return { w, h, wall, goals, boxes: boxes.sort((a, b) => a - b), player };
}

/**
 * The squares a box can sit on and still reach a goal: pull a box backwards
 * from each goal, one square at a time, over open floor only. A box anywhere
 * else can never be solved, so it is dead.
 */
function liveSquares(b: Board): Uint8Array {
  const live = new Uint8Array(b.w * b.h);
  const queue = [...b.goals];
  for (const g of b.goals) live[g] = 1;
  for (let qi = 0; qi < queue.length; qi++) {
    const x = queue[qi]!;
    for (const [dx, dy] of STEPS) {
      const d = dy * b.w + dx;
      const y = x - d;
      if (!b.wall[y] && !b.wall[y - d] && !live[y]) {
        live[y] = 1;
        queue.push(y);
      }
    }
  }
  return live;
}

/**
 * The lowest square of the region the player reaches on foot from `from`,
 * with `blocked` in the way. Marks the region in `seen` under `stamp`.
 */
function regionLow(
  b: Board,
  blocked: Uint8Array,
  from: number,
  seen: Int32Array,
  stamp: number,
  stack: Int32Array,
): number {
  let low = from;
  let n = 0;
  stack[n++] = from;
  seen[from] = stamp;
  while (n > 0) {
    const p = stack[--n]!;
    if (p < low) low = p;
    for (let k = 0; k < 4; k++) {
      const q = k === 0 ? p - b.w : k === 1 ? p + b.w : k === 2 ? p - 1 : p + 1;
      if (b.wall[q] === 0 && blocked[q] === 0 && seen[q] !== stamp) {
        seen[q] = stamp;
        stack[n++] = q;
      }
    }
  }
  return low;
}

/**
 * Whether the box just pushed onto `t` is caught in a frozen 2x2 block: four
 * squares of walls and boxes, at least one of them a box off its goal. Such a
 * box can never move again, so the state is dead.
 */
function inFrozenBlock(b: Board, blocked: Uint8Array, goal: Uint8Array, t: number): boolean {
  const { w, wall } = b;
  for (const a of [t, t - 1, t - w, t - w - 1]) {
    const c = a + 1;
    const d = a + w;
    const e = d + 1;
    if (!(wall[a] || blocked[a]) || !(wall[c] || blocked[c]) || !(wall[d] || blocked[d]) || !(wall[e] || blocked[e])) continue;
    if ((blocked[a] && !goal[a]) || (blocked[c] && !goal[c]) || (blocked[d] && !goal[d]) || (blocked[e] && !goal[e])) return true;
  }
  return false;
}

/** A state's key: its region's lowest square, then its boxes' squares. */
function stateKey(boxes: number[], low: number): string {
  return `${low}|${boxes.join(',')}`;
}

/** The shortest walk from `from` to `to` around walls and boxes, lower-case letters. */
function walkPath(b: Board, blocked: Uint8Array, from: number, to: number): string {
  if (from === to) return '';
  const prev = new Int32Array(b.w * b.h).fill(-1);
  const how = new Array<string>(b.w * b.h);
  const queue = [from];
  prev[from] = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi]!;
    if (p === to) break;
    for (const [dx, dy, letter] of STEPS) {
      const q = p + dy * b.w + dx;
      if (b.wall[q] || blocked[q] || prev[q] !== -1) continue;
      prev[q] = p;
      how[q] = letter;
      queue.push(q);
    }
  }
  if (prev[to] === -1) throw new Error('walk target out of reach');
  let s = '';
  for (let p = to; p !== from; p = prev[p]!) s = how[p]! + s;
  return s;
}

/** Where the player ends up after walking `moves` (case aside) from `from`. */
function endSquare(w: number, from: number, moves: string): number {
  let p = from;
  for (const ch of moves.toLowerCase()) p += ch === 'u' ? -w : ch === 'd' ? w : ch === 'l' ? -1 : 1;
  return p;
}

/**
 * The push-optimal answer for one board, or null when the search gives up.
 * Breadth-first over pushes: states are kept in first-found order, so the
 * first solved state met is optimal. Returns the moves (lower-case walks,
 * upper-case pushes) and the push count.
 */
function solvePushes(b: Board, cap: number): { moves: string; pushes: number } | null {
  const size = b.w * b.h;
  const goal = new Uint8Array(size);
  for (const g of b.goals) goal[g] = 1;
  const live = liveSquares(b);
  const blocked = new Uint8Array(size);
  const seen = new Int32Array(size);
  const mark = new Int32Array(size);
  const stack = new Int32Array(size);
  let stamp = 0;
  const allSolved = (bs: number[]): boolean => bs.every((x) => goal[x]);
  if (b.boxes.some((x) => !live[x])) return null;

  const boxStates: number[][] = [b.boxes.slice()];
  const playerStates: number[] = [b.player];
  const parent: number[] = [-1];
  const pushCode: number[] = [0];
  const known = new Map<string, number>();
  for (const x of b.boxes) blocked[x] = 1;
  const low0 = regionLow(b, blocked, b.player, seen, ++stamp, stack);
  known.set(stateKey(b.boxes, low0), 0);
  for (const x of b.boxes) blocked[x] = 0;

  let found = allSolved(b.boxes) ? 0 : -1;
  for (let head = 0; found < 0 && head < boxStates.length; head++) {
    const boxes = boxStates[head]!;
    for (const x of boxes) blocked[x] = 1;
    const here = ++stamp;
    regionLow(b, blocked, playerStates[head]!, seen, here, stack);
    for (let bi = 0; bi < boxes.length && found < 0; bi++) {
      const box = boxes[bi]!;
      for (const [dx, dy] of STEPS) {
        const d = dy * b.w + dx;
        const t = box + d;
        if (seen[box - d] !== here || b.wall[t] || blocked[t] || !live[t]) continue;
        blocked[box] = 0;
        blocked[t] = 1;
        const frozen = inFrozenBlock(b, blocked, goal, t);
        let next: number[] | null = null;
        let key = '';
        if (!frozen) {
          next = boxes.slice();
          next[bi] = t;
          next.sort((x, y) => x - y);
          key = stateKey(next, regionLow(b, blocked, box, mark, ++stamp, stack));
        }
        blocked[t] = 0;
        blocked[box] = 1;
        if (frozen || next === null || known.has(key)) continue;
        if (boxStates.length >= cap) {
          for (const x of boxes) blocked[x] = 0;
          return null;
        }
        known.set(key, boxStates.length);
        boxStates.push(next);
        playerStates.push(box);
        parent.push(head);
        pushCode.push(box * size + t);
        if (allSolved(next)) {
          found = boxStates.length - 1;
          break;
        }
      }
    }
    for (const x of boxes) blocked[x] = 0;
  }
  if (found < 0) return null;

  // Walk the parent chain back, then replay it forwards: walk to each push's
  // square, then push.
  const chain: number[] = [];
  for (let s = found; s > 0; s = parent[s]!) chain.push(s);
  chain.reverse();
  let moves = '';
  let player = b.player;
  let boxes = b.boxes;
  for (const s of chain) {
    const nextBoxes = boxStates[s]!;
    const code = pushCode[s]!;
    const from = Math.floor(code / size);
    const to = code % size;
    const d = to - from;
    const dir = STEPS.find(([dx, dy]) => dy * b.w + dx === d)!;
    for (const x of boxes) blocked[x] = 1;
    moves += walkPath(b, blocked, player, from - d);
    for (const x of boxes) blocked[x] = 0;
    moves += dir[3];
    player = from;
    boxes = nextBoxes;
  }
  return { moves, pushes: chain.length };
}

type Room = { cells: number[]; boxes: number[]; goals: number[] };

/**
 * The level's rooms: cut the hallway row's dead squares out of the floor (a
 * box there reaches no goal, so it is hallway, not room), and each connected
 * part left that holds a box is a room. Null when the level is no set of
 * rooms: a box in the cut, a goal left outside every part, or a room whose
 * boxes and goals do not match.
 */
function splitRooms(level: Board): Room[] | null {
  const { w, wall, goals, boxes, player } = level;
  const live = liveSquares(level);
  const row = Math.floor(player / w);
  const cut = new Uint8Array(wall.length);
  for (let i = row * w; i < (row + 1) * w; i++) {
    if (!wall[i] && !live[i]) cut[i] = 1;
  }
  if (boxes.some((x) => cut[x])) return null;
  const part = new Int32Array(wall.length).fill(-1);
  const rooms: Room[] = [];
  for (let s = 0; s < wall.length; s++) {
    if (wall[s] || cut[s] || part[s] >= 0) continue;
    const cells = [s];
    part[s] = rooms.length;
    for (let i = 0; i < cells.length; i++) {
      for (const [dx, dy] of STEPS) {
        const q = cells[i]! + dy * w + dx;
        if (!wall[q] && !cut[q] && part[q] < 0) {
          part[q] = rooms.length;
          cells.push(q);
        }
      }
    }
    rooms.push({ cells, boxes: [], goals: [] });
  }
  for (const x of boxes) rooms[part[x]!]!.boxes.push(x);
  for (const g of goals) {
    if (part[g]! >= 0) rooms[part[g]!]!.goals.push(g);
  }
  if (goals.some((g) => part[g]! < 0)) return null;
  if (rooms.some((r) => r.boxes.length !== r.goals.length)) return null;
  return rooms.filter((r) => r.boxes.length > 0);
}

/**
 * A plain move-space A* over the whole level, the last resort when the room
 * split or the push search gives up: fewest moves, which is not always the
 * fewest pushes, but a solved level beats an unsolved one.
 */
function solveAStar(level: Board): string | null {
  const { w, wall, goals } = level;
  const dist = (cell: number): number =>
    Math.min(...goals.map((g) => Math.abs((g % w) - (cell % w)) + Math.abs(Math.floor(g / w) - Math.floor(cell / w))));
  const estimate = (bs: number[]): number => bs.reduce((a, x) => a + dist(x), 0);
  const keyOf = (p: number, bs: number[]): string => `${p}|${bs.join(',')}`;
  const players: number[] = [level.player];
  const boxList: number[][] = [level.boxes.slice()];
  const costs: number[] = [0];
  const parent: number[] = [-1];
  const step: string[] = [''];
  const best = new Map<string, number>([[keyOf(level.player, level.boxes), 0]]);
  const heap: [number, number, number][] = [[estimate(level.boxes), 0, 0]];
  const less = (a: [number, number, number], c: [number, number, number]): boolean =>
    a[0] < c[0] || (a[0] === c[0] && (a[1] > c[1] || (a[1] === c[1] && a[2] < c[2])));
  const heapPush = (e: [number, number, number]): void => {
    let i = heap.length;
    heap.push(e);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!less(heap[i]!, heap[p]!)) break;
      [heap[i], heap[p]] = [heap[p]!, heap[i]!];
      i = p;
    }
  };
  const heapPop = (): [number, number, number] => {
    const top = heap[0]!;
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      for (let i = 0; ; ) {
        let c = 2 * i + 1;
        if (c >= heap.length) break;
        if (c + 1 < heap.length && less(heap[c + 1]!, heap[c]!)) c++;
        if (!less(heap[c]!, heap[i]!)) break;
        [heap[i], heap[c]] = [heap[c]!, heap[i]!];
        i = c;
      }
    }
    return top;
  };
  let expanded = 0;
  while (heap.length > 0 && expanded < ASTAR_CAP) {
    const [, g, s] = heapPop();
    if (best.get(keyOf(players[s]!, boxList[s]!)) !== s) continue;
    const bs = boxList[s]!;
    if (bs.every((x) => goals.includes(x))) {
      let moves = '';
      for (let t = s; t > 0; t = parent[t]!) moves = step[t]! + moves;
      return moves;
    }
    expanded++;
    const p = players[s]!;
    for (const [dx, dy, letter] of STEPS) {
      const d = dy * w + dx;
      const q = p + d;
      if (wall[q]) continue;
      let nb = bs;
      let move = letter;
      const at = bs.indexOf(q);
      if (at >= 0) {
        if (wall[q + d] || bs.includes(q + d)) continue;
        nb = bs.slice();
        nb[at] = q + d;
        nb.sort((a, b) => a - b);
        move = letter.toUpperCase();
      }
      const k = keyOf(q, nb);
      const seenAt = best.get(k);
      if (seenAt !== undefined && costs[seenAt]! <= g + 1) continue;
      const t = players.length;
      players.push(q);
      boxList.push(nb);
      costs.push(g + 1);
      parent.push(s);
      step.push(move);
      best.set(k, t);
      heapPush([g + 1 + estimate(nb), g + 1, t]);
    }
  }
  return null;
}

/** The moves solving one level: room by room, with whole-level fallbacks. */
function solveLevel(text: string): string {
  const level = parseLevel(text);
  const rooms = splitRooms(level);
  if (rooms !== null) {
    let moves = '';
    let player = level.player;
    let ok = true;
    // Each room's boxes where they stand now: still at their start until the
    // room is solved, on their goals after. The other rooms' boxes stand as
    // walls while this room is solved, but their floors stay walkable, so the
    // player can always walk out of the room it just finished.
    const standing = rooms.map((r) => r.boxes.slice());
    for (let ri = 0; ri < rooms.length; ri++) {
      const room = rooms[ri]!;
      const wall = level.wall.slice();
      for (let rj = 0; rj < rooms.length; rj++) {
        if (rj === ri) continue;
        for (const x of standing[rj]!) wall[x] = 1;
      }
      const sub: Board = {
        w: level.w,
        h: level.h,
        wall,
        goals: room.goals.slice().sort((a, b) => a - b),
        boxes: room.boxes.slice().sort((a, b) => a - b),
        player,
      };
      const solved = solvePushes(sub, ROOM_STATE_CAP);
      if (solved === null) {
        ok = false;
        break;
      }
      moves += solved.moves;
      player = endSquare(level.w, player, solved.moves);
      standing[ri] = room.goals.slice();
    }
    if (ok) return moves;
  }
  const whole = solvePushes(level, LEVEL_STATE_CAP);
  if (whole !== null) return whole.moves;
  return solveAStar(level) ?? '';
}

for (const id of readdirSync(IN_DIR).sort()) {
  const moves = solveLevel(readFileSync(join(IN_DIR, id, 'level.txt'), 'utf8'));
  mkdirSync(join(OUT_DIR, id), { recursive: true });
  writeFileSync(join(OUT_DIR, id, 'solution.txt'), `${moves}\n`);
}
