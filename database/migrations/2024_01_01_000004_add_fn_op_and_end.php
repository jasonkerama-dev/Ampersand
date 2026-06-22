<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::table('functions', function (Blueprint $table) {
            $table->string('fn_op', 50)->nullable()->after('fn_size_kb');
            $table->boolean('fn_end')->default(false)->after('fn_op');
        });
    }

    public function down(): void
    {
        Schema::table('functions', function (Blueprint $table) {
            $table->dropColumn(['fn_op', 'fn_end']);
        });
    }
};
