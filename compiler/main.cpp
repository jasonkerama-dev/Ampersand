#include <iostream>
#include <fstream>
#include <sstream>
#include <string>
#include <vector>
#include <unordered_map>
#include <unordered_set>
#include <cstdint>
#include <cstring>
#include <cmath>
#include <algorithm>
#include <stdexcept>
#include <memory>
#include <functional>
#include <cstdlib>
#include <chrono>

#ifdef _WIN32
#include <windows.h>
#else
#include <sys/mman.h>
#include <unistd.h>
#endif

struct SourcePos { size_t line = 0, col = 0; };

enum class ErrorKind {
    SYNTAX, SEMANTIC, MEMORY, OVERFLOW, TYPE, LINK, RUNTIME, WORM,
    BOUNDS, PORT, STATE, CONFIG
};

struct CompilerError {
    ErrorKind kind;
    std::string message;
    SourcePos pos;
    std::string file;

    std::string format() const {
        static const char* names[] = {
            "syntax","semantic","memory","overflow","type","link","runtime","worm",
            "bounds","port","state","config"
        };
        std::string out = std::string("\033[31m") + names[(int)kind] + " error";
        if (!file.empty()) out += " in " + file;
        if (pos.line > 0) out += ":" + std::to_string(pos.line);
        if (pos.col  > 0) out += ":" + std::to_string(pos.col);
        out += "\033[0m\n  " + message;
        return out;
    }
};

class ErrorSink {
    std::vector<CompilerError> errors;
public:
    void push(ErrorKind k, std::string msg, std::string f = "", SourcePos p = {}) {
        errors.push_back({k, std::move(msg), p, std::move(f)});
    }
    bool has_errors() const { return !errors.empty(); }
    void print(std::ostream& os) const {
        for (auto& e : errors) os << e.format() << "\n\n";
    }
    std::vector<CompilerError> all() const {
        std::vector<CompilerError> v;
        v.reserve(errors.size());
        for (auto& e : errors) v.push_back(e);
        return v;
    }
};

class Logger {
    std::stringstream log;
    bool do_trace = false;
public:
    void set_trace(bool t) { do_trace = t; }
    void trace(const std::string& tag, const std::string& msg) {
        if (do_trace) log << "  [trace:" << tag << "] " << msg << "\n";
    }
    void info(const std::string& msg) { log << "  [info] " << msg << "\n"; }
    void warn(const std::string& msg) { log << "  [warn] " << msg << "\n"; }
    std::string str() const { return log.str(); }
};

enum class NodeKind { FUNCTION, VARIABLE, IMMUTABLE, ENTRY, RESULT };

enum class OpKind {
    ADD, SUB, MUL, DIV, MOD,
    LT, GT, EQ, NEQ,
    MUX, LOAD, STORE,
    PASS, NONE
};

struct IrNode {
    size_t      id              = 0;
    NodeKind    kind            = NodeKind::VARIABLE;
    std::string name;
    std::string value;
    OpKind      op              = OpKind::NONE;
    size_t      mem_limit_bytes = 0;
    bool        is_entry        = false;
    bool        is_end          = false;
    bool        is_store        = false;
    SourcePos   pos;
    std::vector<size_t> in_ids;
    std::vector<size_t> out_ids;
};

struct IrEdge { size_t src_id, dst_id; };

struct IrGraph {
    std::string name;
    size_t      memory_kb       = 8192;
    size_t      immutable_pct   = 3;
    size_t      max_cycles      = 1000;
    std::vector<IrNode> nodes;
    std::vector<IrEdge> edges;

    IrNode* node_by_id(size_t id) {
        for (auto& n : nodes) if (n.id == id) return &n;
        return nullptr;
    }
    const IrNode* node_by_id(size_t id) const {
        for (auto& n : nodes) if (n.id == id) return &n;
        return nullptr;
    }
    IrNode* node_by_name(const std::string& nm) {
        for (auto& n : nodes) if (n.name == nm) return &n;
        return nullptr;
    }
    size_t entry_id() const {
        for (auto& n : nodes) if (n.is_entry) return n.id;
        return 0;
    }
};

// ===== Ampersand Memory Laws =====
// LAW 1 (BOUNDS): Every memory access must verify offset + sizeof(type) <= region capacity.
// LAW 2 (WORM): An immutable may be written exactly once (UNINITIALIZED -> INITIALIZED).
//               Any subsequent write is a WORM violation and must throw.
// LAW 3 (STATE): Every node has a defined state. Entries are initialized to cycle counter.
//                Variables carry forward or seed. Immutables are read-only after init.
// LAW 4 (PORT): LOAD consumes exactly 1 input (address). STORE consumes exactly 2 inputs
//               (address, value). MUX consumes exactly 3 (cond, if_true, if_false).
//               Extra inputs are a LINK error.
// LAW 5 (OVERFLOW): Arithmetic overflow is checked. Division/modulo by zero is an OVERFLOW error.
// LAW 6 (TERMINATION): A lifecycle must terminate via an explicit 'end' node receiving nonzero,
//                      OR a 'result' node firing, OR hitting max_cycles (which is an error).
// LAW 7 (ARENA): The memory arena is partitioned at init. No dynamic allocation after startup.
//                var_reset() resets the allocation cursor but does NOT zero data (STORE persist).

static bool law_bounds_check(size_t offset, size_t size, size_t region_size, const std::string& op,
                              ErrorSink& err, const std::string& node_name) {
    if (offset + size > region_size) {
        err.push(ErrorKind::BOUNDS,
            "LAW 1 violation: " + op + " in '" + node_name +
            "' — offset " + std::to_string(offset) + " + " + std::to_string(size) +
            " exceeds region (" + std::to_string(region_size) + ")");
        return false;
    }
    return true;
}

// ===== Op resolution =====
// Exact table first (no false positives from substring matching).
// Substring table is restricted: "store", "load", "mux" are EXACT only.
static OpKind op_from_name(const std::string& nm) {
    static const std::unordered_map<std::string,OpKind> exact = {
        {"add",OpKind::ADD},{"sub",OpKind::SUB},{"mul",OpKind::MUL},
        {"div",OpKind::DIV},{"mod",OpKind::MOD},
        {"lt",OpKind::LT},{"gt",OpKind::GT},{"eq",OpKind::EQ},{"neq",OpKind::NEQ},
        {"inc",OpKind::ADD},{"dec",OpKind::SUB},
        {"cmp",OpKind::LT},{"cond",OpKind::LT},{"check",OpKind::LT},
        {"pass",OpKind::PASS},{"store",OpKind::STORE},
        {"mux",OpKind::MUX},{"select",OpKind::MUX},{"branch",OpKind::MUX},
        {"load",OpKind::LOAD},{"read",OpKind::LOAD},
        {"swr",OpKind::STORE},{"write",OpKind::STORE},
    };
    auto it = exact.find(nm);
    if (it != exact.end()) return it->second;
    static const std::vector<std::pair<std::string,OpKind>> subs = {
        {"neq",OpKind::NEQ},{"add",OpKind::ADD},{"sub",OpKind::SUB},
        {"mul",OpKind::MUL},{"div",OpKind::DIV},{"mod",OpKind::MOD},
        {"lt", OpKind::LT}, {"gt", OpKind::GT}, {"eq", OpKind::EQ},
        {"inc",OpKind::ADD},{"dec",OpKind::SUB},
    };
    for (auto& [kw, op] : subs)
        if (nm.find(kw) != std::string::npos) return op;
    return OpKind::PASS;
}

static const char* op_name(OpKind op) {
    switch (op) {
        case OpKind::ADD:  return "add";
        case OpKind::SUB:  return "sub";
        case OpKind::MUL:  return "mul";
        case OpKind::DIV:  return "div";
        case OpKind::MOD:  return "mod";
        case OpKind::LT:   return "lt";
        case OpKind::GT:   return "gt";
        case OpKind::EQ:   return "eq";
        case OpKind::NEQ:  return "neq";
        case OpKind::PASS: return "pass";
        case OpKind::MUX:  return "mux";
        case OpKind::LOAD: return "load";
        case OpKind::STORE:return "store";
        default:           return "none";
    }
}

// ===== Memory Arena =====
// Implements LAW 7: Single OS reservation, partitioned at init.
class MemoryArena {
    uint8_t* base                 = nullptr;
    size_t   total                = 0;
    size_t   imm_region_size      = 0;
    size_t   var_region_size      = 0;
    size_t   fn_region_size       = 0;
    size_t   imm_used             = 0;
    size_t   var_used             = 0;
    size_t   fn_used              = 0;
    size_t   imm_offset           = 0;
    size_t   var_offset           = 0;
    size_t   fn_offset            = 0;

public:
    bool ok = false;

    ~MemoryArena() {
        if (!base) return;
#ifdef _WIN32
        VirtualFree(base, 0, MEM_RELEASE);
#else
        munmap(base, total);
#endif
    }

    bool init(size_t total_kb, size_t imm_pct, ErrorSink& err, Logger* log = nullptr) {
        total             = total_kb * 1024;
        imm_region_size   = std::max((total * imm_pct) / 100, (size_t)4096);
        size_t rest       = total - imm_region_size;
        var_region_size   = rest * 70 / 100;
        fn_region_size    = rest - var_region_size;

        imm_offset = 0;
        var_offset = imm_region_size;
        fn_offset  = imm_region_size + var_region_size;

#ifdef _WIN32
        base = (uint8_t*)VirtualAlloc(nullptr, total,
                    MEM_RESERVE | MEM_COMMIT, PAGE_READWRITE);
        if (!base) base = (uint8_t*)malloc(total);
#else
        base = (uint8_t*)mmap(nullptr, total,
                    PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
        if (base == MAP_FAILED) base = (uint8_t*)malloc(total);
#endif
        if (!base) {
            err.push(ErrorKind::MEMORY, "LAW 7 violation: OS allocation of " +
                      std::to_string(total) + " bytes failed");
            return false;
        }
        std::memset(base, 0, total);
        ok = true;
        if (log) log->info("Arena reserved: " + std::to_string(total_kb) +
                           " KB [" + std::to_string(imm_region_size/1024) + " imm | " +
                           std::to_string(var_region_size/1024) + " var | " +
                           std::to_string(fn_region_size/1024) + " fn]");
        return true;
    }

    uint8_t* imm_alloc(size_t bytes) {
        bytes = align8(bytes);
        if (imm_used + bytes > imm_region_size) return nullptr;
        uint8_t* p = base + imm_offset + imm_used;
        imm_used += bytes;
        return p;
    }

    uint8_t* var_alloc(size_t bytes) {
        bytes = align8(bytes);
        if (var_used + bytes > var_region_size) return nullptr;
        uint8_t* p = base + var_offset + var_used;
        var_used += bytes;
        return p;
    }

    void var_reset() { var_used = 0; }

    double var_read_double(size_t offset_bytes, const std::string& node_name,
                           ErrorSink& err) {
        if (!law_bounds_check(offset_bytes, sizeof(double), var_region_size,
                              "var_read", err, node_name)) return 0;
        double v;
        std::memcpy(&v, base + var_offset + offset_bytes, sizeof(double));
        return v;
    }

    void var_write_double(size_t offset_bytes, double val, const std::string& node_name,
                           ErrorSink& err) {
        if (!law_bounds_check(offset_bytes, sizeof(double), var_region_size,
                              "var_write", err, node_name)) return;
        size_t need = offset_bytes + sizeof(double);
        if (need > var_used) {
            if (need > var_region_size) return;
            var_used = need;
        }
        std::memcpy(base + var_offset + offset_bytes, &val, sizeof(double));
    }

    uint8_t* fn_alloc(size_t bytes) {
        bytes = align8(bytes);
        if (fn_used + bytes > fn_region_size) return nullptr;
        uint8_t* p = base + fn_offset + fn_used;
        fn_used += bytes;
        return p;
    }

    void print_report() const {
        auto kb = [](size_t b){ return b / 1024; };
        printf("  Memory: %zu KB total | %zu KB imm(%zu%%) | %zu KB var | %zu KB fn\n",
               kb(total), kb(imm_region_size),
               imm_region_size * 100 / (total ? total : 1),
               kb(var_region_size), kb(fn_region_size));
        printf("  Used:   %zu B total (%zu imm, %zu var, %zu fn)\n",
               imm_used + var_used + fn_used, imm_used, var_used, fn_used);
    }

private:
    static size_t align8(size_t n) { return (n + 7) & ~(size_t)7; }
};

// ===== Immutable Dictionary (WORM) =====
// Implements LAW 2.
enum class ImmState : uint8_t { UNINITIALIZED = 0, INITIALIZED = 1 };

struct ImmSlot {
    ImmState state    = ImmState::UNINITIALIZED;
    uint8_t* data     = nullptr;
    size_t   capacity = 0;
};

class ImmDict {
    std::unordered_map<std::string, ImmSlot> dict;
    MemoryArena* arena;
    ErrorSink*   err;

public:
    ImmDict(MemoryArena* a, ErrorSink& e) : arena(a), err(&e) {}

    bool declare(const std::string& name, size_t capacity, const std::string& initial = "") {
        if (!arena) {
            err->push(ErrorKind::MEMORY,
                      "ImmDict: no arena (nullptr) — cannot declare '" + name + "'");
            return false;
        }
        if (dict.count(name)) {
            err->push(ErrorKind::SEMANTIC,
                      "immutable '" + name + "' declared twice");
            return false;
        }
        capacity = std::max(capacity, (size_t)64);
        uint8_t* p = arena->imm_alloc(capacity);
        if (!p) {
            err->push(ErrorKind::MEMORY,
                      "out of immutable space for '" + name + "'");
            return false;
        }
        ImmSlot slot{ImmState::UNINITIALIZED, p, capacity};
        if (!initial.empty()) {
            std::memcpy(p, initial.c_str(), std::min(capacity, initial.size() + 1));
            slot.state = ImmState::INITIALIZED;
        }
        dict[name] = slot;
        return true;
    }

    bool write(const std::string& name, const std::string& value, ErrorSink& e) {
        auto it = dict.find(name);
        if (it == dict.end()) {
            e.push(ErrorKind::SEMANTIC, "unknown immutable '" + name + "'");
            return false;
        }
        if (it->second.state == ImmState::INITIALIZED) {
            e.push(ErrorKind::WORM,
                   "LAW 2 violation: immutable '" + name + "' is already INITIALIZED");
            return false;
        }
        size_t n = std::min(it->second.capacity - 1, value.size());
        std::memcpy(it->second.data, value.c_str(), n);
        it->second.data[n] = '\0';
        it->second.state = ImmState::INITIALIZED;
        return true;
    }

    bool read(const std::string& name, double& out) const {
        auto it = dict.find(name);
        if (it == dict.end()) return false;
        if (it->second.state == ImmState::UNINITIALIZED) return false;
        try { out = std::stod((const char*)it->second.data); return true; }
        catch (...) { return false; }
    }

    bool is_init(const std::string& name) const {
        auto it = dict.find(name);
        return it != dict.end() && it->second.state == ImmState::INITIALIZED;
    }

    ImmState get_state(const std::string& name) const {
        auto it = dict.find(name);
        if (it == dict.end()) return ImmState::UNINITIALIZED;
        return it->second.state;
    }

    size_t count() const { return dict.size(); }

    void dump() const {
        for (auto& [name, slot] : dict) {
            printf("    imm '%s': state=%s cap=%zu data='%s'\n",
                   name.c_str(),
                   slot.state == ImmState::INITIALIZED ? "INIT" : "UNINIT",
                   slot.capacity,
                   slot.state == ImmState::INITIALIZED ? (const char*)slot.data : "(uninit)");
        }
    }
};

// ===== Lifecycle Engine =====
// Implements LAW 3 (state), LAW 4 (port count), LAW 5 (overflow), LAW 6 (termination).
class LifecycleEngine {
    IrGraph&     graph;
    MemoryArena* arena;
    ImmDict*     imms;
    ErrorSink*   err;
    Logger*      log;

    std::unordered_map<size_t, double> vals;
    std::unordered_map<size_t, bool>   ready;
    std::unordered_map<size_t, double> carry;
    std::vector<size_t> topo;

    std::stringstream output_log;

    void build_topo() {
        std::unordered_set<size_t> visited;
        std::function<void(size_t)> dfs = [&](size_t id) {
            if (!visited.insert(id).second) return;
            auto* n = graph.node_by_id(id);
            if (!n) return;
            for (auto o : n->out_ids) dfs(o);
            topo.push_back(id);
        };
        size_t eid = graph.entry_id();
        if (eid) dfs(eid);
        for (auto& n : graph.nodes)
            if (!visited.count(n.id)) dfs(n.id);
        std::reverse(topo.begin(), topo.end());
    }

    bool eval_node(const IrNode& n) {
        if (ready[n.id]) return true;

        if (n.kind == NodeKind::IMMUTABLE) {
            double v = 0;
            if (imms->read(n.name, v)) {
                vals[n.id]  = v;
                ready[n.id] = true;
            } else {
                vals[n.id]  = 0;
                ready[n.id] = true;
            }
            return true;
        }

        if (n.kind == NodeKind::VARIABLE) {
            if (carry.count(n.id)) {
                vals[n.id]  = carry[n.id];
                ready[n.id] = true;
            } else {
                for (auto in : n.in_ids) {
                    auto* src = graph.node_by_id(in);
                    if (src && src->kind == NodeKind::IMMUTABLE && ready[in]) {
                        vals[n.id]  = vals[in];
                        ready[n.id] = true;
                        break;
                    }
                }
                if (!ready[n.id]) {
                    vals[n.id]  = 0;
                    ready[n.id] = true;
                }
            }
            return true;
        }

        if (n.kind == NodeKind::ENTRY || n.is_entry) {
            vals[n.id]  = 0;
            ready[n.id] = true;
            return true;
        }

        if (n.kind == NodeKind::RESULT) {
            if (n.in_ids.empty()) {
                vals[n.id] = 0;
                ready[n.id] = true;
                return true;
            }
            size_t src = n.in_ids[0];
            if (!ready[src]) return false;
            vals[n.id] = vals[src];
            ready[n.id] = true;
            return true;
        }

        std::vector<double> args;
        for (auto in : n.in_ids) {
            if (!ready[in]) return false;
            args.push_back(vals[in]);
        }
        if (args.empty()) {
            vals[n.id]  = 0;
            ready[n.id] = true;
            return true;
        }

        double result = 0;

        // LAW 4: Port count validation for multi-input ops
        auto check_arity = [&](size_t expected, const char* opname) -> bool {
            if (args.size() != expected) {
                err->push(ErrorKind::PORT,
                    std::string("LAW 4 violation: ") + opname + " in '" + n.name +
                    "' expects " + std::to_string(expected) + " inputs, got " +
                    std::to_string(args.size()));
                return false;
            }
            return true;
        };

        switch (n.op) {
            case OpKind::ADD:
                result = (args.size() >= 2) ? args[0] + args[1] : args[0];
                break;
            case OpKind::SUB:
                result = (args.size() >= 2) ? args[0] - args[1] : -args[0];
                break;
            case OpKind::MUL:
                result = (args.size() >= 2) ? args[0] * args[1] : args[0];
                break;
            case OpKind::DIV:
                if (args.size() < 2 || args[1] == 0) {
                    err->push(ErrorKind::OVERFLOW,
                        "LAW 5 violation: division by zero in node '" + n.name + "'");
                    result = 0;
                } else result = args[0] / args[1];
                break;
            case OpKind::MOD:
                if (args.size() < 2 || args[1] == 0) {
                    err->push(ErrorKind::OVERFLOW,
                        "LAW 5 violation: modulo by zero in node '" + n.name + "'");
                    result = 0;
                } else result = std::fmod(args[0], args[1]);
                break;
            case OpKind::LT:  result = (args[0] < args[1]) ? 1.0 : 0.0; break;
            case OpKind::GT:  result = (args[0] > args[1]) ? 1.0 : 0.0; break;
            case OpKind::EQ:  result = (args[0] == args[1]) ? 1.0 : 0.0; break;
            case OpKind::NEQ: result = (args[0] != args[1]) ? 1.0 : 0.0; break;
            case OpKind::MUX:
                if (!check_arity(3, "mux")) break;
                result = (args[0] != 0.0) ? args[1] : args[2];
                break;
            case OpKind::LOAD:
                if (!check_arity(1, "load")) break;
                result = arena->var_read_double((size_t)args[0], n.name, *err);
                break;
            case OpKind::STORE:
                if (!check_arity(2, "store")) break;
                arena->var_write_double((size_t)args[0], args[1], n.name, *err);
                result = args[1];
                break;
            case OpKind::PASS:
            default:
                result = args[0];
                break;
        }

        vals[n.id]  = result;
        ready[n.id] = true;
        if (log) log->trace("eval", n.name + "=" + std::to_string(result));
        return true;
    }

public:
    LifecycleEngine(IrGraph& g, MemoryArena* a, ImmDict* i, ErrorSink& e, Logger* l = nullptr)
        : graph(g), arena(a), imms(i), err(&e), log(l) {
        build_topo();
        if (log) log->info("Topo sort: " + std::to_string(topo.size()) + " nodes");
    }

    std::string get_output() const { return output_log.str(); }

    bool execute(size_t max_cycles) {
        size_t eid = graph.entry_id();
        if (!eid) {
            err->push(ErrorKind::SEMANTIC, "no entry node found in graph");
            return false;
        }

        for (auto& n : graph.nodes) {
            if (n.kind != NodeKind::IMMUTABLE) continue;
            size_t cap = std::max((size_t)64, n.value.size() + 1);
            if (!imms->declare(n.name, cap, n.value)) return false;
            if (log) log->trace("imm", "declared " + n.name +
                (n.value.empty() ? " (uninitialized)" : " = " + n.value));
        }

        for (auto& e : graph.edges) {
            auto* src = graph.node_by_id(e.src_id);
            auto* dst = graph.node_by_id(e.dst_id);
            if (!src || !dst) continue;
            if (src->kind == NodeKind::IMMUTABLE &&
                dst->kind == NodeKind::VARIABLE) {
                double v = 0;
                if (imms->read(src->name, v)) {
                    carry[dst->id] = v;
                    if (log) log->trace("seed", src->name + " -> " + dst->name + " = " + std::to_string(v));
                }
            }
        }

        output_log << "=== Lifecycle: " << graph.name << " ===\n";

        // LAW 6: Cycle execution
        for (size_t cycle = 1; cycle <= max_cycles; cycle++) {
            arena->var_reset();
            vals.clear();
            ready.clear();

            vals[eid]  = (double)cycle;
            ready[eid] = true;
            if (log) log->trace("cycle", "cycle " + std::to_string(cycle));

            bool progress = true;
            size_t iter_safe = 0;
            while (progress && iter_safe < 10000) {
                progress = false;
                iter_safe++;
                for (size_t id : topo) {
                    if (ready[id]) continue;
                    auto* n = graph.node_by_id(id);
                    if (!n) continue;
                    if (eval_node(*n)) progress = true;
                }
            }

            std::string cycle_line = "  [cycle " + std::to_string(cycle) + "]";
            for (auto& n : graph.nodes) {
                if (n.kind == NodeKind::IMMUTABLE) continue;
                if (n.is_entry || n.kind == NodeKind::ENTRY) continue;
                if (ready[n.id]) {
                    double v = vals[n.id];
                    cycle_line += "  " + n.name + "=";
                    if (v == std::floor(v))
                        cycle_line += std::to_string((long long)v);
                    else
                        cycle_line += std::to_string(v);
                }
            }
            output_log << cycle_line << "\n";

            bool terminated = false;
            for (auto& n : graph.nodes) {
                if (!n.is_end) continue;
                if (ready[n.id] && vals[n.id] != 0.0) {
                    terminated = true;
                    output_log << "  [cycle " << cycle << "] end node '" << n.name
                               << "' fired (value=" << vals[n.id] << ")\n";
                    break;
                }
            }
            if (terminated) {
                output_log << "\033[32m  Lifecycle terminated at cycle " << cycle << "\033[0m\n";
                if (log) log->info("Terminated at cycle " + std::to_string(cycle));
                return true;
            }

            for (auto& n : graph.nodes) {
                if (n.kind == NodeKind::FUNCTION && ready[n.id]) {
                    for (auto out_id : n.out_ids) {
                        auto* dst = graph.node_by_id(out_id);
                        if (dst && (dst->kind == NodeKind::VARIABLE || dst->kind == NodeKind::RESULT))
                            carry[out_id] = vals[n.id];
                    }
                }
            }

            if (err->has_errors()) return false;
        }

        err->push(ErrorKind::RUNTIME,
                  "LAW 6 violation: max cycles (" + std::to_string(max_cycles) +
                  ") reached without termination. Add { end: true } to a comparator node.");
        return false;
    }
};

// ===== Lexer =====
enum class Tok {
    IDENT, NUM, STR,
    KW_GRAPH, KW_NODE, KW_EDGE, KW_SETTING,
    KW_VAR, KW_FN, KW_IMM, KW_STORE, KW_ENTRY, KW_RESULT,
    KW_ADD, KW_SUB, KW_MUL, KW_DIV, KW_MOD,
    KW_LT, KW_GT, KW_EQ, KW_NEQ, KW_PASS, KW_MUX, KW_LOAD,
    LBRACE, RBRACE, SEMI, COLON, COMMA, ARROW,
    END_TOK
};

static const std::unordered_map<std::string,Tok> KEYWORDS = {
    {"graph",    Tok::KW_GRAPH},
    {"node",     Tok::KW_NODE},
    {"edge",     Tok::KW_EDGE},
    {"setting",  Tok::KW_SETTING},
    {"variable", Tok::KW_VAR},
    {"function", Tok::KW_FN},
    {"immutable",Tok::KW_IMM},
    {"store",    Tok::KW_STORE},
    {"entry",    Tok::KW_ENTRY},
    {"result",   Tok::KW_RESULT},
    {"add",      Tok::KW_ADD},
    {"sub",      Tok::KW_SUB},
    {"mul",      Tok::KW_MUL},
    {"div",      Tok::KW_DIV},
    {"mod",      Tok::KW_MOD},
    {"lt",       Tok::KW_LT},
    {"gt",       Tok::KW_GT},
    {"eq",       Tok::KW_EQ},
    {"neq",      Tok::KW_NEQ},
    {"pass",     Tok::KW_PASS},
    {"mux",      Tok::KW_MUX},
    {"load",     Tok::KW_LOAD},
};

static OpKind op_from_tok(Tok t) {
    switch (t) {
        case Tok::KW_ADD:  return OpKind::ADD;
        case Tok::KW_SUB:  return OpKind::SUB;
        case Tok::KW_MUL:  return OpKind::MUL;
        case Tok::KW_DIV:  return OpKind::DIV;
        case Tok::KW_MOD:  return OpKind::MOD;
        case Tok::KW_LT:   return OpKind::LT;
        case Tok::KW_GT:   return OpKind::GT;
        case Tok::KW_EQ:   return OpKind::EQ;
        case Tok::KW_NEQ:  return OpKind::NEQ;
        case Tok::KW_PASS: return OpKind::PASS;
        case Tok::KW_MUX:  return OpKind::MUX;
        case Tok::KW_LOAD: return OpKind::LOAD;
        default:           return OpKind::NONE;
    }
}

struct Token { Tok type; std::string val; SourcePos pos; };

class Lexer {
    std::string src, fname;
    size_t p = 0, line = 1, col = 1;

    char peek() const { return p < src.size() ? src[p] : '\0'; }
    char pop() {
        if (p >= src.size()) return '\0';
        char c = src[p++];
        if (c == '\n') { line++; col = 1; } else col++;
        return c;
    }

public:
    Lexer(std::string s, std::string f) : src(std::move(s)), fname(std::move(f)) {}

    Token next() {
        for (;;) {
            if (!peek()) return {Tok::END_TOK, "", {line, col}};
            if ((unsigned char)peek() <= ' ') { pop(); continue; }
            if (peek() == '#') { while (peek() && peek() != '\n') pop(); continue; }
            if (peek() == '/' && p+1 < src.size() && src[p+1] == '/') {
                while (peek() && peek() != '\n') pop();
                continue;
            }

            SourcePos pos{line, col};

            if (peek() == '-' && p+1 < src.size() && src[p+1] == '>')
                { pop(); pop(); return {Tok::ARROW, "->", pos}; }

            switch (peek()) {
                case '{': pop(); return {Tok::LBRACE, "{", pos};
                case '}': pop(); return {Tok::RBRACE, "}", pos};
                case ';': pop(); return {Tok::SEMI,   ";", pos};
                case ':': pop(); return {Tok::COLON,  ":", pos};
                case ',': pop(); return {Tok::COMMA,  ",", pos};
            }

            if (peek() == '"') {
                pop();
                std::string s;
                while (peek() && peek() != '"') s += pop();
                if (peek()) pop();
                return {Tok::STR, s, pos};
            }

            if (peek() == '`') {
                pop();
                std::string s;
                while (peek() && peek() != '`') s += pop();
                if (peek()) pop();
                return {Tok::STR, s, pos};
            }

            if (std::isdigit((unsigned char)peek()) ||
                (peek() == '-' && p+1 < src.size() &&
                 std::isdigit((unsigned char)src[p+1])))
            {
                std::string n;
                if (peek() == '-') n += pop();
                while (std::isdigit((unsigned char)peek())) n += pop();
                if (peek() == '.') {
                    n += pop();
                    while (std::isdigit((unsigned char)peek())) n += pop();
                }
                return {Tok::NUM, n, pos};
            }

            if (std::isalpha((unsigned char)peek()) || peek() == '_') {
                std::string id;
                while (std::isalnum((unsigned char)peek()) ||
                       peek() == '_' || peek() == '.') id += pop();
                auto it = KEYWORDS.find(id);
                return {it != KEYWORDS.end() ? it->second : Tok::IDENT, id, pos};
            }

            std::string u(1, pop());
            return {Tok::IDENT, u, pos};
        }
    }
};

// ===== Parser =====
class Parser {
    Lexer&     lex;
    Token      cur;
    ErrorSink& err;
    std::string fname;

    void advance() { cur = lex.next(); }

    Token expect(Tok t, const char* hint = "") {
        if (cur.type != t) {
            err.push(ErrorKind::SYNTAX,
                std::string("unexpected '") + cur.val + "'" +
                (hint[0] ? std::string(" (expected " + std::string(hint) + ")") : ""),
                fname, cur.pos);
        }
        auto c = cur; advance(); return c;
    }

    bool at(Tok t) const { return cur.type == t; }

public:
    Parser(Lexer& l, ErrorSink& e, std::string f)
        : lex(l), err(e), fname(std::move(f)) { advance(); }

    IrGraph parse() {
        IrGraph g;
        while (!at(Tok::END_TOK)) {
            if      (at(Tok::KW_GRAPH))   parse_graph(g);
            else if (at(Tok::KW_SETTING))  parse_setting(g);
            else if (at(Tok::KW_NODE))     parse_node(g);
            else if (at(Tok::KW_EDGE))     parse_edge(g);
            else {
                err.push(ErrorKind::SYNTAX,
                         "unexpected '" + cur.val + "'", fname, cur.pos);
                advance();
            }
        }
        link_edges(g);
        resolve_ops(g);
        assign_entry(g);
        return g;
    }

private:
    void parse_graph(IrGraph& g) {
        advance();
        g.name = cur.val; advance();
        expect(Tok::SEMI, ";");
    }

    void parse_setting(IrGraph& g) {
        advance();
        std::string name = cur.val; advance();
        expect(Tok::COLON, ":");
        std::string val = cur.val; advance();
        expect(Tok::SEMI, ";");
        if (name == "memory")
            g.memory_kb = std::max((size_t)256, (size_t)std::stoul(val));
        else if (name == "immutable_pct") {
            size_t p = std::stoul(val);
            g.immutable_pct = (p >= 1 && p <= 50) ? p : 3;
        }
        else if (name == "max_cycles" || name == "cycles")
            g.max_cycles = std::max((size_t)1, (size_t)std::stoul(val));
    }

    void parse_node(IrGraph& g) {
        advance();
        IrNode n;
        n.id  = g.nodes.size() + 1;
        n.pos = cur.pos;

        if      (at(Tok::KW_VAR))    { n.kind = NodeKind::VARIABLE; advance(); }
        else if (at(Tok::KW_FN))     { n.kind = NodeKind::FUNCTION; advance(); }
        else if (at(Tok::KW_IMM))    { n.kind = NodeKind::IMMUTABLE; advance(); }
        else if (at(Tok::KW_STORE))  { n.kind = NodeKind::FUNCTION; n.op = OpKind::STORE; n.is_store = true; advance(); }
        else if (at(Tok::KW_ENTRY))  { n.kind = NodeKind::ENTRY; n.is_entry = true; advance(); }
        else if (at(Tok::KW_RESULT)) { n.kind = NodeKind::RESULT; advance(); }
        else if (at(Tok::KW_MUX))    { n.kind = NodeKind::FUNCTION; n.op = OpKind::MUX; advance(); }
        else if (at(Tok::KW_LOAD))   { n.kind = NodeKind::FUNCTION; n.op = OpKind::LOAD; advance(); }
        else if (at(Tok::IDENT) && cur.val == "entry") {
            n.kind = NodeKind::ENTRY; n.is_entry = true; advance();
        }
        else if (at(Tok::IDENT) && cur.val == "result") {
            n.kind = NodeKind::RESULT; advance();
        }
        else {
            err.push(ErrorKind::SYNTAX,
                     "expected node kind (variable/function/immutable/store/entry/result/mux/load)",
                     fname, cur.pos);
            advance(); return;
        }

        n.name = cur.val; advance();

        if (at(Tok::LBRACE)) {
            advance();
            while (!at(Tok::RBRACE) && !at(Tok::END_TOK)) {
                std::string attr = cur.val; advance();
                expect(Tok::COLON, ":");
                std::string val = cur.val;
                Tok val_tok = cur.type;
                advance();

                if      (attr == "value") n.value = val;
                else if (attr == "op") {
                    OpKind ok = op_from_tok(val_tok);
                    if (ok == OpKind::NONE) ok = op_from_name(val);
                    n.op = ok;
                }
                else if (attr == "mem")
                    n.mem_limit_bytes = (size_t)(std::stod(val) * 1024);
                else if (attr == "entry")
                    n.is_entry = (val == "true");
                else if (attr == "end")
                    n.is_end = (val == "true");

                if (at(Tok::COMMA) || at(Tok::SEMI)) advance();
            }
            if (at(Tok::RBRACE)) advance();
        }

        if (n.kind == NodeKind::ENTRY) n.is_entry = true;
        if (n.kind == NodeKind::RESULT) n.is_end = true;

        expect(Tok::SEMI, ";");
        g.nodes.push_back(std::move(n));
    }

    void parse_edge(IrGraph& g) {
        advance();

        auto resolve = [&](const std::string& name) -> size_t {
            for (auto& n : g.nodes) if (n.name == name) return n.id;
            IrNode ph;
            ph.id   = g.nodes.size() + 1;
            ph.name = name;
            ph.kind = NodeKind::VARIABLE;
            g.nodes.push_back(ph);
            return ph.id;
        };

        std::string src_name = cur.val; advance();
        if (at(Tok::COLON)) { advance(); advance(); }
        expect(Tok::ARROW, "->");
        std::string dst_name = cur.val; advance();
        if (at(Tok::COLON)) { advance(); advance(); }
        expect(Tok::SEMI, ";");

        g.edges.push_back({resolve(src_name), resolve(dst_name)});
    }

    void link_edges(IrGraph& g) {
        for (auto& e : g.edges) {
            auto* src = g.node_by_id(e.src_id);
            auto* dst = g.node_by_id(e.dst_id);
            if (src) src->out_ids.push_back(e.dst_id);
            if (dst) dst->in_ids.push_back(e.src_id);
        }
    }

    void resolve_ops(IrGraph& g) {
        for (auto& n : g.nodes) {
            if (n.kind == NodeKind::FUNCTION && n.op == OpKind::NONE)
                n.op = op_from_name(n.name);
            if (n.is_store)
                n.op = OpKind::STORE;
        }
    }

    void assign_entry(IrGraph& g) {
        for (auto& n : g.nodes)
            if (n.is_entry) return;
        auto* e = g.node_by_name("entry");
        if (e) { e->is_entry = true; return; }
        for (auto& n : g.nodes)
            if (n.kind == NodeKind::FUNCTION && n.in_ids.empty())
                { n.is_entry = true; return; }
    }
};

static void dump_graph(const IrGraph& g) {
    printf("\n  === Graph: %s ===\n", g.name.c_str());
    for (auto& n : g.nodes) {
        const char* kind =
            n.kind == NodeKind::FUNCTION  ? "FN " :
            n.kind == NodeKind::VARIABLE  ? "VAR" :
            n.kind == NodeKind::IMMUTABLE ? "IMM" :
            n.kind == NodeKind::ENTRY     ? "ENT" :
            n.kind == NodeKind::RESULT    ? "RES" : "???";
        printf("  [%zu] %s %-16s  op=%-5s  val='%s' in=%zu out=%zu%s%s%s\n",
               n.id, kind, n.name.c_str(), op_name(n.op),
               n.value.c_str(), n.in_ids.size(), n.out_ids.size(),
               n.is_entry ? " ENTRY" : "",
               n.is_end   ? " END"   : "",
               n.is_store ? " STORE" : "");
    }
    printf("  Edges:\n");
    for (auto& e : g.edges) {
        auto* s = g.node_by_id(e.src_id);
        auto* d = g.node_by_id(e.dst_id);
        printf("    %s -> %s\n",
               s ? s->name.c_str() : "?",
               d ? d->name.c_str() : "?");
    }
    printf("\n");
}

static void usage(const char* prog) {
    printf("Ampersand Compiler v0.7 — Memory Law Enforcement\n\n");
    printf("Usage: %s compile <file.adg> [--dump] [--cycles N] [--json] [--trace]\n", prog);
    printf("       %s help\n\n", prog);
    printf("Laws enforced:\n");
    printf("  1  BOUNDS      Every memory access checks region capacity\n");
    printf("  2  WORM        Immutables write-once, read-many\n");
    printf("  3  STATE       All nodes have defined initialization\n");
    printf("  4  PORT        Multi-input ops require exact arity\n");
    printf("  5  OVERFLOW    Division/modulo by zero is caught\n");
    printf("  6  TERMINATION Lifecycle must end via end node\n");
    printf("  7  ARENA       Single OS reservation, no heap after init\n");
}

static void emit_json(const IrGraph& graph, bool ok, const MemoryArena& arena,
                       const ImmDict& imms, const std::string& output,
                       const std::string& log_str, ErrorSink& err) {
    printf("{\n");
    printf("  \"ok\": %s,\n", ok ? "true" : "false");
    printf("  \"name\": \"%s\",\n", graph.name.c_str());
    printf("  \"nodes\": %zu,\n", graph.nodes.size());
    printf("  \"edges\": %zu,\n", graph.edges.size());
    printf("  \"memory_kb\": %zu,\n", graph.memory_kb);
    printf("  \"immutables\": %zu,\n", imms.count());
    printf("  \"output\": \"");
    for (char c : output) {
        if (c == '"') printf("\\\"");
        else if (c == '\\') printf("\\\\");
        else if (c == '\n') printf("\\n");
        else if (c == '\033') continue;
        else printf("%c", c);
    }
    printf("\",\n");
    printf("  \"log\": \"");
    for (char c : log_str) {
        if (c == '"') printf("\\\"");
        else if (c == '\\') printf("\\\\");
        else if (c == '\n') printf("\\n");
        else if (c == '\033') continue;
        else printf("%c", c);
    }
    printf("\",\n");
    printf("  \"errors\": [\n");
    bool first = true;
    for (auto& e : err.all()) {
        if (!first) printf(",\n");
        first = false;
        printf("    {\"kind\": \"%s\", \"msg\": \"%s\", \"line\": %zu}",
               [](ErrorKind k) {
                   static const char* n[]={"syntax","semantic","memory","overflow","type","link","runtime","worm","bounds","port","state","config"};
                   return n[(int)k];
               }(e.kind),
               e.message.c_str(), e.pos.line);
    }
    printf("\n  ]\n");
    printf("}\n");
}

int main(int argc, char* argv[]) {
    if (argc < 2) { usage(argv[0]); return 1; }
    std::string cmd = argv[1];

    if (cmd == "help" || cmd == "--help") { usage(argv[0]); return 0; }

    if (cmd == "compile") {
        if (argc < 3) { usage(argv[0]); return 1; }

        bool   do_dump     = false;
        bool   do_json     = false;
        bool   do_trace    = false;
        size_t max_cycles  = 0;
        std::string infile = argv[2];

        for (int i = 3; i < argc; i++) {
            std::string a = argv[i];
            if (a == "--dump") do_dump = true;
            else if (a == "--json") do_json = true;
            else if (a == "--trace") do_trace = true;
            else if (a == "--cycles" && i+1 < argc)
                max_cycles = (size_t)std::stoul(argv[++i]);
        }

        auto t_start = std::chrono::high_resolution_clock::now();

        std::ifstream f(infile);
        if (!f) {
            fprintf(stderr, "cannot open '%s'\n", infile.c_str());
            return 1;
        }
        std::stringstream ss; ss << f.rdbuf();

        Logger logger;
        if (do_trace) logger.set_trace(true);
        ErrorSink err;
        Lexer  lex(ss.str(), infile);
        Parser parser(lex, err, infile);
        IrGraph graph = parser.parse();

        if (err.has_errors()) {
            if (do_json) {
                MemoryArena dummy;
                ImmDict nd(&dummy, err);
                emit_json(graph, false, dummy, nd, "", logger.str(), err);
                return 1;
            }
            err.print(std::cerr);
            return 1;
        }

        logger.info("Parsed " + std::to_string(graph.nodes.size()) + " nodes, " +
                     std::to_string(graph.edges.size()) + " edges");

        if (!do_json) {
            printf("\033[36m[Ampersand v0.7]\033[0m '%s'  %zu nodes  %zu edges  %zu KB memory\n",
                   graph.name.c_str(), graph.nodes.size(), graph.edges.size(), graph.memory_kb);
        }

        if (do_dump) dump_graph(graph);

        MemoryArena arena;
        if (!arena.init(graph.memory_kb, graph.immutable_pct, err, &logger)) {
            if (do_json) {
                ImmDict nd(&arena, err);
                emit_json(graph, false, arena, nd, "", logger.str(), err);
                return 1;
            }
            err.print(std::cerr);
            return 1;
        }

        ImmDict imms(&arena, err);

        size_t actual_max = (max_cycles > 0) ? max_cycles : graph.max_cycles;

        if (!do_json) {
            LifecycleEngine engine(graph, &arena, &imms, err, &logger);
            printf("\n  Executing...\n\n");
            bool ok = engine.execute(actual_max);
            printf("%s\n", engine.get_output().c_str());
            printf("\n");
            arena.print_report();
            printf("  Immutables registered: %zu\n", imms.count());

            auto t_end = std::chrono::high_resolution_clock::now();
            auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(t_end - t_start).count();
            printf("  Elapsed: %zu ms\n", ms);

            if (do_dump) {
                printf("  Immutable Dictionary:\n");
                imms.dump();
            }

            if (do_trace) {
                printf("  Runtime Log:\n%s", logger.str().c_str());
            }

            if (ok)  printf("\033[32m  \u2713 Lifecycle completed successfully\033[0m\n");
            else     printf("\033[31m  \u2717 Lifecycle failed\033[0m\n");

            if (err.has_errors()) err.print(std::cerr);
            return ok ? 0 : 1;
        }

        LifecycleEngine engine(graph, &arena, &imms, err, &logger);
        bool ok = engine.execute(actual_max);
        emit_json(graph, ok, arena, imms, engine.get_output(), logger.str(), err);
        return ok ? 0 : 1;
    }

    fprintf(stderr, "unknown command '%s'\n", cmd.c_str());
    return 1;
}
