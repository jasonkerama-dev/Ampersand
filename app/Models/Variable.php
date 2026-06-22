<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

class Variable extends Model
{
    protected $fillable = [
        'project_id', 'var_name', 'pos_x', 'pos_y',
    ];

    public function project(): BelongsTo
    {
        return $this->belongsTo(Project::class);
    }
}
