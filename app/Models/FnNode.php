<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

class FnNode extends Model
{
    protected $table = 'functions';

    protected $fillable = [
        'project_id', 'fn_name', 'fn_code', 'fn_inputs',
        'fn_size_kb', 'fn_op', 'fn_end', 'pos_x', 'pos_y',
    ];

    public function project(): BelongsTo
    {
        return $this->belongsTo(Project::class);
    }
}
