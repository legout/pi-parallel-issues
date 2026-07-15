import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { selectModel, selectReasoningEffort } from "../src/model-selector.ts";

test("TUI model selector is bounded, substring-filterable, and selects the filtered model", async () => {
	const choices = Array.from(
		{ length: 12 },
		(_, index) => `provider/model-${String(index + 1).padStart(2, "0")}`,
	);
	choices[10] = "openai/gpt-5.4";

	let component:
		| {
				render(width: number): string[];
				handleInput(data: string): void;
		  }
		| undefined;
	let renders = 0;
	const ctx = {
		hasUI: true,
		mode: "tui",
		ui: {
			custom: async (
				factory: (
					tui: unknown,
					theme: unknown,
					keybindings: unknown,
					done: (value: string | null) => void,
				) => unknown,
			) =>
				await new Promise<string | null>((resolve) => {
					component = factory(
						{ requestRender: () => renders++ },
						{
							fg: (_color: string, text: string) => text,
							bold: (text: string) => text,
						},
						{
							matches: (data: string, binding: string) =>
								(binding === "tui.select.confirm" && data === "enter") ||
								(binding === "tui.select.cancel" && data === "escape") ||
								(binding === "tui.select.up" && data === "up") ||
								(binding === "tui.select.down" && data === "down") ||
								(binding === "tui.select.pageUp" && data === "pageup") ||
								(binding === "tui.select.pageDown" && data === "pagedown"),
						},
						resolve,
					) as typeof component;
				}),
		},
	} as unknown as ExtensionContext;

	const selection = selectModel(ctx, "Choose a model", choices);
	assert.ok(component);

	const unfiltered = component.render(120).join("\n");
	assert.match(unfiltered, /provider\/model-01/);
	assert.match(unfiltered, /provider\/model-10/);
	assert.doesNotMatch(unfiltered, /openai\/gpt-5\.4/);

	component.handleInput("pageup");
	assert.match(component.render(120).join("\n"), /→ provider\/model-03/);
	component.handleInput("pagedown");
	assert.match(component.render(120).join("\n"), /→ provider\/model-01/);

	for (let index = 0; index < 10; index++) component.handleInput("down");
	assert.match(component.render(120).join("\n"), /→ openai\/gpt-5\.4/);

	for (const character of "gpt") component.handleInput(character);
	const filtered = component.render(120).join("\n");
	assert.match(filtered, /openai\/gpt-5\.4/);
	assert.doesNotMatch(filtered, /provider\/model-01/);
	assert.ok(renders >= 3);

	component.handleInput("enter");
	assert.equal(await selection, "openai/gpt-5.4");
});

test("model selector retains the standard dialog for non-TUI clients", async () => {
	let selectedTitle: string | undefined;
	const ctx = {
		hasUI: true,
		mode: "rpc",
		ui: {
			select: async (title: string) => {
				selectedTitle = title;
				return "provider/model";
			},
		},
	} as unknown as ExtensionContext;

	assert.equal(
		await selectModel(ctx, "Choose a model", ["provider/model"]),
		"provider/model",
	);
	assert.equal(selectedTitle, "Choose a model");
});

test("reasoning effort selector puts the recommended supported effort first", async () => {
	let receivedChoices: string[] | undefined;
	const ctx = {
		hasUI: true,
		mode: "rpc",
		ui: {
			select: async (_title: string, choices: string[]) => {
				receivedChoices = choices;
				return choices[0];
			},
		},
	} as unknown as ExtensionContext;

	assert.equal(
		await selectReasoningEffort(ctx, "Reasoning effort", "high", ["low", "medium", "high"]),
		"high",
	);
	assert.deepEqual(receivedChoices, ["high", "low", "medium"]);
});
