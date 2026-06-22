<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\HasMany;

class Project extends Model
{
    protected $fillable = ['name', 'settings'];

    protected function casts(): array
    {
        return [
            'settings' => 'array',
        ];
    }

    public function functions(): HasMany
    {
        return $this->hasMany(FnNode::class, 'project_id');
    }

    public function variables(): HasMany
    {
        return $this->hasMany(Variable::class, 'project_id');
    }

    public function immutables(): HasMany
    {
        return $this->hasMany(Immutable::class, 'project_id');
    }

    public function connections(): HasMany
    {
        return $this->hasMany(Connection::class);
    }
}
