<?php

namespace App\Http\Controllers;

use App\Models\Connection;
use App\Models\FnNode;
use App\Models\Immutable;
use App\Models\Project;
use App\Models\Variable;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Log;
use Symfony\Component\Process\Process;
use Symfony\Component\Process\Exception\ProcessFailedException;

class CanvasController extends Controller
{
    public function projectList(): JsonResponse
    {
        $projects = Project::select('id', 'name', 'created_at', 'updated_at')
            ->orderBy('updated_at', 'desc')
            ->limit(50)
            ->get();

        return response()->json($projects);
    }

    public function projectSave(Request $request): JsonResponse
    {
        $request->validate(['name' => 'required|string']);

        $name = trim($request->input('name')) ?: 'Untitled';

        if ($id = (int) $request->input('id', 0)) {
            $project = Project::find($id);
            if (!$project) {
                return response()->json(['error' => 'Project not found'], 404);
            }
            $project->update(['name' => $name]);
            return response()->json(['id' => $id]);
        }

        $project = Project::create(['name' => $name]);
        return response()->json(['id' => $project->id]);
    }

    public function projectLoad(Request $request): JsonResponse
    {
        $request->validate(['id' => 'required|integer']);

        $project = Project::with('functions', 'variables', 'immutables', 'connections')->find((int) $request->input('id'));

        if (!$project) {
            return response()->json(['error' => 'Project not found'], 404);
        }

        return response()->json([
            'project' => $project->toArray(),
            'functions' => $project->functions,
            'variables' => $project->variables,
            'immutables' => $project->immutables,
            'connections' => $project->connections,
        ]);
    }

    public function projectDelete(Request $request): JsonResponse
    {
        $request->validate(['id' => 'required|integer']);

        $project = Project::find((int) $request->input('id'));

        if (!$project) {
            return response()->json(['error' => 'Project not found'], 404);
        }

        $project->delete();

        return response()->json(['ok' => true]);
    }

    public function canvasSave(Request $request): JsonResponse
    {
        $request->validate([
            'project_id' => 'required|integer',
            'name' => 'required|string',
            'functions' => 'nullable|array',
            'functions.*.fnName' => 'nullable|string',
            'functions.*.fnCode' => 'nullable|string',
            'functions.*.fnInputs' => 'nullable|string',
            'functions.*.fnSizeKB' => 'nullable|integer',
            'functions.*.dbId' => 'nullable|integer',
            'functions.*.x' => 'nullable|numeric',
            'functions.*.y' => 'nullable|numeric',
            'variables' => 'nullable|array',
            'variables.*.label' => 'nullable|string',

            'variables.*.dbId' => 'nullable|integer',
            'variables.*.x' => 'nullable|numeric',
            'variables.*.y' => 'nullable|numeric',
            'immutables' => 'nullable|array',
            'immutables.*.label' => 'nullable|string',
            'immutables.*.immValue' => 'nullable|string',
            'immutables.*.initialized' => 'nullable|boolean',
            'immutables.*.dbId' => 'nullable|integer',
            'immutables.*.x' => 'nullable|numeric',
            'immutables.*.y' => 'nullable|numeric',
            'edges' => 'nullable|array',
            'edges.*.fromNodeId' => 'nullable|integer',
            'edges.*.fromPortId' => 'required|string',
            'edges.*.toNodeId' => 'nullable|integer',
            'edges.*.toPortId' => 'required|string',
        ]);

        $pid = (int) $request->input('project_id');
        $name = trim($request->input('name')) ?: 'Untitled';

        $project = Project::find($pid);
        if (!$project) {
            return response()->json(['error' => 'Project not found'], 404);
        }

        $project->update(['name' => $name]);

        $incomingFns = $request->input('functions', []);
        $existingFns = $project->functions()->orderBy('id')->get();
        $usedFnIds = [];
        $fnIds = [];

        foreach ($incomingFns as $i => $f) {
            $data = [
                'fn_name' => $f['fnName'] ?? 'handler',
                'fn_code' => $f['fnCode'] ?? '',
                'fn_inputs' => $f['fnInputs'] ?? '',
                'fn_size_kb' => (int) ($f['fnSizeKB'] ?? 1),
                'pos_x' => (float) ($f['x'] ?? 0),
                'pos_y' => (float) ($f['y'] ?? 0),
            ];

            $dbId = $f['dbId'] ?? null;
            $matched = false;

            if ($dbId) {
                foreach ($existingFns as $ef) {
                    if ($ef->id === (int) $dbId && !in_array($ef->id, $usedFnIds)) {
                        $ef->update($data);
                        $fnIds[] = $ef->id;
                        $usedFnIds[] = $ef->id;
                        $matched = true;
                        break;
                    }
                }
            }

            if (!$matched && isset($existingFns[$i]) && !in_array($existingFns[$i]->id, $usedFnIds)) {
                $existingFns[$i]->update($data);
                $fnIds[] = $existingFns[$i]->id;
                $usedFnIds[] = $existingFns[$i]->id;
                $matched = true;
            }

            if (!$matched) {
                $fn = $project->functions()->create($data);
                $fnIds[] = $fn->id;
            }
        }

        foreach ($existingFns as $ef) {
            if (!in_array($ef->id, $usedFnIds)) {
                $ef->delete();
            }
        }

        $incomingVars = $request->input('variables', []);
        $existingVars = $project->variables()->orderBy('id')->get();
        $usedVarIds = [];
        $varIds = [];

        foreach ($incomingVars as $i => $v) {
            $data = [
                'var_name' => $v['label'] ?? '',
                'pos_x' => (float) ($v['x'] ?? 0),
                'pos_y' => (float) ($v['y'] ?? 0),
            ];

            $dbId = $v['dbId'] ?? null;
            $matched = false;

            if ($dbId) {
                foreach ($existingVars as $ev) {
                    if ($ev->id === (int) $dbId && !in_array($ev->id, $usedVarIds)) {
                        $ev->update($data);
                        $varIds[] = $ev->id;
                        $usedVarIds[] = $ev->id;
                        $matched = true;
                        break;
                    }
                }
            }

            if (!$matched && isset($existingVars[$i]) && !in_array($existingVars[$i]->id, $usedVarIds)) {
                $existingVars[$i]->update($data);
                $varIds[] = $existingVars[$i]->id;
                $usedVarIds[] = $existingVars[$i]->id;
                $matched = true;
            }

            if (!$matched) {
                $var = $project->variables()->create($data);
                $varIds[] = $var->id;
            }
        }

        foreach ($existingVars as $ev) {
            if (!in_array($ev->id, $usedVarIds)) {
                $ev->delete();
            }
        }

        $incomingImms = $request->input('immutables', []);
        $existingImms = $project->immutables()->orderBy('id')->get();
        $usedImmIds = [];
        $immIds = [];

        foreach ($incomingImms as $i => $v) {
            $data = [
                'imm_name' => $v['label'] ?? '',
                'imm_value' => $v['immValue'] ?? '',
                'initialized' => !empty($v['immValue']),
                'pos_x' => (float) ($v['x'] ?? 0),
                'pos_y' => (float) ($v['y'] ?? 0),
            ];

            $dbId = $v['dbId'] ?? null;
            $matched = false;

            if ($dbId) {
                foreach ($existingImms as $ev) {
                    if ($ev->id === (int) $dbId && !in_array($ev->id, $usedImmIds)) {
                        $ev->update($data);
                        $immIds[] = $ev->id;
                        $usedImmIds[] = $ev->id;
                        $matched = true;
                        break;
                    }
                }
            }

            if (!$matched && isset($existingImms[$i]) && !in_array($existingImms[$i]->id, $usedImmIds)) {
                $existingImms[$i]->update($data);
                $immIds[] = $existingImms[$i]->id;
                $usedImmIds[] = $existingImms[$i]->id;
                $matched = true;
            }

            if (!$matched) {
                $imm = $project->immutables()->create($data);
                $immIds[] = $imm->id;
            }
        }

        foreach ($existingImms as $ev) {
            if (!in_array($ev->id, $usedImmIds)) {
                $ev->delete();
            }
        }

        $project->connections()->delete();

        $edges = $request->input('edges', []);

        foreach ($edges as $e) {
            $project->connections()->create([
                'from_node_idx' => $e['fromNodeId'] ?? null,
                'from_port_id' => $e['fromPortId'],
                'to_node_idx' => $e['toNodeId'] ?? null,
                'to_port_id' => $e['toPortId'],
            ]);
        }

        return response()->json([
            'ok' => true,
            'fnIds' => $fnIds,
            'varIds' => $varIds,
            'immIds' => $immIds,
        ]);
    }

    public function compile(Request $request): JsonResponse
    {
        $request->validate([
            'project_id' => 'nullable|integer',
            'functions' => 'nullable|array',
            'functions.*.fnOp' => 'nullable|string',
            'functions.*.fnEnd' => 'nullable|boolean',
            'variables' => 'nullable|array',
            'immutables' => 'nullable|array',
            'edges' => 'nullable|array',
            'edges.*.fromName' => 'nullable|string',
            'edges.*.toName' => 'nullable|string',
        ]);

        $projectId = $request->input('project_id');
        $funcs = $request->input('functions', []);
        $vars = $request->input('variables', []);
        $imms = $request->input('immutables', []);
        $edges = $request->input('edges', []);

        // Build a flattened list of all nodes with index positions matching the canvas array order
        $allNodes = [];
        $nodeIndexToName = [];

        $idx = 0;
        // Functions first
        foreach ($funcs as $f) {
            $name = $f['fnName'] ?? 'handler';
            $allNodes[] = ['type' => 'function', 'name' => $name, 'data' => $f];
            $nodeIndexToName[$idx] = $name;
            $idx++;
        }
        // Variables
        foreach ($vars as $v) {
            $name = $v['label'] ?? 'var_' . $idx;
            $allNodes[] = ['type' => 'variable', 'name' => $name, 'data' => $v];
            $nodeIndexToName[$idx] = $name;
            $idx++;
        }
        // Immutables
        foreach ($imms as $v) {
            $name = $v['label'] ?? 'imm_' . $idx;
            $allNodes[] = ['type' => 'immutable', 'name' => $name, 'data' => $v];
            $nodeIndexToName[$idx] = $name;
            $idx++;
        }

        // Check if entry/result nodes exist or need auto-generation
        $hasEntry = false;
        $hasResult = false;
        $resultName = '';
        foreach ($allNodes as $n) {
            if ($n['type'] === 'function' && $n['name'] === 'entry') $hasEntry = true;
            if ($n['type'] === 'function' && $n['name'] === 'result') $hasResult = true;
        }

        // Build ADG text
        $adg = "# Auto-generated by Ampersand Canvas\n";
        $adg .= "graph canvas_project;\n";
        $adg .= "setting memory: 8192;\n";
        $adg .= "setting immutable_pct: 3;\n";
        $adg .= "setting max_cycles: 5000;\n\n";

        // Auto-add entry and result if missing
        if (!$hasEntry) {
            $adg .= "node entry entry;\n";
        }
        if (!$hasResult) {
            $resultName = 'canvas_result';
            $adg .= "node result " . $resultName . ";\n";
        }

        // Emit nodes
        foreach ($allNodes as $n) {
            $type = $n['type'];
            $name = $n['name'];
            $data = $n['data'];

            if ($type === 'function') {
                $op = $data['fnOp'] ?? '';
                $code = $data['fnCode'] ?? '';
                $endAttr = !empty($data['fnEnd']) ? ', end: true' : '';
                if (empty($op) && !empty($code)) {
                    $codeLower = strtolower($code);
                    if (strpos($codeLower, 'mux') !== false || strpos($codeLower, 'select') !== false) $op = 'mux';
                    elseif (strpos($codeLower, 'store') !== false || strpos($codeLower, 'write') !== false) $op = 'store';
                    elseif (strpos($codeLower, 'load') !== false || strpos($codeLower, 'read') !== false) $op = 'load';
                    elseif (strpos($codeLower, 'add') !== false || strpos($codeLower, '+') !== false) $op = 'add';
                    elseif (strpos($codeLower, 'sub') !== false || strpos($codeLower, '-') !== false) $op = 'sub';
                    elseif (strpos($codeLower, 'mul') !== false || strpos($codeLower, '*') !== false) $op = 'mul';
                    elseif (strpos($codeLower, 'div') !== false || strpos($codeLower, '/') !== false) $op = 'div';
                    elseif (strpos($codeLower, 'mod') !== false || strpos($codeLower, '%') !== false) $op = 'mod';
                    elseif (strpos($codeLower, 'lt') !== false || strpos($codeLower, '<') !== false) $op = 'lt';
                    elseif (strpos($codeLower, 'gt') !== false || strpos($codeLower, '>') !== false) $op = 'gt';
                    elseif (strpos($codeLower, 'eq') !== false || strpos($codeLower, '==') !== false) $op = 'eq';
                    elseif (strpos($codeLower, 'neq') !== false) $op = 'neq';
                }
                $mem = $data['fnSizeKB'] ?? 1;

                if ($op) {
                    $adg .= "node function " . $name . " { op: " . $op . ", mem: " . $mem . $endAttr . " };\n";
                } else {
                    $adg .= "node function " . $name . " { mem: " . $mem . $endAttr . " };\n";
                }
            } elseif ($type === 'variable') {
                $adg .= "node variable " . $name . ";\n";
            } elseif ($type === 'immutable') {
                $val = $data['immValue'] ?? '';
                $initialized = !empty($data['initialized']) && !empty($val);
                if ($initialized) {
                    $adg .= "node immutable " . $name . " { value: \"" . $val . "\" };\n";
                } else {
                    $adg .= "node immutable " . $name . ";\n";
                }
            }
        }

        // Emit edges using name-based resolution
        $adg .= "\n";
        foreach ($edges as $e) {
            $fromName = $e['fromName'] ?? '';
            $toName = $e['toName'] ?? '';
            if (!empty($fromName) && !empty($toName)) {
                $adg .= "edge " . $fromName . " -> " . $toName . ";\n";
            }
        }

        // Write to temp file
        $tmpFile = storage_path('app/tmp_' . uniqid() . '.adg');
        file_put_contents($tmpFile, $adg);

        // Invoke compiler
        $compilerPath = base_path('compiler/ampersand.exe');
        if (!file_exists($compilerPath)) {
            unlink($tmpFile);
            return response()->json([
                'ok' => false,
                'error' => 'Compiler not found at ' . $compilerPath,
                'adg' => $adg,
            ]);
        }

        $cmd = '"' . $compilerPath . '" compile "' . $tmpFile . '" --json';

        $output = '';
        $exitCode = 0;
        try {
            $process = Process::fromShellCommandline($cmd);
            $process->setTimeout(30);
            $process->run();
            $output = $process->getOutput();
            $exitCode = $process->getExitCode();
        } catch (\Exception $ex) {
            unlink($tmpFile);
            return response()->json([
                'ok' => false,
                'error' => 'Process error: ' . $ex->getMessage(),
                'adg' => $adg,
            ]);
        }

        unlink($tmpFile);

        // Parse JSON from compiler output
        $result = json_decode($output, true);
        if (!$result || !isset($result['ok'])) {
            return response()->json([
                'ok' => false,
                'error' => 'Compiler returned malformed output',
                'raw_output' => $output,
                'adg' => $adg,
            ]);
        }

        $compilerErrors = [];
        if (isset($result['errors'])) {
            foreach ($result['errors'] as $e) {
                $compilerErrors[] = $e;
            }
        }

        return response()->json([
            'ok' => $result['ok'],
            'name' => $result['name'] ?? '',
            'nodes' => $result['nodes'] ?? 0,
            'edges' => $result['edges'] ?? 0,
            'memory_kb' => $result['memory_kb'] ?? 0,
            'immutables' => $result['immutables'] ?? 0,
            'cycles' => $result['cycles'] ?? 0,
            'output' => $result['output'] ?? '',
            'log' => $result['log'] ?? '',
            'errors' => $compilerErrors,
            'adg' => $adg,
        ]);
    }
}
