import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
	createAgentSession,
	DefaultResourceLoader,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const expectedTools = ["bg_start", "bg_status", "bg_list", "bg_kill"];

function assertToolsRemainExposed(session: {
	getAllTools(): Array<{ name: string }>;
	getActiveToolNames(): string[];
}): void {
	const registered = new Set(session.getAllTools().map((tool) => tool.name));
	const active = new Set(session.getActiveToolNames());
	for (const name of expectedTools) {
		assert.equal(
			registered.has(name),
			true,
			`${name} should remain registered`,
		);
		assert.equal(active.has(name), true, `${name} should remain active`);
	}
}

test("background terminal tools remain registered and active after reload", async () => {
	const agentDir = fs.mkdtempSync(
		path.join(os.tmpdir(), "pi-background-terminals-reload-"),
	);
	fs.writeFileSync(
		path.join(agentDir, "settings.json"),
		JSON.stringify({ packages: [packageRoot] }),
	);
	const settingsManager = SettingsManager.create(packageRoot, agentDir);
	const resourceLoader = new DefaultResourceLoader({
		cwd: packageRoot,
		agentDir,
		settingsManager,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
	});

	try {
		await resourceLoader.reload();
		assert.deepEqual(resourceLoader.getExtensions().errors, []);
		const { session } = await createAgentSession({
			cwd: packageRoot,
			resourceLoader,
			settingsManager,
			sessionManager: SessionManager.inMemory(),
		});
		try {
			assertToolsRemainExposed(session);
			await session.reload();
			assert.deepEqual(resourceLoader.getExtensions().errors, []);
			assertToolsRemainExposed(session);
		} finally {
			session.dispose();
		}
	} finally {
		fs.rmSync(agentDir, { recursive: true, force: true });
	}
});
