import Node from "./Node";

// A subset of Obsidian's search syntax, enough for graph filters and color groups:
//   tag:#foo  tag:foo     note has the tag (or a nested tag under it)
//   path:foo  file:foo    path / file name contains foo
//   foo  "foo bar"        path or file name contains the text
//   -term                 negates a term
//   a OR b                either side matches
// Terms are ANDed. Searching note contents is not supported.

type Term = { negate: boolean; field: "tag" | "path" | "file" | "any"; value: string };

const tokenize = (query: string): string[] =>
	query.match(/-?(?:\w+:)?(?:"[^"]*"|\S+)/g) ?? [];

const parseTerm = (token: string): Term => {
	let negate = false;
	if (token.startsWith("-")) {
		negate = true;
		token = token.slice(1);
	}
	let field: Term["field"] = "any";
	const m = token.match(/^(tag|path|file):(.*)$/i);
	if (m) {
		field = m[1].toLowerCase() as Term["field"];
		token = m[2];
	}
	let value = token.replace(/^"(.*)"$/, "$1").toLowerCase();
	if (field === "tag") value = value.replace(/^#/, "");
	return { negate, field, value };
};

const termMatches = (term: Term, node: Node): boolean => {
	let hit: boolean;
	switch (term.field) {
		case "tag":
			hit = node.tags.some((tag) => {
				const t = tag.toLowerCase();
				return t === term.value || t.startsWith(term.value + "/");
			});
			break;
		case "path":
			hit = node.path.toLowerCase().includes(term.value);
			break;
		case "file":
			hit = node.name.toLowerCase().includes(term.value);
			break;
		default:
			hit =
				node.path.toLowerCase().includes(term.value) ||
				node.name.toLowerCase().includes(term.value);
	}
	return term.negate ? !hit : hit;
};

export type Matcher = (node: Node) => boolean;

// Compiles a query into a matcher; an empty query matches nothing
export const compileQuery = (query: string): Matcher => {
	const alternatives: Term[][] = [[]];
	tokenize(query.trim()).forEach((token) => {
		if (token === "OR") alternatives.push([]);
		else alternatives[alternatives.length - 1].push(parseTerm(token));
	});
	const groups = alternatives.filter((terms) => terms.length > 0);
	if (groups.length === 0) return () => false;
	return (node) => groups.some((terms) => terms.every((t) => termMatches(t, node)));
};

// Whether the query has any terms at all
export const isEmptyQuery = (query: string) => tokenize(query.trim()).length === 0;
