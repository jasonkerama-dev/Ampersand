# Ampersand

A deterministic, graph-based programming language with a memory arena, WORM (Write-Once Read-Many) immutable semantics, and a zero-allocation lifecycle engine. Built as a visual programming environment with an infinite canvas IDE and a C++ compiler backend.

> **Current status:** v0.7 — Turing complete via MUX + indexed memory access (LOAD/STORE). Self-hosting is the next milestone.

---

## Architecture

### Memory Arena

On startup, the engine reserves a contiguous OS block (default 8 MB) partitioned into three regions:

| Region   | Purpose                          | Management                    |
| -------- | -------------------------------- | ----------------------------- |
| Immutable | WORM constants                   | Allocated once at startup     |
| Variable  | Dynamic data per lifecycle cycle | Reset every cycle             |
| Function  | Operator node state              | Persistent for program life   |

No heap allocation occurs after the initial OS reservation. All memory is deterministic and bounded.

### Immutable Dictionary (WORM)

Every immutable starts as `UNINITIALIZED`. The first write streams data in and flips the flag to `INITIALIZED`. Any subsequent write attempt throws a `LAW 2 violation` — immutables are locked forever.

### Lifecycle Engine

Execution is a bounded iterative dataflow:

1. Graph is topologically sorted from the `entry` node
2. Each cycle: variable arena resets, all nodes evaluate in topological order
3. Function outputs carry into the next cycle via a carry map
4. Termination: any node with `end: true` receiving a nonzero value

### Memory Laws

The compiler enforces seven laws at runtime:

| Law | Name        | Description                                          |
| --- | ----------- | ---------------------------------------------------- |
| 1   | BOUNDS      | Every memory access checks region capacity           |
| 2   | WORM        | Immutables write-once, read-many                     |
| 3   | STATE       | All nodes have defined initialization                |
| 4   | PORT        | Multi-input ops (MUX/LOAD/STORE) require exact arity |
| 5   | OVERFLOW    | Division/modulo by zero is caught                    |
| 6   | TERMINATION | Lifecycle must end via an end node                   |
| 7   | ARENA       | Single OS reservation, no heap after init            |

### Turing Completeness

| Op      | Description                      |
| ------- | -------------------------------- |
| add/sub/mul/div/mod | Arithmetic |
| lt/gt/eq/neq | Comparison |
| mux     | Ternary select: `cond ? a : b`   |
| load    | Indexed read from variable arena |
| store   | Indexed write to variable arena  |

MUX + indexed arena access is sufficient to simulate a two-counter Minsky machine, making the engine Turing complete.

## .adg Language

Ampersand programs are written as DataGraph (`.adg`) files:

```
graph fibonacci;

setting memory: 8192;
setting immutable_pct: 3;
setting max_cycles: 5000;

node entry       entry;
node result      result  { end: true };

node immutable   one     { value: "1" };
node immutable   five    { value: "5" };

node variable    n;
node variable    acc;
node variable    done_flag;

node function    sub1    { op: sub, mem: 1 };
node function    mul_acc { op: mul, mem: 1 };
node function    check   { op: eq, mem: 1 };
node function    mux_n   { op: mux, mem: 1 };
node function    mux_acc { op: mux, mem: 1 };

edge five   -> n;
edge one    -> acc;
edge n      -> sub1;
edge one    -> sub1;
edge acc    -> mul_acc;
edge n      -> mul_acc;
edge n      -> check;
edge one    -> check;
edge check  -> done_flag;
edge done_flag -> mux_n;
edge n         -> mux_n;
edge sub1      -> mux_n;
edge mux_n     -> n;
edge done_flag -> mux_acc;
edge acc       -> mux_acc;
edge mul_acc   -> mux_acc;
edge mux_acc   -> acc;
edge done_flag -> result;
```

## Quick Start

### Prerequisites

- C++17 compiler (GCC, Clang, or MSVC)
- PHP 8.2+ with Composer (for the web IDE)
- Node.js 18+ (for frontend assets)

### Compiler

```bash
cd compiler
g++ -std=c++17 -O2 -o ampersand.exe main.cpp
./ampersand.exe compile test.adg
./ampersand.exe compile test.adg --json
./ampersand.exe compile test.adg --cycles 10 --dump
```

### Web IDE

```bash
cp .env.example .env
php artisan key:generate
composer install
npm install
php artisan migrate
php artisan serve
```

Open `http://localhost:8000` in a browser.

### Keybindings

| Key              | Action                        |
| ---------------- | ----------------------------- |
| Click            | Select node                   |
| Ctrl + Click     | Drag node                     |
| Ctrl + S         | Save to database              |
| Ctrl + Shift + S | Save current graph as `.adg`  |
| Ctrl + Enter     | Compile current graph         |
| Ctrl + F         | Search canvas                 |
| Delete           | Delete selected node/edge     |

## Project Structure

```
compiler/
  main.cpp        # C++ compiler (v0.7)
  test.adg        # Basic test: count 2→10
  test_fact.adg   # 5! = 120 via MUX
  net_income.adg  # Tax calculator demo

app/
  Http/Controllers/CanvasController.php  # API endpoints
  Models/           # Eloquent models: Project, FnNode, Variable, Immutable, Connection

resources/views/canvas.blade.php  # Main SPA view
public/
  canvas.js        # Canvas application (~1900 lines)
  styles.css       # Application styles

routes/web.php     # Web + API routes
database/migrations/  # SQL schema
```

## Roadmap

- [x] Memory arena with OS reservation
- [x] WORM immutable semantics
- [x] Bounded lifecycle engine
- [x] MUX, LOAD, STORE ops (Turing complete)
- [x] Web IDE with infinite canvas
- [x] File-based graph save/load
- [ ] Self-hosting compiler (Ampersand compiler written in Ampersand)
- [ ] Standard library as compressed library nodes
- [ ] LLVM or WASM codegen backend

## License

Apache-2.0 license
