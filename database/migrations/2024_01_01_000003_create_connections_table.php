<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::table('projects', function (Blueprint $table) {
            $table->dropColumn('edges');
        });

        Schema::create('connections', function (Blueprint $table) {
            $table->id();
            $table->foreignId('project_id')->constrained()->cascadeOnDelete();
            $table->string('from_node_idx')->nullable();
            $table->string('from_port_id');
            $table->string('to_node_idx')->nullable();
            $table->string('to_port_id');
            $table->timestamps();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('connections');

        Schema::table('projects', function (Blueprint $table) {
            $table->text('edges')->nullable();
        });
    }
};
