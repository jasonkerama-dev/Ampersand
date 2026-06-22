<?php

use App\Http\Controllers\CanvasController;
use Illuminate\Support\Facades\Route;

Route::get('/', function () {
    $projectId = request()->query('id');
    return view('canvas', ['projectId' => $projectId ? (int) $projectId : null]);
});

Route::prefix('api/canvas')->group(function () {
    Route::post('project_list', [CanvasController::class, 'projectList']);
    Route::post('project_save', [CanvasController::class, 'projectSave']);
    Route::post('project_load', [CanvasController::class, 'projectLoad']);
    Route::post('project_delete', [CanvasController::class, 'projectDelete']);
    Route::post('canvas_save', [CanvasController::class, 'canvasSave']);
    Route::post('compile', [CanvasController::class, 'compile']);
});
