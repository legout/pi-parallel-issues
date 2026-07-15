import {
	DynamicBorder,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	Container,
	Input,
	SelectList,
	Text,
	type SelectItem,
} from "@earendil-works/pi-tui";
import type { ReasoningEffort } from "./config.ts";

const MAX_VISIBLE_MODELS = 10;

type ModelSelectionContext = Pick<ExtensionContext, "hasUI" | "mode" | "ui">;
type Keybindings = { matches(data: string, binding: string): boolean };
type ModelNavigation = { direction: -1 | 1; distance: number };

function matchesFilter(item: SelectItem, filter: string): boolean {
	return item.label.toLocaleLowerCase().includes(filter.toLocaleLowerCase());
}

function modelNavigation(
	data: string,
	keybindings: Keybindings,
): ModelNavigation | null {
	if (keybindings.matches(data, "tui.select.up"))
		return { direction: -1, distance: 1 };
	if (keybindings.matches(data, "tui.select.down"))
		return { direction: 1, distance: 1 };
	if (keybindings.matches(data, "tui.select.pageUp"))
		return { direction: -1, distance: MAX_VISIBLE_MODELS };
	if (keybindings.matches(data, "tui.select.pageDown"))
		return { direction: 1, distance: MAX_VISIBLE_MODELS };
	return null;
}

function wrapIndex(index: number, length: number): number {
	return ((index % length) + length) % length;
}

/**
 * Select from a bounded, substring-filterable TUI list.
 *
 * The standard dialog remains the fallback for RPC clients, which cannot render
 * custom terminal components.
 */
async function selectChoice(
	ctx: ModelSelectionContext,
	title: string,
	choices: string[],
	filterLabel: string,
): Promise<string | null> {
	if (!ctx.hasUI) return null;
	if (ctx.mode !== "tui") return (await ctx.ui.select(title, choices)) ?? null;

	const items = choices.map((choice) => ({ value: choice, label: choice }));
	return await ctx.ui.custom<string | null>((tui, theme, keybindings, done) => {
		const filterInput = new Input();
		let selectList: SelectList;
		let filteredItems: SelectItem[] = [];
		let selectedIndex = 0;

		const makeSelectList = () => {
			filteredItems = items.filter((item) =>
				matchesFilter(item, filterInput.getValue()),
			);
			selectedIndex = 0;
			selectList = new SelectList(
				filteredItems,
				Math.min(MAX_VISIBLE_MODELS, filteredItems.length),
				{
					selectedPrefix: (text) => theme.fg("accent", text),
					selectedText: (text) => theme.fg("accent", text),
					description: (text) => theme.fg("muted", text),
					scrollInfo: (text) => theme.fg("dim", text),
					noMatch: (text) => theme.fg("warning", text),
				},
			);
		};
		makeSelectList();

		return {
			get focused() {
				return filterInput.focused;
			},
			set focused(value: boolean) {
				filterInput.focused = value;
			},
			render(width: number) {
				const container = new Container();
				container.addChild(
					new DynamicBorder((text: string) => theme.fg("accent", text)),
				);
				container.addChild(
					new Text(theme.fg("accent", theme.bold(title)), 1, 0),
				);
				container.addChild(
					new Text(theme.fg("muted", `Filter ${filterLabel} (substring):`), 1, 0),
				);
				container.addChild(filterInput);
				container.addChild(selectList);
				container.addChild(
					new Text(
						theme.fg(
							"dim",
							"Type to filter • ↑↓ scroll • Enter select • Esc cancel",
						),
						1,
						0,
					),
				);
				container.addChild(
					new DynamicBorder((text: string) => theme.fg("accent", text)),
				);
				return container.render(width);
			},
			invalidate() {
				filterInput.invalidate();
				selectList.invalidate();
			},
			handleInput(data: string) {
				if (keybindings.matches(data, "tui.select.cancel")) {
					done(null);
					return;
				}
				if (keybindings.matches(data, "tui.select.confirm")) {
					done(selectList.getSelectedItem()?.value ?? null);
					return;
				}
				const navigation = modelNavigation(data, keybindings);
				if (navigation) {
					if (filteredItems.length > 0) {
						selectedIndex = wrapIndex(
							selectedIndex + navigation.direction * navigation.distance,
							filteredItems.length,
						);
						selectList.setSelectedIndex(selectedIndex);
					}
					tui.requestRender();
					return;
				}

				filterInput.handleInput(data);
				makeSelectList();
				tui.requestRender();
			},
		};
	});
}

/** Select a model from a bounded, substring-filterable TUI list. */
export function selectModel(
	ctx: ModelSelectionContext,
	title: string,
	choices: string[],
): Promise<string | null> {
	return selectChoice(ctx, title, choices, "models");
}

/** Select a reasoning effort, keeping the recommended value first by default. */
export function selectReasoningEffort(
	ctx: ModelSelectionContext,
	title: string,
	recommended: ReasoningEffort,
	choices: ReasoningEffort[],
): Promise<ReasoningEffort | null> {
	const ordered = [recommended, ...choices.filter((choice) => choice !== recommended)];
	return selectChoice(ctx, title, ordered, "reasoning efforts") as Promise<ReasoningEffort | null>;
}
