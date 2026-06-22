<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('projects', function (Blueprint $table) {
            $table->id();
            $table->string('name', 255)->default('Untitled');
            $table->text('edges')->nullable();
            $table->timestamps();
        });

        Schema::create('functions', function (Blueprint $table) {
            $table->id();
            $table->foreignId('project_id')->constrained()->cascadeOnDelete();
            $table->string('fn_name', 255)->default('handler');
            $table->text('fn_code')->nullable();
            $table->string('fn_inputs', 255)->nullable();
            $table->integer('fn_size_kb')->default(1);
            $table->double('pos_x')->default(0);
            $table->double('pos_y')->default(0);
            $table->timestamps();
        });

        Schema::create('variables', function (Blueprint $table) {
            $table->id();
            $table->foreignId('project_id')->constrained()->cascadeOnDelete();
            $table->string('var_name', 255)->default('');
            $table->double('pos_x')->default(0);
            $table->double('pos_y')->default(0);
            $table->timestamps();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('variables');
        Schema::dropIfExists('functions');
        Schema::dropIfExists('projects');
    }
};
