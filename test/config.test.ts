import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { getConfigPath, readConfig, validateConfig } from "../src/config.ts";

test("legacy five-role configuration migrates to writer and reviewer", () => {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-parallel-config-"));
	writeFileSync(
		getConfigPath(agentDir),
		JSON.stringify({
			version: 3,
			models: {
				planner: { model: "provider/planner", reasoningEffort: "high" },
				worktreeManager: { model: "provider/utility", reasoningEffort: "low" },
				implementer: { model: "provider/writer", reasoningEffort: "high" },
				reviewer: { model: "provider/reviewer", reasoningEffort: "medium" },
				integrator: { model: "provider/integrator", reasoningEffort: "high" },
			},
		}),
	);
	const config = readConfig(agentDir)!;
	assert.equal(config.version, 4);
	assert.deepEqual(config.models, {
		writer: { model: "provider/writer", reasoningEffort: "high" },
		reviewer: { model: "provider/reviewer", reasoningEffort: "medium" },
	});
});

test("version 1 string models migrate directly to the two retained roles", () => {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-parallel-config-"));
	writeFileSync(
		getConfigPath(agentDir),
		JSON.stringify({
			version: 1,
			models: {
				planner: "provider/planner",
				implementer: "provider/writer",
				reviewer: "provider/reviewer",
				integrator: "provider/integrator",
			},
		}),
	);
	const config = readConfig(agentDir)!;
	assert.equal(config.models.writer.model, "provider/writer");
	assert.equal(config.models.writer.reasoningEffort, "high");
	assert.equal(config.models.reviewer.reasoningEffort, "medium");
});

test("unknown future configuration versions are rejected", () => {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-parallel-config-"));
	writeFileSync(
		getConfigPath(agentDir),
		JSON.stringify({
			version: 99,
			models: {
				implementer: "provider/writer",
				reviewer: "provider/reviewer",
			},
		}),
	);
	assert.throws(() => readConfig(agentDir), /unsupported.*version/i);
});

test("version 4 validates two distinct model roles and optional suite command", () => {
	assert.throws(
		() =>
			validateConfig({
				version: 4,
				models: {
					writer: {
						model: "provider/model\ncwd: /other",
						reasoningEffort: "high",
					},
					reviewer: { model: "provider/reviewer", reasoningEffort: "medium" },
				},
			}),
		/models.writer/,
	);
	assert.throws(
		() =>
			validateConfig({
				version: 4,
				models: {
					writer: {
						model: "missing-provider-separator",
						reasoningEffort: "high",
					},
					reviewer: { model: "provider/reviewer", reasoningEffort: "medium" },
				},
			}),
		/models.writer/,
	);
	assert.throws(
		() =>
			validateConfig({
				version: 4,
				models: {
					writer: { model: "provider/same", reasoningEffort: "high" },
					reviewer: { model: "provider/same", reasoningEffort: "medium" },
				},
			}),
		/must differ/,
	);
	assert.throws(
		() =>
			validateConfig({
				version: 4,
				models: {
					writer: { model: "provider/writer", reasoningEffort: "high" },
					reviewer: { model: "provider/reviewer", reasoningEffort: "medium" },
				},
				fullSuiteCommand: " ",
			}),
		/cannot be empty/,
	);
});
