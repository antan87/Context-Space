// Run after npm run build:backend. Exercises the actual stdio MCP server with
// temporary workspaces; no model calls, user documents, or remote writes.
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const cli = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'contextspace-mcp-smoke-'));
const mutations = ['update_work_assignment', 'add_work_document', 'update_work_document'];
try {
  for (const role of ['interactive', 'developer', 'readonly', 'review', 'ci']) {
    const workspace = path.join(root, role);
    await fs.mkdir(workspace);
    await fs.writeFile(path.join(workspace, 'contextspace.json'), JSON.stringify({ id: role, branchName: role, description: 'Smoke test reports', repos: [], assistants: [] }));
    const client = new Client({ name: 'planning-smoke', version: '1.0' });
    const transport = new StdioClientTransport({ command: process.execPath, args: [cli, 'mcp', 'run', workspace, '--role', role], stderr: 'pipe' });
    let stderr = '';
    transport.stderr?.on('data', (chunk) => { stderr += String(chunk); });
    try {
      await client.connect(transport);
      const tools = (await client.listTools()).tools;
      const names = tools.map((tool) => tool.name);
      // AIs change the plan by editing PLAN.md: the old planning tools are gone.
      for (const name of ['get_planning_notes', 'save_planning_notes', 'update_milestone_plan', 'set_milestone']) assert(!names.includes(name));
      const call = async (name, args = {}) => {
        const result = await client.callTool({ name, arguments: args });
        assert.notEqual(result.isError, true, JSON.stringify(result));
        return JSON.parse(result.content[0].text);
      };
      let context = await call('get_work_context');
      assert.equal(context.guidance.revision, 0);
      assert.equal(context.plan, null);
      if (['readonly', 'review', 'ci'].includes(role)) {
        for (const name of mutations) {
          assert(!names.includes(name));
          assert.equal((await client.callTool({ name, arguments: {} })).isError, true);
        }
        assert.deepEqual(await fs.readdir(workspace), ['contextspace.json']);
      } else {
        assert(mutations.every((name) => names.includes(name)));
        await fs.writeFile(path.join(workspace, 'PLAN.md'), '# Reports\n\n## Checkpoints\n\n- [ ] Open reports from the root\n');
        // Where PLAN.md stands and its text, for tools that only have MCP.
        assert.match((await call('get_work_context')).plan, /CHECKPOINTS[\s\S]*- \[ \] Open reports from the root/);
        context = await call('update_work_assignment', { revision: (await call('get_work_context')).guidance.revision, workType: 'feature', size: 'small', assignment: { stage: 'implement', objective: 'Open root reports', expectedOutput: 'Report viewer', stopCondition: 'Tests pass' } });
        context = await call('add_work_document', { revision: context.guidance.revision, title: 'Requirements', role: 'requirements', content: '# Root reports\nKeep their formatting.' });
        const documentId = context.guidance.documents[0].id;
        assert.equal((await call('read_work_document', { documentId })).content, '# Root reports\nKeep their formatting.');
        context = await call('update_work_document', { revision: context.guidance.revision, documentId, title: 'Earlier requirements', role: 'reference', status: 'superseded', scope: {}, summary: 'Kept for history' });
        assert.equal(context.guidance.documents[0].status, 'superseded');
      }
      console.log(`PASS ${role}: ${names.length} tools; brief reads, writes, plan text and role boundaries verified`);
    } catch (error) {
      if (stderr) console.error(stderr);
      throw error;
    } finally {
      await client.close();
      await transport.close();
    }
  }
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
