import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { activate } from '../module/index.mjs';
test('installation and activation without sharing open no service and retain stable UUID', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tv-plugin-'));
    try {
        const context = { dataDir, callCore: async () => ({ enabled: false }) };
        const first = await activate(context);
        const status = await first.call('refresh');
        assert.equal(status.sharing, false);
        assert.equal(status.error, null);
        await first.stop();
        const second = await activate(context);
        assert.equal((await second.call('status')).uuid, status.uuid);
        await second.stop();
    }
    finally {
        await fs.rm(dataDir, { recursive: true, force: true });
    }
});
