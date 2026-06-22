<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

class Immutable extends Model
{
    protected $fillable = [
        'project_id', 'imm_name', 'imm_value', 'initialized', 'pos_x', 'pos_y',
    ];

    public function project(): BelongsTo
    {
        return $this->belongsTo(Project::class);
    }
}
