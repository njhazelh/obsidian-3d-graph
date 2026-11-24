// Registers a custom element class. A tag name can't be registered twice in a
// window, so when the plugin is turned off and on again, the newly loaded
// class gets a fresh name instead of reusing the old class's (constructing a
// class that isn't registered throws "Illegal constructor"). The elements
// are only made with `new`, never by tag name, so the name doesn't matter.
export const defineElement = (
	name: string,
	element: CustomElementConstructor,
	options?: ElementDefinitionOptions
) => {
	let tag = name;
	for (let n = 2; customElements.get(tag) !== undefined; n++) {
		if (customElements.get(tag) === element) return;
		tag = `${name}-${n}`;
	}
	customElements.define(tag, element, options);
};
