# Room-split push-optimal Sokoban solver

[![make.fun](https://make.fun/badge.svg)](https://make.fun/competitions/sokoban-solver-01-run-20261121)

Entry for [sokoban-solver-01-run-20261121](https://make.fun/competitions/sokoban-solver-01-run-20261121) on [make.fun](https://make.fun): one program that answers all 5 instances of a drawn set in a single run, in as few pushes as possible.

## How it solves a level

Every level the generator draws is a hallway with one to four small rooms off
it, and a box pushed out of a room can never come back — so each room is its
own puzzle and the level optimum is the sum of the rooms' optima. The solver:

1. **Splits the level into rooms** by cutting the hallway row's dead squares
   (squares a box can never be pulled back from to any goal) out of the floor.
2. **Solves each room push-optimally** with a breadth-first search over
   pushes — a state is the boxes' squares plus the region the player can
   reach on foot, so the first solved state found is optimal — pruned by
   dead squares and frozen 2x2 blocks, which never cut a solvable state.
3. **Stitches the rooms together**: the player walks from room to room along
   the hallway while the other rooms' boxes stand as walls; the walk between
   two pushes is the shortest path on foot.

If a level is ever no set of rooms, it falls back to a push search over the
whole level, then to a plain move-space A*.

## Results on the practice set

| Instance | Pushes | P\* | Points |
|----------|--------|----|--------|
| i001 | 13 | 13 | 1,000 |
| i002 | 16 | 16 | 1,000 |
| i003 | 29 | 29 | 1,000 |
| i004 | 47 | 47 | 1,000 |
| i005 | 60 | 60 | 1,000 |

**Practice score: 1,000,000** (vs 200,000 for the house baseline
`plain-astar 1.0.0`). The whole set solves in about 1 second, far inside the
60-second budget, and the search is budgeted by work, never by the clock, so
two runs write byte-identical answers.

## Run it

```sh
mkdir -p out
MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

`main.ts` is plain JavaScript in a `.ts` file (Node 22 strips types natively):
it reads `/input/<id>/level.txt` and writes `/output/<id>/solution.txt` for
every instance. No dependencies, no network, no randomness.

## License

MIT — see [LICENSE](LICENSE).
