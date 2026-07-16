import assert from "node:assert/strict";
import test from "node:test";
import { checkRuntimeReadiness } from "../src/doctor.ts";

const config = {
	version: 4 as const,
	models: {
		writer: { model: "provider/writer", reasoningEffort: "high" as const },
		reviewer: {
			model: "provider/reviewer",
			reasoningEffort: "medium" as const,
		},
	},
};

test("doctor accepts the controller runtime and two configured models", () => {
	const result = checkRuntimeReadiness({
		toolNames: ["subagent"],
		availableModels: Object.values(config.models).map(({ model }) => model),
		config,
		checkGitHub: false,
	});
	assert.equal(result.ok, true);
	assert.equal(
		result.lines.some((line) => line.includes("deterministic controller")),
		true,
	);
});

test("doctor reports a missing subagent tool and unavailable reviewer", () => {
	const result = checkRuntimeReadiness({
		toolNames: [],
		availableModels: [config.models.writer.model],
		config,
		checkGitHub: false,
	});
	assert.equal(result.ok, false);
	assert.equal(
		result.lines.some((line) => line.includes("missing subagent")),
		true,
	);
	assert.equal(
		result.lines.some((line) => line.includes("provider/reviewer")),
		true,
	);
});

test("doctor reports unsupported configured reasoning effort", () => {
	const result = checkRuntimeReadiness({
		toolNames: ["subagent"],
		availableModels: Object.values(config.models).map(({ model }) => model),
		availableReasoningEfforts: {
			"provider/writer": ["low", "medium"],
			"provider/reviewer": ["medium"],
		},
		config,
		checkGitHub: false,
	});
	assert.equal(result.ok, false);
	assert.equal(
		result.lines.some((line) => line.includes("writer=provider/writer:high")),
		true,
	);
});
